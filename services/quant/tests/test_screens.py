"""Quote-screen tests.

The screens implement the empirical options literature's standard filters
(Cao & Han JFE 2013's list, quoted in screens.py) plus a staleness screen
that substitutes for the bid-based checks this corpus cannot run. The
central test reproduces the real incident: the SNDK print that cost
$122,440 passed every check the system then had, including the
no-arbitrage bounds everyone assumed would catch it.
"""

from __future__ import annotations

import polars as pl
import pytest

from app.screens import (
    MAX_IV_ABSOLUTE,
    MAX_IV_FLAT,
    MIN_PRICE,
    ScreenResult,
    screen_quotes,
)


def _chain(rows: list[dict]) -> pl.DataFrame:
    base = {
        "occ_symbol": "TEST  260918C00100000",
        "underlying": "TEST",
        "expiry": "2026-09-18",
        "type": "call",
        "strike": 100.0,
        "bid": None,
        "ask": None,
        "mid": None,
        "close": 5.0,
        "price": 5.0,
        "volume": 50,
        "open_interest": 500,
        "underlying_price": 100.0,
        "underlying_asof_day": "2026-08-21",
        "iv": 0.3,
        "delta": 0.5,
        "gamma": 0.01,
        "vega": 0.1,
        "theta": -0.05,
        "liquid": True,
    }
    return pl.DataFrame([{**base, **r} for r in rows])


class TestTheIncident:
    """The SNDK 2270 put, as captured: S=1786.85, K=2270, price=1224.40,
    IV solved at 4.47, volume 10 and price unchanged across every day."""

    SNDK = {
        "occ_symbol": "SNDK  260918P02270000",
        "type": "put",
        "strike": 2270.0,
        "underlying_price": 1786.85,
        "price": 1224.40,
        "close": 1224.40,
        "volume": 10,
        "iv": 4.4739,
    }

    def test_the_no_arbitrage_bounds_alone_do_not_catch_it(self) -> None:
        # The fix everyone assumed would work, shown not to: the price sits
        # inside the put's [K-S, K] band, so bounds-only screening ranks it
        # again. This test is why the module has five other screens.
        intrinsic = self.SNDK["strike"] - self.SNDK["underlying_price"]
        assert intrinsic < self.SNDK["price"] < self.SNDK["strike"]

    def test_the_full_screen_set_rejects_it_without_needing_a_prior_day(self) -> None:
        result = screen_quotes(_chain([self.SNDK]), prior_stats=None, trading_day="2026-08-21")

        assert result.passed.height == 0
        # With no symbol_vol and no sane ATM strikes to standardize
        # against, the band degrades to the flat literature rail and
        # K/S = 1.27 is out; the total-vol ceiling (σ√T ≈ 1.24) would
        # catch it independently if the band moved.
        assert "moneyness" in result.dropped

    def test_it_is_rejected_even_on_the_bare_default_call_path(self) -> None:
        # Review found the degraded (no trading_day) path had become
        # strictly weaker than the pre-standardization screens — this
        # exact print passed every remaining check. Degrading now means
        # falling back to the flat band and flat ceiling, not skipping.
        result = screen_quotes(_chain([self.SNDK]))

        assert result.passed.height == 0
        assert result.vol_screens_ran is False

    def test_a_believable_stale_print_at_a_sane_strike_still_needs_staleness(self) -> None:
        # The deliberate residual in the total-vol ceiling: between ~14
        # and ~51 DTE the scaled ceiling sits above the old flat 2.0, so
        # a frozen close solving to e.g. 270% IV at 28 days clears the IV
        # screens. The staleness screen is the defense there — which is
        # why rank_day audits stale_screen_unavailable_symbols loudly.
        frozen = {**self.SNDK, "strike": 1800.0, "iv": 2.70}
        result = screen_quotes(_chain([frozen]), _chain([frozen]), trading_day="2026-08-21")

        assert result.passed.height == 0
        assert result.dropped == {"stale_price": 1}

    def test_the_staleness_screen_catches_it_even_at_sane_moneyness(self) -> None:
        # Suppose the same frozen print sat at an unremarkable strike: the
        # unchanged close plus unchanged volume and open interest against
        # the prior capture is what identifies it as fiction, not price.
        frozen = {**self.SNDK, "strike": 1800.0, "iv": 0.45}
        today = _chain([frozen])
        prior = _chain([frozen])

        result = screen_quotes(today, prior)

        assert result.passed.height == 0
        assert result.dropped == {"stale_price": 1}


