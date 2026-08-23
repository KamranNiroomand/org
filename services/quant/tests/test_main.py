"""API tests. The contract these pin is that a refusal survives the wire.

An unidentifiable implied vol must arrive at the caller as null with a reason,
not as a zero, not as an error, and not as a plausible-looking number. Every
guarantee in `pricing.py` is worthless if serialization quietly launders it.
"""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

import lightgbm as lgb
import numpy as np
from fastapi.testclient import TestClient

from app.main import app
from app.rank import RankedContract
from app.train import FEATURE_COLS

client = TestClient(app)

FIXTURES = Path(__file__).resolve().parents[3] / "fixtures" / "options"
NVDA = json.loads((FIXTURES / "nvda-chain.json").read_text())
YEARS_2D = 2 / 365


def test_health() -> None:
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["ok"] is True


def test_classify_universe_excludes_a_warrant_but_not_a_coincidental_collision() -> None:
    r = client.post(
        "/classify-universe",
        json={
            "symbols": [
                {"symbol": "AACI", "name": "Armada Acquisition Corp. III Class A"},
                {"symbol": "AACIW", "name": "Armada Acquisition Corp. III"},
                {"symbol": "TK", "name": "Teekay Corporation Ltd."},
                {"symbol": "TKR", "name": "Timken Company (The)"},
            ]
        },
    )
    assert r.status_code == 200
    assert r.json()["excluded"] == {"AACIW": "warrant"}


def test_prices_a_real_chain() -> None:
    rows = [
        {
            "key": f"K{row['strike']}",
            "price": (row["bid"] + row["ask"]) / 2,
            "spot": NVDA["spot"],
            "strike": row["strike"],
            "years": YEARS_2D,
            "rate": NVDA["assumedRate"],
            "div_yield": NVDA["assumedDividendYield"],
            "is_call": True,
        }
        for row in NVDA["rows"]
    ]
    r = client.post("/price", json={"rows": rows})
    assert r.status_code == 200

    results = {x["key"]: x for x in r.json()["results"]}
    assert len(results) == len(NVDA["rows"])

    for row in NVDA["rows"]:
        got = results[f"K{row['strike']}"]
        assert got["iv_bps"] is not None
        # Within 200 basis points of the broker's published vol.
        assert abs(got["iv_bps"] - round(row["iv"] * 10_000)) < 200
        assert got["delta"] == abs(got["delta"])  # calls have positive delta


def test_refusal_survives_serialization() -> None:
    """The $390 penny row must come back null, not zero and not 435%."""
    r = client.post(
        "/price",
        json={
            "rows": [
                {
                    "key": "penny",
                    "price": 0.005,
                    "spot": 225.05,
                    "strike": 390.0,
                    "years": YEARS_2D,
                    "rate": 0.0425,
                    "is_call": True,
                }
            ]
        },
    )
    got = r.json()["results"][0]
    assert got["iv_bps"] is None
    assert got["delta"] is None
    assert got["skipped"] == "unidentified-vol"


def test_overflow_skips_the_row_instead_of_failing_the_batch() -> None:
    """A deep OTM American put at zero dividend yield sends the Brent search
    near the vol floor, where the Bjerksund-Stensland beta term overflows —
    real production data, not a contrived input. One degenerate contract must
    come back skipped, not take every other row in the same request down
    with it (previously an unhandled OverflowError 500'd the whole batch).
    """
    r = client.post(
        "/price",
        json={
            "rows": [
                {
                    "key": "good",
                    "price": (NVDA["rows"][0]["bid"] + NVDA["rows"][0]["ask"]) / 2,
                    "spot": NVDA["spot"],
                    "strike": NVDA["rows"][0]["strike"],
                    "years": YEARS_2D,
                    "rate": NVDA["assumedRate"],
                    "div_yield": NVDA["assumedDividendYield"],
                    "is_call": True,
                },
                {
                    "key": "overflow-put",
                    "price": 0.01,
                    "spot": 227.5,
                    "strike": 100.0,
                    "years": 0.25,
                    "rate": 0.04,
                    "div_yield": 0.0,
                    "is_call": False,
                },
            ]
        },
    )
    assert r.status_code == 200
    results = {x["key"]: x for x in r.json()["results"]}

    assert results["overflow-put"]["skipped"] == "pricing-overflow"
    assert results["overflow-put"]["iv_bps"] is None

    # The other row in the same batch must still have priced normally.
    assert results["good"]["iv_bps"] is not None
    assert results["good"]["skipped"] is None


