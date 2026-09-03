"""The return-agreement gate: a vendor disagreement that would corrupt
training must fail the gate; harmless uniform scaling must pass it."""

from app.history_backfill import MIN_AGREE, OVERLAP_SESSIONS, _gate


def _days(n: int) -> list[str]:
    # Simple synthetic calendar: enough distinct sorted keys.
    return [f"2026-{1 + i // 28:02d}-{1 + i % 28:02d}" for i in range(n)]


def _series(days, start=100.0, drift=0.001):
    out, px = {}, start
    for d in days:
        px *= 1 + drift
        out[d] = px
    return out


class TestGate:
    def test_identical_returns_pass_even_at_a_different_price_level(self) -> None:
        days = _days(120)
        poly = _series(days)
        # Uniform 2x scaling: levels differ, every return identical.
        yahoo = [{"day": d, "close": p * 2.0} for d, p in poly.items()]
        ok, why = _gate(yahoo, poly)
        assert ok, why

    def test_an_unshared_split_fails_the_gate(self) -> None:
        days = _days(120)
        poly = _series(days)
        yahoo_rows = []
        for i, (d, p) in enumerate(sorted(poly.items())):
            # Yahoo missed a 2:1 split halfway: its prices double from there,
            # which shows up as one +100% fake return.
            factor = 2.0 if i >= 60 else 1.0
            yahoo_rows.append({"day": d, "close": p * factor})
        ok, why = _gate(yahoo_rows, poly)
        # One bad day out of ~119 would pass a 98% percentage bar — the
        # gross-disagreement rule exists precisely for this case.
        assert not ok
        assert "gross" in why

    def test_thin_coverage_fails(self) -> None:
        days = _days(120)
        poly = _series(days)
        yahoo = [{"day": d, "close": p} for d, p in list(poly.items())[:50]]
        ok, why = _gate(yahoo, poly)
        assert not ok
        assert "coverage" in why

    def test_systematic_return_disagreement_fails(self) -> None:
        days = _days(120)
        poly = _series(days, drift=0.001)
        # Different drift every day: returns disagree by 30 bps daily.
        yahoo_prices = _series(days, drift=0.004)
        yahoo = [{"day": d, "close": p} for d, p in yahoo_prices.items()]
        ok, why = _gate(yahoo, poly)
        assert not ok
        assert "agree" in why

    def test_too_little_polygon_history_refuses_to_judge(self) -> None:
        days = _days(30)
        poly = _series(days)
        yahoo = [{"day": d, "close": p} for d, p in poly.items()]
        ok, why = _gate(yahoo, poly)
        assert not ok
        assert "sessions" in why
