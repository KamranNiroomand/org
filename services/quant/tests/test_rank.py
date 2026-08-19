"""rank.py tests.

Three layers: the closed-form forecast pricer checked against its own
internal consistency and against the already-validated risk-neutral
`bsm_price` (they must agree exactly when drift equals the risk-free rate —
that is what makes the risk-neutral price a special case of this one, not an
unrelated formula); the per-underlying ranking mechanics against a synthetic
chain; and the full `rank_day` pipeline against the real local corpus,
skipped gracefully wherever this machine does not have the data a step needs
— the same pattern `test_train.py` already uses, for the same reason.
"""

from __future__ import annotations

import json
import math

import lightgbm as lgb
import polars as pl
import pytest

from app.db import connect
from app.pricing import bsm_price
from app.rank import (
    RankedContract,
    _annualize_horizon_return,
    _interpolate_rate,
    forecast_value,
    latest_model_dir,
    load_model,
    probability_above,
    probability_of_profit,
    rank_day,
    rank_underlying,
)
from app.train import FEATURE_COLS, train

RATE = 0.04
DIV = 0.0
VOL = 0.30
YEARS = 0.25
SPOT = 100.0
STRIKE = 105.0


class TestForecastValue:
    def test_collapses_to_black_scholes_when_drift_equals_rate(self) -> None:
        # The risk-neutral price is the special case of the real-world
        # expectation where the forecast happens to be "no view" — the
        # market's own no-arbitrage drift. If these two formulas ever
        # disagree at that point, one of them has a bug.
        for is_call in (True, False):
            got = forecast_value(SPOT, STRIKE, YEARS, RATE, RATE, DIV, VOL, is_call)
            want = bsm_price(SPOT, STRIKE, YEARS, RATE, DIV, VOL, is_call)
            assert got == pytest.approx(want, rel=1e-9)

    def test_higher_drift_raises_call_value_and_lowers_put_value(self) -> None:
        low = forecast_value(SPOT, STRIKE, YEARS, 0.0, RATE, DIV, VOL, is_call=True)
        high = forecast_value(SPOT, STRIKE, YEARS, 0.5, RATE, DIV, VOL, is_call=True)
        assert high > low

        low_put = forecast_value(SPOT, STRIKE, YEARS, 0.0, RATE, DIV, VOL, is_call=False)
        high_put = forecast_value(SPOT, STRIKE, YEARS, 0.5, RATE, DIV, VOL, is_call=False)
        assert high_put < low_put

    def test_zero_vol_is_deterministic_discounted_intrinsic(self) -> None:
        # At zero vol the terminal price is exactly spot grown at the
        # forecast drift, with no distribution around it.
        drift = 0.10
        terminal = SPOT * math.exp(drift * YEARS)
        want_call = math.exp(-RATE * YEARS) * max(terminal - STRIKE, 0.0)
        got_call = forecast_value(SPOT, STRIKE, YEARS, drift, RATE, DIV, 0.0, is_call=True)
        assert got_call == pytest.approx(want_call, rel=1e-9)

    def test_never_negative(self) -> None:
        # Deep OTM under a strongly adverse drift must floor at zero, not
        # swing negative from a fragile logarithm.
        got = forecast_value(SPOT, 500.0, YEARS, -0.9, RATE, DIV, VOL, is_call=True)
        assert got >= 0.0


class TestProbabilityAbove:
    def test_bounded_zero_to_one(self) -> None:
        for threshold in (1.0, SPOT, 1000.0):
            p = probability_above(SPOT, threshold, YEARS, 0.05, DIV, VOL)
            assert 0.0 <= p <= 1.0

    def test_higher_threshold_is_less_likely(self) -> None:
        near = probability_above(SPOT, SPOT * 1.01, YEARS, 0.0, DIV, VOL)
        far = probability_above(SPOT, SPOT * 2.0, YEARS, 0.0, DIV, VOL)
        assert near > far

    def test_zero_vol_is_a_coin_flip_at_the_forecast_terminal_price(self) -> None:
        terminal = SPOT * math.exp(0.1 * YEARS)
        assert probability_above(SPOT, terminal - 1.0, YEARS, 0.1, DIV, 0.0) == 1.0
        assert probability_above(SPOT, terminal + 1.0, YEARS, 0.1, DIV, 0.0) == 0.0


class TestProbabilityOfProfit:
    def test_call_and_put_breakevens_move_opposite_directions(self) -> None:
        # A call profits above strike + premium; a put profits below
        # strike - premium. Pushing spot up must raise one and lower the
        # other.
        low_spot_call = probability_of_profit(90.0, STRIKE, 2.0, YEARS, 0.0, DIV, VOL, is_call=True)
        high_spot_call = probability_of_profit(120.0, STRIKE, 2.0, YEARS, 0.0, DIV, VOL, is_call=True)
        assert high_spot_call > low_spot_call

        low_spot_put = probability_of_profit(90.0, STRIKE, 2.0, YEARS, 0.0, DIV, VOL, is_call=False)
        high_spot_put = probability_of_profit(120.0, STRIKE, 2.0, YEARS, 0.0, DIV, VOL, is_call=False)
        assert high_spot_put < low_spot_put


