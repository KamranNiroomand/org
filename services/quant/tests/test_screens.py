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

from app.screens import MAX_IV, MIN_PRICE, ScreenResult, screen_quotes


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
        result = screen_quotes(_chain([self.SNDK]), prior_stats=None)

        assert result.passed.height == 0
        # Attributed to the first screen that fires — moneyness (1.27) —
        # and the extreme IV would catch it independently if the band moved.
        assert "moneyness" in result.dropped

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
    def test_moneyness_band_is_the_literature_s(self) -> None:
        # Prices set above intrinsic so the arbitrage screen stays quiet
        # and only the moneyness band decides — EDGE_LO is a call with $20
        # intrinsic, and pricing it at the fixture default of $5 would
        # (correctly) trip the bounds screen first.
        rows = [
            {"occ_symbol": "DEEP", "strike": 70.0, "price": 31.0, "close": 31.0},   # 0.70 — out
            {"occ_symbol": "EDGE_LO", "strike": 80.0, "price": 21.0, "close": 21.0},  # 0.80 — in, inclusive
            {"occ_symbol": "ATM", "strike": 100.0},
            {"occ_symbol": "EDGE_HI", "strike": 120.0},  # 1.20 — in
            {"occ_symbol": "FAR", "strike": 127.0},   # 1.27 — out (the incident's)
        ]
        result = screen_quotes(_chain(rows))
        kept = set(result.passed["occ_symbol"].to_list())
        assert kept == {"EDGE_LO", "ATM", "EDGE_HI"}

    def test_zero_volume_is_rejected(self) -> None:
        result = screen_quotes(_chain([{"volume": 0}]))
        assert result.passed.height == 0
        assert result.dropped == {"zero_volume": 1}

    def test_penny_prints_are_rejected_at_the_literature_s_eighth(self) -> None:
        result = screen_quotes(_chain([{"price": 0.10, "close": 0.10}]))
        assert result.passed.height == 0
        assert result.dropped == {"min_price": 1}
        assert MIN_PRICE == 0.125

    def test_extreme_iv_is_rejected(self) -> None:
        result = screen_quotes(_chain([{"iv": MAX_IV + 0.01}]))
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
            {"occ_symbol": "FAR", "strike": 200.0},
        ]
        result = screen_quotes(_chain(rows))

        assert result.passed.height == 1
        assert sum(result.dropped.values()) == 4

    def test_an_empty_chain_is_a_valid_input(self) -> None:
        result = screen_quotes(_chain([]).clear())
        assert isinstance(result, ScreenResult)
        assert result.passed.height == 0
        assert result.dropped == {}