class TestIndividualScreens:
    def test_moneyness_scales_with_the_underlying_s_own_volatility(self) -> None:
        """The review finding that motivated standardization: a fixed
        0.8–1.2 band cut the strikes a high-vol name's directional trade
        would actually use, while admitting a low-vol name's economically
        empty 20σ ladder. Distance from ATM is now measured in σ√T."""
        # 30 days out. K/S = 1.25 → |ln| ≈ 0.223.
        rows = [{"occ_symbol": "K125", "strike": 125.0, "price": 6.0, "close": 6.0, "iv": 0.6}]

        # High-vol name (σ=0.60): 0.223 / (0.60·√(28/365)) ≈ 1.3σ — inside.
        high = screen_quotes(_chain(rows), trading_day="2026-08-21", symbol_vol=0.60)
        assert high.passed.height == 1

        # Low-vol name (σ=0.08): same strike is ≈10σ — economically empty, out.
        low = screen_quotes(_chain(rows), trading_day="2026-08-21", symbol_vol=0.08)
        assert low.dropped.get("moneyness") == 1

    def test_without_vol_context_the_band_degrades_to_the_literature_s(self) -> None:
        # No trading_day → the standardized band cannot run; the flat
        # 0.8–1.2 literature band applies instead — the conservative
        # pre-standardization behavior, never "no band at all".
        rows = [
            {"occ_symbol": "ABSURD", "strike": 300.0, "price": 1.0, "close": 1.0},
            {"occ_symbol": "SANE", "strike": 110.0},
        ]
        result = screen_quotes(_chain(rows))
        assert set(result.passed["occ_symbol"].to_list()) == {"SANE"}
        assert result.dropped.get("moneyness") == 1
        assert result.vol_screens_ran is False

    def test_the_band_widens_to_the_market_s_atm_iv_when_rv_runs_below_it(self) -> None:
        # symbol_vol is a *realized*-vol forecast, and under the variance
        # risk premium RV runs below IV in the normal state. σ is
        # max(RV, ATM IV) so the 55%-IV biotech whose trailing RV is 32%
        # gets the band the docstring promises it (K/S=1.3 ≈ 1.7σ), not a
        # 3σ rejection that silently empties it off the board.
        rows = [
            {"occ_symbol": "ATM1", "strike": 100.0, "iv": 0.55},
            {"occ_symbol": "ATM2", "strike": 105.0, "iv": 0.55},
            {"occ_symbol": "DIRECTIONAL", "strike": 130.0, "iv": 0.60, "price": 1.0, "close": 1.0},
        ]
        result = screen_quotes(_chain(rows), trading_day="2026-08-21", symbol_vol=0.32)
        assert "DIRECTIONAL" in set(result.passed["occ_symbol"].to_list())

    def test_a_high_vol_name_s_far_strike_is_judged_in_sigma_not_by_a_fixed_rail(self) -> None:
        # An earlier version kept an unconditional raw [0.5, 2.0] rail
        # that overrode the standardized band precisely for the high-vol
        # names standardization was written to serve. K/S = 2.05 at 90%
        # vol and 60 days is 1.97σ — a sensible directional strike, kept.
        rows = [{"occ_symbol": "FARDIR", "strike": 205.0, "expiry": "2026-10-20",
                 "price": 1.0, "close": 1.0, "iv": 0.9}]
        result = screen_quotes(_chain(rows), trading_day="2026-08-21", symbol_vol=0.9)
        assert result.passed.height == 1

    def test_sigma_reference_is_never_the_row_s_own_iv(self) -> None:
        # A corrupt print must not widen its own admission band. With no
        # symbol_vol the reference is the chain's *ATM* median, so one
        # wild row in a sane chain is judged by the sane majority.
        rows = [
            {"occ_symbol": "WILD", "strike": 160.0, "iv": 3.0, "price": 2.0, "close": 2.0},
            {"occ_symbol": "A", "strike": 100.0, "iv": 0.30},
            {"occ_symbol": "B", "strike": 102.0, "iv": 0.32},
        ]
        result = screen_quotes(_chain(rows), trading_day="2026-08-21")
        # Judged at σ≈0.31: ln(1.6)/(0.31·√(28/365)) ≈ 5.5σ — out.
        assert "WILD" not in set(result.passed["occ_symbol"].to_list())

    def test_stale_prints_cannot_inflate_the_sigma_reference(self) -> None:
        # Review reproduced a whole-chain median moving 0.60 → 4.40 when
        # three frozen 400%+ prints sat in the chain — widening the band
        # until a 7.7σ strike passed. The ATM reference excludes IVs
        # above MAX_IV_FLAT, so prints the extreme screens will reject
        # cannot first widen the band on their way out.
        assert MAX_IV_FLAT == 2.0
        rows = [
            {"occ_symbol": "STALE1", "strike": 100.0, "iv": 4.4},
            {"occ_symbol": "STALE2", "strike": 102.0, "iv": 4.4},
            {"occ_symbol": "STALE3", "strike": 98.0, "iv": 4.4},
            {"occ_symbol": "SANE", "strike": 100.0, "iv": 0.60},
            {"occ_symbol": "JUNK", "strike": 190.0, "iv": 0.65, "price": 0.5, "close": 0.5},
        ]
        result = screen_quotes(_chain(rows), trading_day="2026-08-21")
        # σ comes from SANE alone (0.60): ln(1.9)/(0.60·√(28/365)) ≈ 3.9σ.
        kept = set(result.passed["occ_symbol"].to_list())
        assert "JUNK" not in kept
        assert "JUNK" in result.dropped_rows["moneyness"]

    def test_a_malformed_expiry_is_dropped_by_name_not_raised_or_laundered(self) -> None:
        # `expiry` is vendor text. A strict parse aborted the *entire*
        # ranking run on one bad string; a silently-nulled parse would
        # attribute the drop to "moneyness" on an ATM strike. Neither:
        # the row is dropped under its own name and the chain survives.
        rows = [
            {"occ_symbol": "BADEXP", "expiry": "not-a-date"},
            {"occ_symbol": "NULLEXP", "expiry": None},
            {"occ_symbol": "FINE", "strike": 105.0},
        ]
        result = screen_quotes(_chain(rows), trading_day="2026-08-21", symbol_vol=0.3)
        assert set(result.passed["occ_symbol"].to_list()) == {"FINE"}
        assert set(result.dropped_rows["bad_expiry"]) == {"BADEXP", "NULLEXP"}


    def test_zero_volume_is_rejected(self) -> None:
        result = screen_quotes(_chain([{"volume": 0}]))
        assert result.passed.height == 0
        assert result.dropped == {"zero_volume": 1}

    def test_penny_prints_are_rejected_at_the_literature_s_eighth(self) -> None:
        result = screen_quotes(_chain([{"price": 0.10, "close": 0.10}]))
        assert result.passed.height == 0
        assert result.dropped == {"min_price": 1}
        assert MIN_PRICE == 0.125

    def test_the_iv_ceiling_is_total_vol_so_short_dated_event_vol_survives(self) -> None:
        """A flat annualized ceiling bit hardest at the short end, where
        genuinely-priced event vol is mechanically highest. In σ√T terms
        the two populations separate."""
        # 250% IV, 14 days out: σ√T ≈ 0.49 — a real pre-earnings market.
        earnings = {"occ_symbol": "EVT", "expiry": "2026-09-04", "iv": 2.5, "strike": 100.0}
        kept = screen_quotes(_chain([earnings]), trading_day="2026-08-21")
        assert kept.passed.height == 1

        # The incident's 447% at 28 days: σ√T ≈ 1.24 — no real market. Out.
        stale = {"occ_symbol": "STALE", "iv": 4.47, "strike": 100.0}
        out = screen_quotes(_chain([stale]), trading_day="2026-08-21")
        assert out.dropped.get("extreme_total_vol") == 1

    def test_the_scaled_ceiling_never_tightens_below_the_flat_one_it_replaced(self) -> None:
        # σ√T ≤ 0.75 alone crosses under the old flat 2.0 at ~51 DTE — a
        # silent long-end tightening the change never argued for. The
        # ceiling is floored at MAX_IV_FLAT: 190% IV at 60 days
        # (σ√T ≈ 0.77) was believable under the old regime and stays in.
        rows = [{"occ_symbol": "LONGVOL", "expiry": "2026-10-20", "iv": 1.9,
                 "strike": 100.0}]
        result = screen_quotes(_chain(rows), trading_day="2026-08-21", symbol_vol=1.9)
        assert result.passed.height == 1

    def test_the_absolute_iv_rail_holds_even_without_a_trading_day(self) -> None:
        result = screen_quotes(_chain([{"iv": MAX_IV_ABSOLUTE + 0.1}]))
        assert result.dropped == {"extreme_iv": 1}

    def test_arbitrage_bounds_reject_an_impossible_call(self) -> None:
        # A call above the stock price is free money for the seller —
        # certainly bad data.
        result = screen_quotes(_chain([{"price": 101.0, "close": 101.0}]))
        assert result.dropped == {"arbitrage_bounds": 1}

    def test_stale_means_close_frozen_and_volume_or_oi_frozen(self) -> None:
        # The rule after review: close unchanged AND at least one of
        # volume / open interest unchanged. The incident had all three
        # frozen; requiring close+volume alone let its nearest neighbour
        # through — a vendor that jitters reconstructed volume while
        # carrying the close forward. A genuinely trading contract moves
        # both volume and OI and survives.
        today = _chain([
            {"occ_symbol": "MOVED", "close": 5.1},
            {"occ_symbol": "ACTIVE", "close": 5.0, "volume": 51, "open_interest": 510},
            {"occ_symbol": "VOLJITTER", "close": 5.0, "volume": 51, "open_interest": 500},
            {"occ_symbol": "FROZEN", "close": 5.0, "volume": 50, "open_interest": 500},
        ])
        prior = _chain([
            {"occ_symbol": "MOVED", "close": 5.0},
            {"occ_symbol": "ACTIVE", "close": 5.0, "volume": 50, "open_interest": 500},
            {"occ_symbol": "VOLJITTER", "close": 5.0, "volume": 50, "open_interest": 500},
            {"occ_symbol": "FROZEN", "close": 5.0, "volume": 50, "open_interest": 500},
        ])

        result = screen_quotes(today, prior)

        kept = set(result.passed["occ_symbol"].to_list())
        # MOVED: close changed. ACTIVE: volume AND OI both moved. Kept.
        # VOLJITTER: close and OI frozen, only volume ticked — the near
        # neighbour of the incident. FROZEN: everything frozen. Dropped.
        assert kept == {"MOVED", "ACTIVE"}
        assert result.dropped == {"stale_price": 2}
        assert set(result.dropped_rows["stale_price"]) == {"VOLJITTER", "FROZEN"}
        assert result.staleness_ran is True

    def test_duplicate_prior_rows_do_not_fan_out_the_join(self) -> None:
        # option_quotes is append-only on (occ_symbol, as_of); a recaptured
        # day holds duplicates. Un-deduped, the left join fans out: a
        # frozen contract survives because one duplicate differs, the audit
        # counts a drop corresponding to no contract, and in the mirror
        # case one contract reaches the board twice.
        today = _chain([{"occ_symbol": "FROZEN", "close": 5.0, "volume": 50}])
        prior = _chain([
            {"occ_symbol": "FROZEN", "close": 5.0, "volume": 50},
            {"occ_symbol": "FROZEN", "close": 9.9, "volume": 3},
        ])

        result = screen_quotes(today, prior)

        assert result.passed.height == 0
        assert result.dropped == {"stale_price": 1}

    def test_a_stale_spot_disqualifies_the_chain_by_name(self) -> None:
        # The capture layer's "latest bar in a trailing window" hands back
        # Friday's close when Monday's aggregate is not yet published. On
        # a gap day that spot is wrong for *every* contract at once —
        # moneyness centred above real ATM, legitimate ITM calls reading
        # as bounds violations. The provenance column makes it checkable.
        rows = [
            {"occ_symbol": "FRESH", "underlying_asof_day": "2026-08-21"},
            {"occ_symbol": "CARRIED", "underlying_asof_day": "2026-08-20"},
        ]
        chain = _chain(rows).with_columns(pl.col("underlying_asof_day"))
        result = screen_quotes(chain, trading_day="2026-08-21", symbol_vol=0.3)
        assert set(result.passed["occ_symbol"].to_list()) == {"FRESH"}
        assert result.dropped_rows["stale_spot"] == ["CARRIED"]

    def test_unknown_spot_provenance_skips_the_check_rather_than_failing_it(self) -> None:
        # Rows captured before the column existed are *unknown*, not
        # fresh and not stale — and a frame without the column at all
        # (older callers) must keep working.
        rows = [{"occ_symbol": "LEGACY", "underlying_asof_day": None}]
        chain = _chain(rows)
        result = screen_quotes(chain, trading_day="2026-08-21", symbol_vol=0.3)
        assert result.passed.height == 1

        no_column = _chain([{"occ_symbol": "OLDFRAME"}]).drop("underlying_asof_day")
        result2 = screen_quotes(no_column, trading_day="2026-08-21", symbol_vol=0.3)
        assert result2.passed.height == 1

    def test_a_missing_spot_is_named_not_blamed_on_moneyness(self) -> None:
        # strike/0 is inf, inf is outside any band — the audit would read
        # "the whole chain was far OTM" when the truth is "the underlying
        # had no price".
        result = screen_quotes(_chain([{"underlying_price": 0.0}]))
        assert result.dropped == {"no_spot": 1}

    def test_deep_itm_close_slightly_under_eod_intrinsic_survives_the_bounds(self) -> None:
        # `price` for no-quote contracts is the last *trade*; the spot is
        # the *closing* print. A stock that rallies into the close leaves a
        # legitimate deep-ITM trade below end-of-day intrinsic — the known
        # non-synchronous-close artifact, not bad data. The lower bound
        # carries 5% tolerance for exactly this.
        row = {"strike": 84.0, "price": 15.5, "close": 15.5}  # intrinsic 16.0, within 5%
        result = screen_quotes(_chain([row]))
        assert result.passed.height == 1

        far_below = {"strike": 84.0, "price": 10.0, "close": 10.0}  # 37% below intrinsic
        result2 = screen_quotes(_chain([far_below]))
        assert result2.dropped == {"arbitrage_bounds": 1}

    def test_a_contract_absent_from_the_prior_day_is_not_stale(self) -> None:
        # Newly listed, or newly liquid: no prior print means no evidence
        # of staleness, not proof of it.
        result = screen_quotes(_chain([{"occ_symbol": "NEW"}]), _chain([{"occ_symbol": "OLD"}]))
        assert result.passed.height == 1

    def test_no_prior_day_skips_the_staleness_screen_rather_than_faking_it(self) -> None:
        result = screen_quotes(_chain([{}]), prior_stats=None)
        assert result.passed.height == 1
        assert "stale_price" not in result.dropped


class TestAudit:
    def test_every_dropped_row_is_attributed_to_exactly_one_screen(self) -> None:
        rows = [
            {"occ_symbol": "OK"},
            {"occ_symbol": "NOVOL", "volume": 0},
            {"occ_symbol": "CHEAP", "price": 0.05, "close": 0.05},
            {"occ_symbol": "WILD", "iv": 9.9},
            {"occ_symbol": "FAR", "strike": 210.0},
        ]
        result = screen_quotes(_chain(rows))

        assert result.passed.height == 1
        assert sum(result.dropped.values()) == 4

    def test_an_empty_chain_is_a_valid_input(self) -> None:
        result = screen_quotes(_chain([]).clear())
        assert isinstance(result, ScreenResult)
        assert result.passed.height == 0
        assert result.dropped == {}