class TestInterpolateRate:
    CURVE = [(30, 0.04), (90, 0.045), (365, 0.05)]

    def test_empty_curve_is_none(self) -> None:
        assert _interpolate_rate([], 30) is None

    def test_single_point_curve_is_flat(self) -> None:
        assert _interpolate_rate([(30, 0.04)], 200) == 0.04

    def test_extrapolates_flat_past_either_end(self) -> None:
        assert _interpolate_rate(self.CURVE, 1) == 0.04
        assert _interpolate_rate(self.CURVE, 10_000) == 0.05

    def test_interpolates_linearly_between_two_tenors(self) -> None:
        got = _interpolate_rate(self.CURVE, 60)  # halfway between 30 and 90
        assert got == pytest.approx(0.0425, rel=1e-9)

    def test_exact_tenor_hit(self) -> None:
        assert _interpolate_rate(self.CURVE, 90) == 0.045


class TestAnnualizeHorizonReturn:
    def test_positive_return_annualizes_positive(self) -> None:
        assert _annualize_horizon_return(0.02, horizon_days=5) > 0.0

    def test_zero_return_is_zero_drift(self) -> None:
        assert _annualize_horizon_return(0.0, horizon_days=5) == pytest.approx(0.0, abs=1e-9)

    def test_does_not_raise_on_a_total_loss_prediction(self) -> None:
        # log(1 + (-1.5)) is a domain error; this must clamp, not crash a
        # whole ranking run over one absurd prediction.
        drift = _annualize_horizon_return(-1.5, horizon_days=5)
        assert math.isfinite(drift)
        assert drift < 0.0


def _quote_row(**overrides: object) -> dict:
    row = {
        "occ_symbol": "TEST  260101C00100000",
        "underlying": "TEST",
        "expiry": "2026-01-01",
        "type": "call",
        "strike": 100.0,
        "bid": None,
        "ask": None,
        "mid": None,
        "close": 5.0,
        "price": 5.0,
        "volume": 100,
        "open_interest": 500,
        "underlying_price": 100.0,
        "iv": 0.30,
        "delta": 0.5,
        "gamma": 0.02,
        "vega": 0.15,
        "theta": -0.03,
        "liquid": True,
    }
    row.update(overrides)
    return row


def _quotes_frame(rows: list[dict]) -> pl.DataFrame:
    return pl.DataFrame(rows)


class TestRankUnderlying:
    def test_skips_rows_with_no_solved_iv(self) -> None:
        quotes = _quotes_frame([_quote_row(iv=None, price=None)])
        ranked = rank_underlying(quotes, "2025-12-01", 0.05, 0.30, [(365, 0.04)])
        assert ranked == []

    def test_skips_contracts_expiring_on_or_before_the_trading_day(self) -> None:
        quotes = _quotes_frame([_quote_row(expiry="2025-12-01")])
        ranked = rank_underlying(quotes, "2025-12-01", 0.05, 0.30, [(365, 0.04)])
        assert ranked == []

    def test_underpriced_contract_gets_positive_expected_value(self) -> None:
        # forecast_vol far above market IV, with everything else held fixed,
        # must make the option look cheap relative to the forecast.
        quotes = _quotes_frame([_quote_row(price=1.0, iv=0.10)])
        ranked = rank_underlying(quotes, "2025-12-01", 0.0, 0.80, [(365, 0.04)], round_trip_cost=0.0)
        assert len(ranked) == 1
        assert ranked[0].ev > 0.0
        assert ranked[0].ev_per_risk == pytest.approx(ranked[0].ev / (1.0 * 100), rel=1e-9)

    def test_overpriced_contract_gets_negative_expected_value(self) -> None:
        quotes = _quotes_frame([_quote_row(price=20.0, iv=0.80)])
        ranked = rank_underlying(quotes, "2025-12-01", 0.0, 0.10, [(365, 0.04)], round_trip_cost=0.0)
        assert len(ranked) == 1
        assert ranked[0].ev < 0.0

    def test_round_trip_cost_reduces_every_contracts_expected_value(self) -> None:
        quotes = _quotes_frame([_quote_row()])
        free = rank_underlying(quotes, "2025-12-01", 0.05, 0.30, [(365, 0.04)], round_trip_cost=0.0)
        costly = rank_underlying(quotes, "2025-12-01", 0.05, 0.30, [(365, 0.04)], round_trip_cost=1.30)
        assert costly[0].ev == pytest.approx(free[0].ev - 1.30, rel=1e-9)

    def test_no_rate_curve_skips_the_contract_rather_than_guessing(self) -> None:
        quotes = _quotes_frame([_quote_row()])
        ranked = rank_underlying(quotes, "2025-12-01", 0.05, 0.30, [])
        assert ranked == []

    def test_result_fields_are_well_typed(self) -> None:
        quotes = _quotes_frame([_quote_row()])
        ranked = rank_underlying(quotes, "2025-12-01", 0.05, 0.30, [(365, 0.04)])
        assert len(ranked) == 1
        c = ranked[0]
        assert isinstance(c, RankedContract)
        assert c.dte > 0
        assert 0.0 <= c.prob_profit <= 1.0


