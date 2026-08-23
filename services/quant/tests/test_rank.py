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
        )
        defaults.update(overrides)
        return select_entries(candidates, **defaults)

    def test_opens_every_independent_affordable_candidate_up_to_the_daily_cap(self) -> None:
        candidates = [
            _candidate(occ_symbol=f"{u}   260918C00100000", underlying=u, ev=ev)
            for u, ev in [("AAA", 50.0), ("BBB", 40.0), ("CCC", 30.0)]
        ]
        selected = self._select(candidates)
        assert [c.underlying for c in selected] == ["AAA", "BBB", "CCC"]

    def test_stops_at_max_new_positions(self) -> None:
        candidates = [
            _candidate(occ_symbol=f"{u}   260918C00100000", underlying=u, ev=ev)
            for u, ev in [("AAA", 50.0), ("BBB", 40.0), ("CCC", 30.0)]
        ]
        selected = self._select(candidates, max_new_positions=2)
        assert [c.underlying for c in selected] == ["AAA", "BBB"]

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
        assert [c.underlying for c in selected] == ["MOD"]

    def test_capital_depletes_across_acceptances(self) -> None:
        # $500 available; each contract costs $200 — only two fit.
        candidates = [
            _candidate(occ_symbol=f"{u}   260918C00100000", underlying=u, ev=ev)
            for u, ev in [("AAA", 50.0), ("BBB", 40.0), ("CCC", 30.0)]
        ]
        selected = self._select(candidates, available_capital=500.0)
        assert [c.underlying for c in selected] == ["AAA", "BBB"]

    def test_never_selects_a_held_underlying_or_two_contracts_on_one_name(self) -> None:
        candidates = [
            _candidate(underlying="HELD", occ_symbol="HELD  260918C00100000", ev=99.0),
            _candidate(underlying="DUP", occ_symbol="DUP   260918C00100000", ev=50.0),
            _candidate(underlying="DUP", occ_symbol="DUP   260918C00110000", ev=45.0),
        ]
        selected = self._select(candidates, held_underlyings={"HELD"})
        assert [c.occ_symbol for c in selected] == ["DUP   260918C00100000"]

    def test_bars_filter_out_weak_candidates(self) -> None:
        weak_ev = _candidate(underlying="AAA", ev_per_risk=0.01)
        weak_prob = _candidate(underlying="BBB", occ_symbol="BBB   260918C00100000", prob_profit=0.1)
        assert self._select([weak_ev, weak_prob]) == []

    def test_zero_available_capital_selects_nothing(self) -> None:
        assert self._select([_candidate()], available_capital=0.0) == []
