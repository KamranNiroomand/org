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
import os
from pathlib import Path

import lightgbm as lgb
import polars as pl
import pytest

from app.db import reading
from app.pricing import bsm_price
from app.rank import (
    MAX_ANNUALIZED_DRIFT,
    RankedContract,
    _annualize_horizon_return,
    _interpolate_rate,
    _vol_forecast_ratio,
    forecast_value,
    latest_model_dir,
    load_model,
    probability_above,
    probability_of_profit,
    rank_day,
    rank_underlying,
    resolve_model,
    score_held_contracts,
    select_entries,
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
        assert _annualize_horizon_return(0.001, horizon_days=5) > 0.0

    def test_zero_return_is_zero_drift(self) -> None:
        assert _annualize_horizon_return(0.0, horizon_days=5) == pytest.approx(0.0, abs=1e-9)

    def test_does_not_raise_on_a_total_loss_prediction(self) -> None:
        # log(1 + (-1.5)) is a domain error; this must clamp, not crash a
        # whole ranking run over one absurd prediction. Also lands well
        # past the abs-drift cap, so this doubles as that cap's floor case.
        drift = _annualize_horizon_return(-1.5, horizon_days=5)
        assert math.isfinite(drift)
        assert drift == pytest.approx(-1.0, abs=1e-9)

    def test_an_ordinary_short_horizon_prediction_is_capped_once_extrapolated(self) -> None:
        # Found live: BRK.B's real raw 5-day prediction — +4.85%, nothing
        # alarming about that number on its own — annualizes to 239% once
        # extrapolated to a 59-day contract, and drove one underlying to
        # an implied 100% probability of profit. Same input, capped.
        uncapped = math.log(1.0485) / (5 / 252)
        assert uncapped > 2.0  # confirms the naive extrapolation really is this extreme
        capped = _annualize_horizon_return(0.0485, horizon_days=5)
        assert capped == pytest.approx(1.0, abs=1e-9)

    def test_a_genuinely_moderate_prediction_passes_through_uncapped(self) -> None:
        # The whole point of capping only the extreme case: a real,
        # moderate short-horizon prediction must reach rank_underlying
        # unmodified.
        got = _annualize_horizon_return(0.001, horizon_days=5)
        want = math.log(1.001) / (5 / 252)
        assert got == pytest.approx(want, rel=1e-9)
        assert abs(got) < 1.0


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
    """`vol_ratio` is multiplied against each row's own `iv` to get that
    contract's forecast vol — see `_vol_forecast_ratio`'s docstring for why
    it is a ratio rather than a single flat number reused across a chain.
    """

    def test_skips_rows_with_no_solved_iv(self) -> None:
        quotes = _quotes_frame([_quote_row(iv=None, price=None)])
        ranked = rank_underlying(quotes, "2025-12-01", 0.05, 1.0, [(365, 0.04)])
        assert ranked == []

    def test_skips_contracts_expiring_on_or_before_the_trading_day(self) -> None:
        quotes = _quotes_frame([_quote_row(expiry="2025-12-01")])
        ranked = rank_underlying(quotes, "2025-12-01", 0.05, 1.0, [(365, 0.04)])
        assert ranked == []

    def test_underpriced_contract_gets_positive_expected_value(self) -> None:
        # forecast_vol (row iv * ratio) far above market IV, with
        # everything else held fixed, must make the option look cheap
        # relative to the forecast.
        quotes = _quotes_frame([_quote_row(price=1.0, iv=0.10)])
        ranked = rank_underlying(quotes, "2025-12-01", 0.0, 8.0, [(365, 0.04)], round_trip_cost=0.0)
        assert len(ranked) == 1
        assert ranked[0].forecast_vol == pytest.approx(0.80, rel=1e-9)
        assert ranked[0].ev > 0.0
        assert ranked[0].ev_per_risk == pytest.approx(ranked[0].ev / (1.0 * 100), rel=1e-9)

    def test_overpriced_contract_gets_negative_expected_value(self) -> None:
        quotes = _quotes_frame([_quote_row(price=20.0, iv=0.80)])
        ranked = rank_underlying(quotes, "2025-12-01", 0.0, 0.125, [(365, 0.04)], round_trip_cost=0.0)
        assert len(ranked) == 1
        assert ranked[0].forecast_vol == pytest.approx(0.10, rel=1e-9)
        assert ranked[0].ev < 0.0

    def test_two_contracts_on_the_same_chain_get_different_forecast_vols(self) -> None:
        # The whole point of the ratio design: two strikes with different
        # market IVs (a real skew) must not collapse to one flat forecast.
        quotes = _quotes_frame([
            _quote_row(occ_symbol="A", strike=90.0, iv=0.20),
            _quote_row(occ_symbol="B", strike=110.0, iv=0.40),
        ])
        ranked = rank_underlying(quotes, "2025-12-01", 0.0, 1.5, [(365, 0.04)])
        by_symbol = {c.occ_symbol: c for c in ranked}
        assert by_symbol["A"].forecast_vol == pytest.approx(0.20 * 1.5, rel=1e-9)
        assert by_symbol["B"].forecast_vol == pytest.approx(0.40 * 1.5, rel=1e-9)

    def test_round_trip_cost_reduces_every_contracts_expected_value(self) -> None:
        quotes = _quotes_frame([_quote_row()])
        free = rank_underlying(quotes, "2025-12-01", 0.05, 1.0, [(365, 0.04)], round_trip_cost=0.0)
        costly = rank_underlying(quotes, "2025-12-01", 0.05, 1.0, [(365, 0.04)], round_trip_cost=1.30)
        assert costly[0].ev == pytest.approx(free[0].ev - 1.30, rel=1e-9)

    def test_no_rate_curve_skips_the_contract_rather_than_guessing(self) -> None:
        quotes = _quotes_frame([_quote_row()])
        ranked = rank_underlying(quotes, "2025-12-01", 0.05, 1.0, [])
        assert ranked == []

    def test_result_fields_are_well_typed(self) -> None:
        quotes = _quotes_frame([_quote_row()])
        ranked = rank_underlying(quotes, "2025-12-01", 0.05, 1.0, [(365, 0.04)])
        assert len(ranked) == 1
        c = ranked[0]
        assert isinstance(c, RankedContract)
        assert c.dte > 0
        assert 0.0 <= c.prob_profit <= 1.0

    def test_max_capital_drops_a_contract_costing_more_than_the_cap(self) -> None:
        # price=5.0 * the default 100 multiplier = $500 to buy one contract.
        quotes = _quotes_frame([_quote_row(price=5.0)])
        ranked = rank_underlying(quotes, "2025-12-01", 0.05, 1.0, [(365, 0.04)], max_capital=400.0)
        assert ranked == []

    def test_max_capital_keeps_a_contract_at_or_under_the_cap(self) -> None:
        quotes = _quotes_frame([_quote_row(price=2.0)])  # $200 to buy one contract
        ranked = rank_underlying(quotes, "2025-12-01", 0.05, 1.0, [(365, 0.04)], max_capital=200.0)
        assert len(ranked) == 1

    def test_max_capital_none_never_drops_anything(self) -> None:
        quotes = _quotes_frame([_quote_row(price=500.0)])
        ranked = rank_underlying(quotes, "2025-12-01", 0.05, 1.0, [(365, 0.04)], max_capital=None)
        assert len(ranked) == 1


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


class TestVolForecastRatio:
    def test_the_sndk_case_gets_capped_not_trusted_unbounded(self) -> None:
        # Real numbers from the live incident: 21-day realized vol ~140%
        # against a median IV of ~46% across the (mistakenly narrow) slice
        # of the chain first checked. Left uncapped, the resulting ratio
        # drove a single underlying to dominate the entire ranked board.
        quotes = _quotes_frame([_quote_row(iv=0.4555), _quote_row(iv=0.45)])
        ratio = _vol_forecast_ratio(1.3964, quotes, max_ratio=2.0)
        assert ratio == pytest.approx(2.0, rel=1e-9)

    def test_a_moderate_vol_premium_signal_passes_through_uncapped(self) -> None:
        # The whole point of capping only the extreme case: a realistic,
        # moderate divergence between trailing RV and market IV — the kind
        # of gap the system is actually meant to find — must not be
        # touched.
        quotes = _quotes_frame([_quote_row(iv=0.30), _quote_row(iv=0.32)])
        ratio = _vol_forecast_ratio(0.45, quotes, max_ratio=2.0)
        median_iv = (0.30 + 0.32) / 2
        assert ratio == pytest.approx(0.45 / median_iv, rel=1e-9)

    def test_uses_the_median_across_the_whole_chain_not_one_contract(self) -> None:
        quotes = _quotes_frame([_quote_row(iv=0.20), _quote_row(iv=0.30), _quote_row(iv=10.0)])
        # median of (0.20, 0.30, 10.0) is 0.30, not skewed by the one
        # outlier the way a mean would be.
        ratio = _vol_forecast_ratio(0.30, quotes, max_ratio=2.0)
        assert ratio == pytest.approx(1.0, rel=1e-9)

    def test_no_priced_quotes_falls_back_to_a_neutral_ratio(self) -> None:
        quotes = _quotes_frame([_quote_row(iv=None)])
        assert _vol_forecast_ratio(1.5, quotes) == 1.0

    def test_empty_chain_falls_back_to_a_neutral_ratio(self) -> None:
        # .clear() keeps the schema (unlike an empty list, which polars
        # cannot infer columns from) while dropping every row.
        quotes = _quotes_frame([_quote_row(iv=None)]).clear()
        assert _vol_forecast_ratio(1.5, quotes) == 1.0


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
    with reading() as conn:
        row = conn.execute(
            "SELECT MAX(trading_day) AS day FROM option_quotes WHERE liquid = 1 AND iv_bps IS NOT NULL"
        ).fetchone()
    return row["day"] if row and row["day"] else None


class TestRankDayDteBand:
    """`rank_day` applies the maturity band before its top-N cut, and the
    ordering is the whole point — see the docstring for why filtering
    afterwards can leave nothing in band at all.
    """

    def _patch_pipeline(self, monkeypatch, contracts) -> None:
        monkeypatch.setattr(
            "app.rank._forecast_inputs",
            lambda *a, **k: ({"TEST": 0.05}, {"TEST": 0.3}, [(30, 0.04)], {"horizon": 5}),
        )
        monkeypatch.setattr("app.rank.read_quotes", lambda *a, **k: pl.DataFrame({"x": [1]}))
        monkeypatch.setattr("app.rank._vol_forecast_ratio", lambda *a, **k: 1.0)
        monkeypatch.setattr("app.rank.rank_underlying", lambda *a, **k: contracts)

    def test_a_far_dated_contract_is_dropped(self, monkeypatch) -> None:
        near = _candidate(underlying="TEST", occ_symbol="TEST  260918C00100000", dte=30, ev=10.0)
        leap = _candidate(underlying="TEST", occ_symbol="TEST  270918C00100000", dte=400, ev=99.0)
        self._patch_pipeline(monkeypatch, [near, leap])

        ranked = rank_day("2026-01-01", Path("unused"), top=10, min_dte=14, max_dte=60)

        assert [c.dte for c in ranked] == [30]

    def test_the_band_filters_before_the_top_n_cut_not_after(self, monkeypatch) -> None:
        # The real defect. `ev` is an absolute dollar figure and
        # `forecast_value` compounds drift over the contract's whole life,
        # so long-dated contracts carry larger EV almost mechanically and
        # crowd out the top of the list. With the filter applied after the
        # cut, `top=2` here would keep the two LEAPs and then discard both,
        # returning nothing — an empty board that reads as "the market
        # offered nothing today" when it was really the truncation.
        leaps = [
            _candidate(underlying="TEST", occ_symbol=f"TEST  2709{i:02d}C00100000", dte=400, ev=999.0 - i)
            for i in range(2)
        ]
        near = _candidate(underlying="TEST", occ_symbol="TEST  260918C00100000", dte=30, ev=1.0)
        self._patch_pipeline(monkeypatch, [*leaps, near])

        ranked = rank_day("2026-01-01", Path("unused"), top=2, min_dte=14, max_dte=60)

        assert [c.dte for c in ranked] == [30]

    def test_no_band_leaves_the_board_untouched(self, monkeypatch) -> None:
        # The Signal Board wants everything; only auto-entry passes a band.
        near = _candidate(underlying="TEST", occ_symbol="TEST  260918C00100000", dte=30, ev=10.0)
        leap = _candidate(underlying="TEST", occ_symbol="TEST  270918C00100000", dte=400, ev=99.0)
        self._patch_pipeline(monkeypatch, [near, leap])

        ranked = rank_day("2026-01-01", Path("unused"), top=10)

        assert sorted(c.dte for c in ranked) == [30, 400]


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

    def test_no_ranked_contract_carries_a_clamped_drift(self) -> None:
        """Regression test for a live incident: IEF (a Treasury bond ETF
        with ~4-5% real IV) got an annualized drift pinned exactly at the
        safety cap, and combined with its own near-zero volatility that
        made several of its calls look like a mathematical certainty
        (prob_profit rounding to 1.0). The clamp firing at all is evidence
        the extrapolation broke for that underlying, not a large-but-real
        signal — see the exclusion in rank_day's own loop.
        """
        from app.db import read_bars

        if read_bars().height == 0:
            pytest.skip("no bars in market.db yet — run bars:backfill first")
        day = _latest_priced_liquid_day()
        if day is None:
            pytest.skip("no liquid, priced option quotes captured yet")
        try:
            model_dir = latest_model_dir()
        except SystemExit:
            pytest.skip("no trained model yet — run app.train first")

        # top is generously large so this actually exercises every
        # gate-passing underlying, not just whichever few would have made
        # a small top-N cut.
        ranked = rank_day(day, model_dir, top=5000, force=True)
        for c in ranked:
            assert abs(c.forecast_drift) < MAX_ANNUALIZED_DRIFT, c.occ_symbol


class TestScoreHeldContracts:
    """The position-health path: re-scores specific, already-held
    contracts, rather than picking fresh candidates like `rank_day`.
    """

    def _real_day_and_model(self, tmp_path):
        from app.db import read_bars

        if read_bars().height == 0:
            pytest.skip("no bars in market.db yet — run bars:backfill first")
        day = _latest_priced_liquid_day()
        if day is None:
            pytest.skip("no liquid, priced option quotes captured yet")
        try:
            model_dir = latest_model_dir()
        except SystemExit:
            pytest.skip("no trained model yet — run app.train first")
        return day, model_dir

    def test_matches_rank_days_own_scoring_for_the_same_contract(self, tmp_path) -> None:
        # The property the whole split exists to guarantee: scoring a held
        # position must agree with a fresh ranking of the same contract on
        # the same day — two different formulas for "what does the model
        # think" would be its own, worse bug than the one this replaces.
        day, model_dir = self._real_day_and_model(tmp_path)
        ranked = rank_day(day, model_dir, top=1, force=True)
        if not ranked:
            pytest.skip("no gate-passing contracts today to cross-check against")
        c = ranked[0]

        scored = score_held_contracts(
            [{"occ_symbol": c.occ_symbol, "underlying": c.underlying}],
            day,
            model_dir,
            force=True,
        )
        held = scored[c.occ_symbol]
        assert held is not None
        assert held.ev == pytest.approx(c.ev, rel=1e-9)
        assert held.forecast_vol == pytest.approx(c.forecast_vol, rel=1e-9)
        assert held.prob_profit == pytest.approx(c.prob_profit, rel=1e-9)

    def test_unknown_contract_scores_to_none_not_a_crash(self, tmp_path) -> None:
        day, model_dir = self._real_day_and_model(tmp_path)
        scored = score_held_contracts(
            [{"occ_symbol": "ZZZZ  991231C00001000", "underlying": "ZZZZ"}],
            day,
            model_dir,
            force=True,
        )
        assert scored["ZZZZ  991231C00001000"] is None

    def test_liquid_only_is_false_unlike_rank_day(self) -> None:
        # A held position that fell below today's liquidity threshold must
        # still get scored — hiding it would mean silence exactly when a
        # position needs the most attention, which is the whole reason this
        # function exists as something other than "call rank_day again".
        quotes = _quotes_frame([_quote_row(liquid=False)])
        # rank_underlying itself never looks at `liquid` at all — the gate
        # is applied by `read_quotes(liquid_only=...)` before rows ever
        # reach here, which is exactly the boundary this test pins: a
        # `liquid=False` row must still price normally once it's in front
        # of rank_underlying, proving the two callers only differ in what
        # they ask the DB for, not in how a row is priced once fetched.
        ranked = rank_underlying(quotes, "2025-12-01", 0.05, 1.0, [(365, 0.04)])
        assert len(ranked) == 1


def _candidate(**overrides) -> RankedContract:
    base = dict(
        occ_symbol="AAA   260918C00100000",
        underlying="AAA",
        expiry="2026-09-18",
        type="call",
        strike=100.0,
        dte=30,
        market_price=2.0,  # $200/contract at the standard 100x multiplier
        market_iv=0.3,
        forecast_vol=0.32,
        forecast_drift=0.05,
        forecast_value=2.5,
        ev=50.0,
        ev_per_risk=0.25,
        prob_profit=0.6,
    )
    base.update(overrides)
    return RankedContract(**base)


class TestSelectEntries:
    """Capital-constrained entry selection — the rule that replaced "pick
    exactly one winner" after a real $122,440-per-contract candidate showed
    the old path had no price cap at all.
    """

    def _select(self, candidates, **overrides):
        defaults = dict(
            held_underlyings=set(),
            available_capital=10_000.0,
            open_position_count=0,
            max_concurrent_positions=10,
            max_new_positions=5,
            min_ev_per_risk=0.05,
            min_prob_profit=0.5,
            # The shipped band, and `_candidate`'s 30-day fixture sits
            # inside it — so every test below runs against the real
            # maturity filter rather than one widened out of its way.
            min_dte=14,
            max_dte=60,
        )
        defaults.update(overrides)
        return select_entries(candidates, **defaults)

    def test_opens_every_independent_affordable_candidate_up_to_the_daily_cap(self) -> None:
        candidates = [
            _candidate(occ_symbol=f"{u}   260918C00100000", underlying=u, ev=ev)
            for u, ev in [("AAA", 50.0), ("BBB", 40.0), ("CCC", 30.0)]
        ]
        selected = self._select(candidates)
        assert [s.contract.underlying for s in selected] == ["AAA", "BBB", "CCC"]

    def test_stops_at_max_new_positions(self) -> None:
        candidates = [
            _candidate(occ_symbol=f"{u}   260918C00100000", underlying=u, ev=ev)
            for u, ev in [("AAA", 50.0), ("BBB", 40.0), ("CCC", 30.0)]
        ]
        selected = self._select(candidates, max_new_positions=2)
        assert [s.contract.underlying for s in selected] == ["AAA", "BBB"]

    def test_concurrent_position_room_binds_before_the_daily_cap(self) -> None:
        candidates = [
            _candidate(occ_symbol=f"{u}   260918C00100000", underlying=u)
            for u in ["AAA", "BBB", "CCC"]
        ]
        # 9 already open against a ceiling of 10: one slot left, even
        # though the daily cap alone would allow more.
        selected = self._select(candidates, open_position_count=9, max_concurrent_positions=10)
        assert len(selected) == 1

    def test_an_unaffordable_top_candidate_is_skipped_not_fatal(self) -> None:
        # The real incident: a $122,440 contract atop the board. It must be
        # passed over, and the next affordable candidate still selected.
        whale = _candidate(underlying="WHL", occ_symbol="WHL   260918P02270000", market_price=1224.4, ev=999.0)
        modest = _candidate(underlying="MOD", occ_symbol="MOD   260918C00100000", ev=10.0)
        selected = self._select([whale, modest], available_capital=10_000.0)
        assert [s.contract.underlying for s in selected] == ["MOD"]

    def test_capital_depletes_across_acceptances(self) -> None:
        # $500 available; each contract costs $200 — only two fit.
        candidates = [
            _candidate(occ_symbol=f"{u}   260918C00100000", underlying=u, ev=ev)
            for u, ev in [("AAA", 50.0), ("BBB", 40.0), ("CCC", 30.0)]
        ]
        selected = self._select(candidates, available_capital=500.0)
        assert [s.contract.underlying for s in selected] == ["AAA", "BBB"]

    def test_never_selects_a_held_underlying_or_two_contracts_on_one_name(self) -> None:
        candidates = [
            _candidate(underlying="HELD", occ_symbol="HELD  260918C00100000", ev=99.0),
            _candidate(underlying="DUP", occ_symbol="DUP   260918C00100000", ev=50.0),
            _candidate(underlying="DUP", occ_symbol="DUP   260918C00110000", ev=45.0),
        ]
        selected = self._select(candidates, held_underlyings={"HELD"})
        assert [s.contract.occ_symbol for s in selected] == ["DUP   260918C00100000"]

    def test_bars_filter_out_weak_candidates(self) -> None:
        weak_ev = _candidate(underlying="AAA", ev_per_risk=0.01)
        weak_prob = _candidate(underlying="BBB", occ_symbol="BBB   260918C00100000", prob_profit=0.1)
        assert self._select([weak_ev, weak_prob]) == []

    def test_zero_available_capital_selects_nothing(self) -> None:
        assert self._select([_candidate()], available_capital=0.0) == []

    def test_no_room_for_new_positions_selects_nothing(self) -> None:
        # At the concurrent ceiling. Without the early return this divided
        # available capital by zero slots to compute the equal weight.
        assert self._select([_candidate()], open_position_count=10, max_concurrent_positions=10) == []


class TestSelectEntriesSizing:
    """Equal-weight position sizing. Before this, the caller hard-coded one
    contract per pick, so a position's real size was whatever the contract
    happened to cost — one unit of a $12 contract and one of a $1,200
    contract were treated as the same bet.
    """

    def _select(self, candidates, **overrides):
        defaults = dict(
            held_underlyings=set(),
            available_capital=10_000.0,
            open_position_count=0,
            max_concurrent_positions=10,
            max_new_positions=5,
            min_ev_per_risk=0.05,
            min_prob_profit=0.5,
            min_dte=14,
            max_dte=60,
        )
        defaults.update(overrides)
        return select_entries(candidates, **defaults)

    def test_two_differently_priced_contracts_get_near_equal_dollar_weight(self) -> None:
        # $10,000 over 10 concurrent slots is a $1,000 budget each. A $200
        # contract takes 5 units and a $1,000 contract 1 — the point of
        # sizing: equal *money*, not equal contract count.
        cheap = _candidate(underlying="CHP", occ_symbol="CHP   260918C00100000", market_price=2.0, ev=50.0)
        dear = _candidate(underlying="DER", occ_symbol="DER   260918C00100000", market_price=10.0, ev=40.0)

        selected = self._select([cheap, dear])

        assert [s.quantity for s in selected] == [5, 1]
        assert [s.cost for s in selected] == [1_000.0, 1_000.0]

    def test_sizing_never_commits_more_than_the_capital_available(self) -> None:
        candidates = [
            _candidate(occ_symbol=f"{u}   260918C00100000", underlying=u, ev=ev)
            for u, ev in [("AAA", 50.0), ("BBB", 40.0), ("CCC", 30.0)]
        ]
        selected = self._select(candidates, available_capital=10_000.0)
        assert sum(s.cost for s in selected) <= 10_000.0

    def test_a_contract_costing_more_than_its_slot_still_gets_one_unit(self) -> None:
        # $1,000 per slot, but the contract costs $3,000. Rounding the
        # equal-weight quantity down would give zero and silently drop a
        # candidate that the account can genuinely afford.
        chunky = _candidate(underlying="BIG", occ_symbol="BIG   260918C00100000", market_price=30.0)

        selected = self._select([chunky])

        assert [s.quantity for s in selected] == [1]
        assert [s.cost for s in selected] == [3_000.0]

    def test_quantity_is_capped_by_cash_left_not_just_by_the_slot_budget(self) -> None:
        # One concurrent slot, so the slot budget is the whole $10,000 —
        # but only $700 is available, which is 3 contracts at $200, not 50.
        c = _candidate(underlying="AAA")

        selected = self._select(
            [c], available_capital=700.0, max_new_positions=1, max_concurrent_positions=1
        )

        assert [s.quantity for s in selected] == [3]
        assert selected[0].cost == 600.0

    def test_a_thin_day_deploys_one_slot_rather_than_concentrating(self) -> None:
        # Only one candidate clears the bar. It gets one slot's worth, not
        # the whole book — the concentration the equal-weight rule exists
        # to prevent. Stated as a test because it is a deliberate choice
        # that looks like under-investment.
        lonely = _candidate(underlying="AAA")

        selected = self._select([lonely], available_capital=10_000.0, max_new_positions=5)

        assert selected[0].cost == 1_000.0

    def test_a_full_day_leaves_room_for_later_days_at_comparable_size(self) -> None:
        # The real defect this replaced: dividing by the per-day cap sized
        # each of today's picks as though today were the only day the book
        # would ever fill. At 10 concurrent / 5 per day that put 100% of
        # deployable capital into day one, and day two's names then arrived
        # at a fifth the size — a 5:1 overweight decided by which name
        # cleared the bar first.
        names = ["AAA", "BBB", "CCC", "DDD", "EEE"]
        day_one = self._select(
            [
                _candidate(occ_symbol=f"{u}   260918C00100000", underlying=u, ev=50.0 - i)
                for i, u in enumerate(names)
            ],
            available_capital=80_000.0,
        )
        assert sum(s.cost for s in day_one) == 40_000.0  # half, not all

        # Day two, against the cash day one actually left.
        later = ["FFF", "GGG", "HHH", "III", "JJJ"]
        day_two = self._select(
            [
                _candidate(occ_symbol=f"{u}   260918C00100000", underlying=u, ev=50.0 - i)
                for i, u in enumerate(later)
            ],
            available_capital=48_000.0,
            open_position_count=5,
        )
        assert day_one[0].cost / day_two[0].cost < 1.5

    def test_a_zero_priced_contract_is_refused_rather_than_sized_infinitely(self) -> None:
        # A stale or bad print at 0 would divide by zero computing quantity.
        free = _candidate(underlying="AAA", market_price=0.0)
        assert self._select([free]) == []


class TestSelectEntriesDteBand:
    """Entries are confined to maturities the forecast can speak to. The
    direction model predicts one fixed horizon and `_annualize_horizon_return`
    stretches it into a constant drift, so EV at a far-dated contract is
    mostly extrapolation past anything the model measured.
    """

    def _select(self, candidates, **overrides):
        defaults = dict(
            held_underlyings=set(),
            available_capital=10_000.0,
            open_position_count=0,
            max_concurrent_positions=10,
            max_new_positions=5,
            min_ev_per_risk=0.05,
            min_prob_profit=0.5,
            min_dte=14,
            max_dte=60,
        )
        defaults.update(overrides)
        return select_entries(candidates, **defaults)

    def test_a_far_dated_contract_is_excluded_however_good_its_ev_looks(self) -> None:
        # 400 DTE with the board's best EV. That EV is the fixed-horizon
        # drift compounded out more than a year — precisely the number the
        # band exists to distrust.
        leap = _candidate(underlying="LEP", occ_symbol="LEP   270918C00100000", dte=400, ev=999.0)
        near = _candidate(underlying="NER", occ_symbol="NER   260918C00100000", dte=30, ev=10.0)

        selected = self._select([leap, near])

        assert [s.contract.underlying for s in selected] == ["NER"]

    def test_a_contract_expiring_inside_the_forecast_window_is_excluded(self) -> None:
        # 5 DTE cannot be held through a 5-trading-day forecast and still
        # exited above exit.py's DTE floor — it would be closed on the
        # calendar, never on the signal.
        weekly = _candidate(underlying="WKL", occ_symbol="WKL   260828C00100000", dte=5, ev=99.0)
        assert self._select([weekly]) == []

    def test_the_band_is_inclusive_at_both_ends(self) -> None:
        low = _candidate(underlying="LOW", occ_symbol="LOW   260918C00100000", dte=14, ev=50.0)
        high = _candidate(underlying="HIG", occ_symbol="HIG   260918C00100000", dte=60, ev=40.0)

        selected = self._select([low, high])

        assert [s.contract.underlying for s in selected] == ["LOW", "HIG"]

    def test_an_excluded_maturity_does_not_consume_a_selection_slot(self) -> None:
        # Filtering by maturity in the caller instead of here would let a
        # rejected candidate eat a slot and silently shrink the day's book.
        leap = _candidate(underlying="LEP", occ_symbol="LEP   270918C00100000", dte=400, ev=999.0)
        a = _candidate(underlying="AAA", occ_symbol="AAA   260918C00100000", ev=50.0)
        b = _candidate(underlying="BBB", occ_symbol="BBB   260918C00100000", ev=40.0)

        selected = self._select([leap, a, b], max_new_positions=2)

        assert [s.contract.underlying for s in selected] == ["AAA", "BBB"]


class TestModelSelection:
    """Which model actually gets served, and why.

    Promotion was pure bookkeeping until this: `model_runs` carried a
    `champion` status and a promote route, and the serving path read
    neither. These tests pin the case that made that invisible.
    """

    def _artifact(self, base: Path, name: str) -> Path:
        d = base / name
        d.mkdir(parents=True)
        (d / "manifest.json").write_text(json.dumps({"run_id": name}))
        return d

    def test_serves_the_registry_champion_even_when_it_sorts_first(
        self, tmp_path, monkeypatch
    ) -> None:
        """The bug, pinned. Three runs trained the same day order by config
        hash, not by time. The old selector took the lexicographic maximum,
        so a champion whose hash begins `0` stayed promoted and unused
        while a different model answered every request — with nothing
        anywhere reporting the divergence.
        """
        base = tmp_path / "models"
        self._artifact(base, "2026-08-24-dir-h5-0aaaaaaaaaaa")  # the champion
        self._artifact(base, "2026-08-24-dir-h5-ffffffffffff")  # sorts last

        monkeypatch.setattr(
            "app.rank.read_champion_run",
            lambda: {
                "run_id": "2026-08-24-dir-h5-0aaaaaaaaaaa",
                "artifact_dir": "2026-08-24-dir-h5-0aaaaaaaaaaa",
                "status": "champion",
                "promoted_at": "2026-08-24T15:35:13Z",
            },
        )

        choice = resolve_model(base)

        assert choice.run_id == "2026-08-24-dir-h5-0aaaaaaaaaaa"
        assert choice.source == "champion"

    def test_falls_back_to_the_newest_written_not_the_last_alphabetically(
        self, tmp_path, monkeypatch
    ) -> None:
        # The fallback had the identical defect and no reason to keep it.
        base = tmp_path / "models"
        first = self._artifact(base, "2026-08-24-dir-h5-ffffffffffff")
        newest = self._artifact(base, "2026-08-24-dir-h5-000000000000")
        os.utime(first / "manifest.json", (1_000_000, 1_000_000))
        os.utime(newest / "manifest.json", (2_000_000, 2_000_000))

        monkeypatch.setattr("app.rank.read_champion_run", lambda: None)

        choice = resolve_model(base)

        assert choice.run_id == "2026-08-24-dir-h5-000000000000"
        assert choice.source == "newest"

    def test_a_champion_whose_artifact_is_missing_degrades_rather_than_crashing(
        self, tmp_path, monkeypatch
    ) -> None:
        # A registry row can outlive its files — pruned, or synced from a
        # machine whose artifacts never came with it. Ranking must still
        # work, and must not claim the champion answered.
        base = tmp_path / "models"
        self._artifact(base, "2026-08-24-dir-h5-ffffffffffff")
        monkeypatch.setattr(
            "app.rank.read_champion_run",
            lambda: {
                "run_id": "gone",
                "artifact_dir": "gone",
                "status": "champion",
                "promoted_at": "2026-08-24T15:35:13Z",
            },
        )

        choice = resolve_model(base)

        assert choice.source == "newest"
        assert choice.run_id == "2026-08-24-dir-h5-ffffffffffff"

    def test_an_unreadable_registry_does_not_take_ranking_down(
        self, tmp_path, monkeypatch
    ) -> None:
        # market.db may be mid-sync or predate the model_runs table.
        base = tmp_path / "models"
        self._artifact(base, "2026-08-24-dir-h5-ffffffffffff")

        def _boom():
            raise RuntimeError("no such table: model_runs")

        monkeypatch.setattr("app.rank.read_champion_run", _boom)

        choice = resolve_model(base)

        assert choice.source == "newest"

    def test_no_artifacts_at_all_still_refuses_loudly(self, tmp_path, monkeypatch) -> None:
        monkeypatch.setattr("app.rank.read_champion_run", lambda: None)
        with pytest.raises(SystemExit, match="No trained models found"):
            resolve_model(tmp_path / "empty")