def _write_fake_model(run_dir, beats_baseline: bool) -> None:
    run_dir.mkdir(parents=True, exist_ok=True)
    booster = lgb.LGBMRegressor(n_estimators=5, max_depth=2, verbosity=-1)
    import numpy as np

    X = np.random.default_rng(0).normal(size=(50, len(FEATURE_COLS)))
    y = np.random.default_rng(1).normal(size=50)
    booster.fit(X, y)
    booster.booster_.save_model(str(run_dir / "model.txt"))
    (run_dir / "features.json").write_text(json.dumps({"feature_cols": FEATURE_COLS}))
    (run_dir / "manifest.json").write_text(
        json.dumps(
            {
                "run_id": run_dir.name,
                "target": "dir",
                "horizon": 5,
                "metrics": {
                    "beats_baseline": beats_baseline,
                    "model_rmse": 0.05,
                    "baseline_rmse": 0.04,
                    "information_coefficient": -0.01,
                },
            }
        )
    )


class TestLoadModelAndLatestModelDir:
    def test_load_model_merges_manifest_and_feature_cols(self, tmp_path) -> None:
        run_dir = tmp_path / "2020-01-01-dir-h5-abc123"
        _write_fake_model(run_dir, beats_baseline=True)
        _booster, manifest = load_model(run_dir)
        assert manifest["run_id"] == run_dir.name
        assert manifest["feature_cols"] == FEATURE_COLS

    def test_latest_model_dir_picks_the_lexicographically_last_run_id(self, tmp_path) -> None:
        _write_fake_model(tmp_path / "2020-01-01-dir-h5-aaa", beats_baseline=True)
        _write_fake_model(tmp_path / "2025-06-01-dir-h5-bbb", beats_baseline=True)
        got = latest_model_dir(tmp_path)
        assert got.name == "2025-06-01-dir-h5-bbb"

    def test_raises_when_no_models_exist(self, tmp_path) -> None:
        with pytest.raises(SystemExit, match="No trained models"):
            latest_model_dir(tmp_path / "empty")


class TestRankDayRefusesWeakModels:
    def test_refuses_a_model_that_does_not_beat_baseline(self, tmp_path) -> None:
        run_dir = tmp_path / "weak"
        _write_fake_model(run_dir, beats_baseline=False)
        with pytest.raises(SystemExit, match="does not beat"):
            rank_day("2026-01-01", run_dir)

    def test_force_bypasses_the_gate(self, tmp_path, monkeypatch) -> None:
        run_dir = tmp_path / "weak"
        _write_fake_model(run_dir, beats_baseline=False)

        # The gate must be the *first* thing checked — force=True should get
        # past it and fail for a completely different, later reason (no
        # bars), which is what proves the gate itself was skipped rather
        # than coincidentally not triggering.
        monkeypatch.setattr("app.rank.read_bars", lambda: pl.DataFrame())
        with pytest.raises(SystemExit, match="No bars"):
            rank_day("2026-01-01", run_dir, force=True)


def _latest_priced_liquid_day() -> str | None:
    with connect() as conn:
        row = conn.execute(
            "SELECT MAX(trading_day) AS day FROM option_quotes WHERE liquid = 1 AND iv_bps IS NOT NULL"
        ).fetchone()
    return row["day"] if row and row["day"] else None


class TestRankDayEndToEnd:
    def test_produces_a_sane_ranked_list_against_the_real_corpus(self, tmp_path) -> None:
        from app.db import read_bars

        if read_bars().height == 0:
            pytest.skip("no bars in market.db yet — run bars:backfill first")
        day = _latest_priced_liquid_day()
        if day is None:
            pytest.skip("no liquid, priced option quotes captured yet")

        # A quick, throwaway model — this test proves the pipeline's
        # mechanics, not this particular model's skill, so `force=True` is
        # used deliberately rather than depending on whether a 3-fold
        # smoke-test model happens to beat baseline this run.
        run_dir = train(target="dir", horizon=5, n_splits=3, embargo=2, output_dir=tmp_path)

        ranked = rank_day(day, run_dir, top=10, force=True)

        for c in ranked:
            assert isinstance(c, RankedContract)
            assert c.dte > 0
            assert c.market_price > 0
            assert 0.0 <= c.prob_profit <= 1.0
            assert math.isfinite(c.ev)
        # Sorted descending by expected value.
        evs = [c.ev for c in ranked]
        assert evs == sorted(evs, reverse=True)