def test_theoretical_round_trips_against_the_solver() -> None:
    body = {
        "spot": 225.05,
        "strike": 227.5,
        "years": 0.25,
        "rate": 0.0425,
        "div_yield": 0.0,
        "vol": 0.32,
        "is_call": True,
    }
    priced = client.post("/theoretical", json=body).json()
    back = client.post(
        "/price",
        json={
            "rows": [
                {
                    "key": "rt",
                    "price": priced["price"],
                    **{k: v for k, v in body.items() if k != "vol"},
                }
            ]
        },
    ).json()["results"][0]
    assert back["iv_bps"] == 3200


def _write_fake_model(run_dir: Path, beats_baseline: bool) -> None:
    """A real, tiny, trained booster — `load_model` runs unmocked in the
    /rank handler before rank_day is ever reached, so this needs to be a
    file LightGBM will actually load, not a placeholder.
    """
    run_dir.mkdir(parents=True, exist_ok=True)
    booster = lgb.LGBMRegressor(n_estimators=5, max_depth=2, verbosity=-1)
    booster.fit(
        np.random.default_rng(0).normal(size=(50, len(FEATURE_COLS))),
        np.random.default_rng(1).normal(size=50),
    )
    booster.booster_.save_model(str(run_dir / "model.txt"))
    (run_dir / "features.json").write_text(json.dumps({"feature_cols": FEATURE_COLS}))
    (run_dir / "manifest.json").write_text(
        json.dumps(
            {
                "run_id": run_dir.name,
                "metrics": {
                    "beats_baseline": beats_baseline,
                    "model_rmse": 0.05,
                    "baseline_rmse": 0.04,
                    "information_coefficient": -0.01,
                },
            }
        )
    )


_FAKE_CONTRACT = RankedContract(
    occ_symbol="AAPL260116C00150000",
    underlying="AAPL",
    expiry="2026-01-16",
    type="call",
    strike=150.0,
    dte=30,
    market_price=5.0,
    market_iv=0.30,
    forecast_vol=0.28,
    forecast_drift=0.05,
    forecast_value=5.5,
    ev=0.5,
    ev_per_risk=0.1,
    prob_profit=0.55,
)


class TestRank:
    """The gate a bad model would otherwise hide behind must survive the wire
    too — see rank.py's own module docstring on why this is the one place a
    metric that says "no edge" must not quietly become a recommendation.
    """

    def test_no_trained_model_is_a_409_not_a_crash(self, tmp_path, monkeypatch) -> None:
        def _raise():
            raise SystemExit(f"No trained models found under {tmp_path / 'empty'}")

        monkeypatch.setattr("app.main.latest_model_dir", _raise)
        r = client.post("/rank", json={"day": "2026-01-01"})
        assert r.status_code == 409
        assert "No trained models" in r.json()["detail"]

    def test_refuses_a_model_that_does_not_beat_baseline_without_force(self, tmp_path, monkeypatch) -> None:
        run_dir = tmp_path / "weak"
        _write_fake_model(run_dir, beats_baseline=False)
        monkeypatch.setattr("app.main.latest_model_dir", lambda: run_dir)

        def _refuse(*args, **kwargs):
            raise SystemExit("does not beat the mean baseline")

        monkeypatch.setattr("app.main.rank_day", _refuse)
        r = client.post("/rank", json={"day": "2026-01-01", "force": False})
        assert r.status_code == 409
        assert "does not beat" in r.json()["detail"]

    def test_returns_ranked_contracts_with_the_models_own_metrics_attached(self, tmp_path, monkeypatch) -> None:
        run_dir = tmp_path / "weak"
        _write_fake_model(run_dir, beats_baseline=False)
        monkeypatch.setattr("app.main.latest_model_dir", lambda: run_dir)
        monkeypatch.setattr("app.main.rank_day", lambda *a, **k: [_FAKE_CONTRACT])

        r = client.post("/rank", json={"day": "2026-01-01", "top": 10, "force": True})
        assert r.status_code == 200
        body = r.json()

        # The caveat must be visible in the payload itself — a UI reading
        # only `contracts` and never this field is exactly the mistake the
        # whole harness exists to prevent.
        assert body["model_beats_baseline"] is False
        assert body["model_information_coefficient"] == -0.01
        assert body["model_run_id"] == "weak"

        assert len(body["contracts"]) == 1
        c = body["contracts"][0]
        assert c["occ_symbol"] == "AAPL260116C00150000"
        assert c["ev"] == 0.5
        assert c["prob_profit"] == 0.55

    def test_force_defaults_to_true_so_the_ui_always_gets_a_response(self, tmp_path, monkeypatch) -> None:
        run_dir = tmp_path / "weak"
        _write_fake_model(run_dir, beats_baseline=False)
        monkeypatch.setattr("app.main.latest_model_dir", lambda: run_dir)

        seen_force = {}

        def _capture(day, model_dir, top=25, force=False, max_capital=None):
            seen_force["force"] = force
            return []

        monkeypatch.setattr("app.main.rank_day", _capture)
        r = client.post("/rank", json={"day": "2026-01-01"})
        assert r.status_code == 200
        assert seen_force["force"] is True

    def test_max_capital_reaches_rank_day_unchanged(self, tmp_path, monkeypatch) -> None:
        run_dir = tmp_path / "weak"
        _write_fake_model(run_dir, beats_baseline=False)
        monkeypatch.setattr("app.main.latest_model_dir", lambda: run_dir)

        seen = {}

        def _capture(day, model_dir, top=25, force=False, max_capital=None):
            seen["max_capital"] = max_capital
            return []

        monkeypatch.setattr("app.main.rank_day", _capture)
        r = client.post("/rank", json={"day": "2026-01-01", "max_capital": 200})
        assert r.status_code == 200
        assert seen["max_capital"] == 200.0

    def test_max_capital_defaults_to_none(self, tmp_path, monkeypatch) -> None:
        run_dir = tmp_path / "weak"
        _write_fake_model(run_dir, beats_baseline=False)
        monkeypatch.setattr("app.main.latest_model_dir", lambda: run_dir)

        seen = {}

        def _capture(day, model_dir, top=25, force=False, max_capital=None):
            seen["max_capital"] = max_capital
            return []

        monkeypatch.setattr("app.main.rank_day", _capture)
        r = client.post("/rank", json={"day": "2026-01-01"})
        assert r.status_code == 200
        assert seen["max_capital"] is None

    def test_max_capital_must_be_positive(self, tmp_path, monkeypatch) -> None:
        monkeypatch.setattr("app.main.latest_model_dir", lambda: tmp_path / "unused")
        r = client.post("/rank", json={"day": "2026-01-01", "max_capital": 0})
        assert r.status_code == 422


