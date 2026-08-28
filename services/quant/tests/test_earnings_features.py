"""The earnings-drift panel's contract: the event stamps the session the
leakage guard says (after-close reports belong to the NEXT session), the
day counter counts sessions, and past the 63-session horizon the columns
go null — "no recent earnings" is no information, never a zero."""

import polars as pl
import pytest

from app.features import EARNINGS_FEATURE_COLS, EARNINGS_HORIZON, earnings_feature_panel


@pytest.fixture()
def corpus(monkeypatch):
    """A tiny corpus: AAA reports after Tuesday's close (positive wire
    coverage), BBB has non-earnings news only."""
    days = [f"2026-06-{d:02d}" for d in (1, 2, 3, 4, 5, 8, 9)]

    def fake_mentions():
        return pl.DataFrame(
            {
                "underlying": ["AAA", "AAA", "BBB"],
                # 21:30 ET Tuesday 06-02 = 01:30 UTC Wednesday — the
                # guard must land this on Wednesday 06-03.
                "published_at": ["2026-06-03T01:30:00Z", "2026-06-03T01:35:00Z", "2026-06-02T14:00:00Z"],
                "sentiment": ["positive", "neutral", "negative"],
                "event_type": ["earnings", "earnings", "regulatory"],
                "source": ["polygon_news"] * 3,
            }
        )

    class _Row(dict):
        def __getitem__(self, k):
            return dict.__getitem__(self, k)

    class _Conn:
        def execute(self, q):
            class _Res:
                def fetchone(self_inner):
                    return _Row({"n": 3, "m": "2026-06-09T00:00:00Z"})

                def fetchall(self_inner):
                    return []

            return _Res()

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    from contextlib import contextmanager

    @contextmanager
    def fake_reading():
        yield _Conn()

    monkeypatch.setattr("app.db.read_doc_mentions", fake_mentions)
    monkeypatch.setattr("app.db.reading", fake_reading)
    import app.features as F

    F._earnings_panel_cache.clear()
    return days


def test_event_day_and_session_counting(corpus):
    panel = earnings_feature_panel(trading_days=corpus)
    aaa = {r["day"]: r for r in panel.filter(pl.col("symbol") == "AAA").to_dicts()}
    # Before the report: nothing.
    assert aaa["2026-06-02"]["days_since_earnings"] is None
    # The after-close Tuesday report is Wednesday's information.
    assert aaa["2026-06-03"]["days_since_earnings"] == 0.0
    assert aaa["2026-06-03"]["last_earnings_sent"] == pytest.approx(0.5)  # mean(+1, 0)
    # Sessions, not calendar days: Fri 06-05 is 2 sessions after Wed.
    assert aaa["2026-06-05"]["days_since_earnings"] == 2.0
    # Weekend skipped: Mon 06-08 is 3 sessions after.
    assert aaa["2026-06-08"]["days_since_earnings"] == 3.0
    assert aaa["2026-06-08"]["last_earnings_sent"] == pytest.approx(0.5)


def test_non_earnings_events_do_not_count(corpus):
    panel = earnings_feature_panel(trading_days=corpus)
    assert panel.filter(pl.col("symbol") == "BBB").height == 0


def test_horizon_expires(corpus):
    # Stretch the calendar far past the horizon: the event's columns
    # must go null, not linger as a stale zero-day signal.
    days = corpus + [f"2026-09-{d:02d}" for d in range(1, 29)] + [f"2026-10-{d:02d}" for d in range(1, 29)] + [f"2026-11-{d:02d}" for d in range(1, 15)]
    import app.features as F

    F._earnings_panel_cache.clear()
    panel = earnings_feature_panel(trading_days=days)
    aaa = {r["day"]: r for r in panel.filter(pl.col("symbol") == "AAA").to_dicts()}
    last = days[-1]
    assert len(days) - days.index("2026-06-03") - 1 > EARNINGS_HORIZON
    assert aaa[last]["days_since_earnings"] is None
    assert aaa[last]["last_earnings_sent"] is None


def test_declared_schema_is_produced_schema(corpus):
    panel = earnings_feature_panel(trading_days=corpus)
    assert panel.columns == ["symbol", "day", *EARNINGS_FEATURE_COLS]
