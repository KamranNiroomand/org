"""The skew map's contract: put-rich chains read positive, the fixed
expiry rule holds, thin chains and insane numbers are flagged rather
than believed, event premium is not sentiment, and all four quadrants
land where the framework says."""

import polars as pl
import pytest

from app.skew import (
    DTE_BAND,
    MIN_STRIKES,
    SANITY_CEILING,
    _measure_name,
    _quadrant,
    _sentence,
)

DAY = "2026-08-14"


def _chain(expiry="2026-09-25", put_iv=0.40, call_iv=0.30, atm_iv=0.32, strikes=12, extra=None):
    rows = []
    for i in range(strikes):
        strike = 80 + i * 5
        # spread deltas across the strip so 0.5 / ±0.25 targets resolve
        call_delta = max(0.05, 0.95 - i * (0.9 / max(1, strikes - 1)))
        iv_call = atm_iv if abs(call_delta - 0.5) < 0.06 else call_iv
        rows.append({"expiry": expiry, "type": "call", "strike": float(strike), "delta": call_delta, "iv": iv_call, "liquid": True})
        rows.append({"expiry": expiry, "type": "put", "strike": float(strike), "delta": call_delta - 1.0, "iv": put_iv, "liquid": True})
    if extra:
        rows.extend(extra)
    return pl.DataFrame(rows)


class TestMeasurement:
    def test_put_rich_chain_reads_positive_and_normalization_divides_by_atm(self):
        m = _measure_name(_chain(), DAY)
        assert m is not None
        assert m["skew_pts"] == pytest.approx(0.40 - 0.30, abs=1e-6)
        assert m["skew_norm"] == pytest.approx(m["skew_pts"] / m["atm_iv"], abs=1e-4)
        assert m["chain_ok"] is True
        assert m["suspect"] is False

    def test_expiry_rule_picks_nearest_to_45_dte_inside_the_band(self):
        both = pl.concat([_chain(expiry="2026-09-25"), _chain(expiry="2026-10-16", put_iv=0.99)])
        m = _measure_name(both, DAY)
        # 2026-09-25 is 42 DTE from 08-14; 10-16 is 63 — the rule takes 42.
        assert m["expiry"] == "2026-09-25"
        assert DTE_BAND[0] <= m["dte"] <= DTE_BAND[1]

    def test_out_of_band_expiries_yield_nothing(self):
        assert _measure_name(_chain(expiry="2026-08-21"), DAY) is None  # 7 DTE

    def test_thin_chain_is_flagged_not_dropped(self):
        m = _measure_name(_chain(strikes=MIN_STRIKES - 2), DAY)
        assert m is not None
        assert m["chain_ok"] is False

    def test_insane_skew_is_disbelieved(self):
        m = _measure_name(_chain(put_iv=0.90, call_iv=0.20, atm_iv=0.30), DAY)
        assert abs(m["skew_norm"]) > SANITY_CEILING
        assert m["suspect"] is True

    def test_front_expiry_event_premium_is_measured(self):
        front = _chain(expiry="2026-08-28", put_iv=0.60, call_iv=0.60, atm_iv=0.55)
        both = pl.concat([front, _chain(expiry="2026-09-25")])
        m = _measure_name(both, DAY)
        assert m["expiry"] == "2026-09-25"
        assert m["front_gap"] == pytest.approx(0.55 - m["atm_iv"], abs=1e-4)


class TestQuadrants:
    def test_all_four_corners(self):
        assert _quadrant(-5.0, -0.1) == "contrarian_bid"
        assert _quadrant(5.0, -0.1) == "chase"
        assert _quadrant(5.0, 0.1) == "hedged_rally"
        assert _quadrant(-5.0, 0.1) == "fear"

    def test_missing_inputs_refuse_a_verdict(self):
        assert _quadrant(None, 0.1) is None
        assert _quadrant(5.0, None) is None


class TestSentence:
    def test_reads_in_the_fixed_order_and_names_the_quadrant(self):
        row = {
            "symbol": "MU", "skew_norm": 0.18, "sector_rank_pct": 82.0,
            "ret_1m": 6.2, "ret_1m_vs_spy": 3.1, "rvol": 1.8,
            "quadrant": "hedged_rally", "event_flag": False,
        }
        s = _sentence(row)
        assert s.startswith("MU — big investors are paying heavily more to protect against a fall")
        assert "82% of similar companies" in s
        assert "up 6.2% this month" in s
        assert "busier-than-usual" in s
        assert "insured against a fall" in s
        # The jargon ban, as an assertion: none of these words may appear.
        for banned in ("puts", "calls", "skew", "premium", "volatility"):
            assert banned not in s.lower()

    def test_event_flag_appends_the_caveat(self):
        row = {"symbol": "X", "skew_norm": 0.02, "sector_rank_pct": None,
               "ret_1m": None, "rvol": None, "quadrant": None, "event_flag": True}
        assert "announcement is coming up" in _sentence(row)


def test_every_declared_ride_along_panel_is_joined_at_scoring_time():
    """Train/serve symmetry as an invariant: any feature family a
    manifest can declare must have a matching join in _forecast_inputs —
    the trial-24 review caught sector columns trained-but-not-served."""
    import inspect

    from app import rank
    from app.features import EARNINGS_FEATURE_COLS, NEWS_FEATURE_COLS, SECTOR_FEATURE_COLS

    src = inspect.getsource(rank._forecast_inputs)
    for family, name in [
        (NEWS_FEATURE_COLS, "NEWS_FEATURE_COLS"),
        (SECTOR_FEATURE_COLS, "SECTOR_FEATURE_COLS"),
        (EARNINGS_FEATURE_COLS, "EARNINGS_FEATURE_COLS"),
    ]:
        assert name in src, f"_forecast_inputs has no scoring join for {name}"