class TestPositionHealth:
    """A position monitor, not a fresh entry screen — see
    score_held_contracts's own docstring for what makes it different from
    /rank called again.
    """

    def test_no_trained_model_is_a_409_not_a_crash(self, tmp_path, monkeypatch) -> None:
        def _raise():
            raise SystemExit(f"No trained models found under {tmp_path / 'empty'}")

        monkeypatch.setattr("app.main.latest_model_dir", _raise)
        r = client.post(
            "/position-health",
            json={"day": "2026-01-01", "contracts": [{"occ_symbol": "X", "underlying": "X"}]},
        )
        assert r.status_code == 409
        assert "No trained models" in r.json()["detail"]

    def test_returns_scored_and_unscored_contracts_together(self, tmp_path, monkeypatch) -> None:
        run_dir = tmp_path / "weak"
        _write_fake_model(run_dir, beats_baseline=False)
        monkeypatch.setattr("app.main.latest_model_dir", lambda: run_dir)
        monkeypatch.setattr(
            "app.main.score_held_contracts",
            lambda contracts, day, model_dir, force=False: {"good": _FAKE_CONTRACT, "gone": None},
        )

        r = client.post(
            "/position-health",
            json={
                "day": "2026-01-01",
                "contracts": [
                    {"occ_symbol": "good", "underlying": "AAPL"},
                    {"occ_symbol": "gone", "underlying": "AAPL"},
                ],
            },
        )
        assert r.status_code == 200
        body = r.json()
        assert body["model_beats_baseline"] is False
        assert body["contracts"]["good"]["ev"] == 0.5
        # A null value must survive the wire, never dropped or coerced —
        # it's the caller's signal that this position needs a look, not
        # that everything about it is fine.
        assert body["contracts"]["gone"] is None

    def test_force_defaults_to_true(self, tmp_path, monkeypatch) -> None:
        run_dir = tmp_path / "weak"
        _write_fake_model(run_dir, beats_baseline=False)
        monkeypatch.setattr("app.main.latest_model_dir", lambda: run_dir)

        seen = {}

        def _capture(contracts, day, model_dir, force=False):
            seen["force"] = force
            return {}

        monkeypatch.setattr("app.main.score_held_contracts", _capture)
        r = client.post(
            "/position-health",
            json={"day": "2026-01-01", "contracts": [{"occ_symbol": "X", "underlying": "X"}]},
        )
        assert r.status_code == 200
        assert seen["force"] is True


def _write_model_with_horizon(run_dir: Path, horizon: int = 5) -> None:
    """`_write_fake_model`'s manifest has no `horizon`; /select-entries
    needs one to compute exit plans, so add it."""
    _write_fake_model(run_dir, beats_baseline=False)
    manifest_path = run_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["horizon"] = horizon
    manifest_path.write_text(json.dumps(manifest))


_SELECT_BODY = {
    "day": "2026-01-01",
    "available_capital": 100_000.0,
    "max_concurrent_positions": 10,
    "max_new_positions": 5,
    "min_ev_per_risk": 0.05,
    "min_prob_profit": 0.5,
}


class TestSelectEntries:
    """The endpoint wrapper around `select_entries` — in particular the
    exit-plan filter, which moved here out of autoEntry.ts and must not be
    allowed to regress into opening positions the exit engine can never
    see again.
    """

    def test_selects_a_plannable_candidate(self, tmp_path, monkeypatch) -> None:
        run_dir = tmp_path / "ok"
        _write_model_with_horizon(run_dir)
        monkeypatch.setattr("app.main.latest_model_dir", lambda: run_dir)
        monkeypatch.setattr("app.main.rank_day", lambda *a, **k: [_FAKE_CONTRACT])

        r = client.post("/select-entries", json=_SELECT_BODY)
        assert r.status_code == 200
        body = r.json()
        assert [c["occ_symbol"] for c in body["selected"]] == [_FAKE_CONTRACT.occ_symbol]
        # A selected contract always carries a full exit plan — that is the
        # invariant autoEntry.ts relies on when it persists targets.
        picked = body["selected"][0]
        assert picked["suggested_target_exit_price"] is not None
        assert picked["suggested_stop_loss_price"] is not None
        assert picked["suggested_target_exit_date"] is not None

    def test_excludes_a_candidate_whose_exit_plan_cannot_be_computed(self, tmp_path, monkeypatch) -> None:
        # Expiry two days out against exit.py's 3-day floor: no target date
        # exists that both exists and clears the floor, so this contract
        # must never be selected — opening it would strand an unmanaged
        # position.
        too_short = replace(_FAKE_CONTRACT, expiry="2026-01-03", dte=2)
        run_dir = tmp_path / "short"
        _write_model_with_horizon(run_dir)
        monkeypatch.setattr("app.main.latest_model_dir", lambda: run_dir)
        monkeypatch.setattr("app.main.rank_day", lambda *a, **k: [too_short])

        r = client.post("/select-entries", json=_SELECT_BODY)
        assert r.status_code == 200
        assert r.json()["selected"] == []

    def test_an_unplannable_candidate_does_not_consume_a_selection_slot(self, tmp_path, monkeypatch) -> None:
        too_short = replace(_FAKE_CONTRACT, expiry="2026-01-03", dte=2, ev=999.0)
        good = replace(_FAKE_CONTRACT, occ_symbol="MSFT260116C00150000", underlying="MSFT")
        run_dir = tmp_path / "mixed"
        _write_model_with_horizon(run_dir)
        monkeypatch.setattr("app.main.latest_model_dir", lambda: run_dir)
        monkeypatch.setattr("app.main.rank_day", lambda *a, **k: [too_short, good])

        # One slot, and the highest-EV candidate is the unplannable one:
        # it must be dropped before allocation, not silently eat the slot.
        r = client.post("/select-entries", json={**_SELECT_BODY, "max_new_positions": 1})
        assert r.status_code == 200
        assert [c["occ_symbol"] for c in r.json()["selected"]] == ["MSFT260116C00150000"]

    def test_a_manifest_without_a_horizon_refuses_loudly(self, tmp_path, monkeypatch) -> None:
        # Without a horizon no exit plan is computable for anything, so
        # every candidate would be filtered out and the caller would report
        # "nothing cleared the bar today" — blaming the market for a broken
        # model artifact. Must be a 409 instead.
        run_dir = tmp_path / "nohorizon"
        _write_fake_model(run_dir, beats_baseline=False)  # no horizon key
        monkeypatch.setattr("app.main.latest_model_dir", lambda: run_dir)
        monkeypatch.setattr("app.main.rank_day", lambda *a, **k: [_FAKE_CONTRACT])

        r = client.post("/select-entries", json=_SELECT_BODY)
        assert r.status_code == 409
        assert "horizon" in r.json()["detail"]

    def test_held_underlyings_are_never_selected(self, tmp_path, monkeypatch) -> None:
        run_dir = tmp_path / "held"
        _write_model_with_horizon(run_dir)
        monkeypatch.setattr("app.main.latest_model_dir", lambda: run_dir)
        monkeypatch.setattr("app.main.rank_day", lambda *a, **k: [_FAKE_CONTRACT])

        r = client.post("/select-entries", json={**_SELECT_BODY, "held_underlyings": ["AAPL"]})
        assert r.status_code == 200
        assert r.json()["selected"] == []
