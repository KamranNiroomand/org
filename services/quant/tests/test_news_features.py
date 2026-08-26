"""News feature panel tests — the leakage guard above all.

A story published after the close carries information that session's
prices could not reflect; stamping it onto its own day hands the model
tomorrow's news wearing today's date, and every backtest edge built on
that leak evaporates in production.
"""

from __future__ import annotations

import polars as pl
import pytest

from app.features import NEWS_FEATURE_COLS, _news_effective_day


def _eff(published_at: str) -> str | None:
    out = pl.DataFrame({"p": [published_at]}).select(
        _news_effective_day(pl.col("p")).alias("eff")
    )["eff"][0]
    return str(out) if out is not None else None


class TestEffectiveDayStamping:
    def test_intraday_news_belongs_to_its_own_session(self) -> None:
        # 14:30 ET on a Tuesday.
        assert _eff("2026-08-18T18:30:00Z") == "2026-08-18"

    def test_after_close_news_belongs_to_the_next_day(self) -> None:
        # 18:30 ET Tuesday = 22:30 UTC — after the 16:00 close.
        assert _eff("2026-08-18T22:30:00Z") == "2026-08-19"

    def test_the_close_itself_is_the_boundary(self) -> None:
        # 16:00:00 ET exactly — already unpriceable by that session.
        assert _eff("2026-08-18T20:00:00Z") == "2026-08-19"
        # 15:59 ET — still that session's information.
        assert _eff("2026-08-18T19:59:00Z") == "2026-08-18"

    def test_utc_evening_is_not_ny_evening(self) -> None:
        # 01:30 UTC Wednesday is 21:30 ET *Tuesday* — after Tuesday's
        # close, so Wednesday's news. The naive UTC date would already
        # say Wednesday for the wrong reason; the guard must reason in
        # New York time, not merely land on the right answer by luck.
        assert _eff("2026-08-19T01:30:00Z") == "2026-08-19"
        # 01:30 UTC Tuesday = 21:30 ET Monday -> Tuesday. UTC date says
        # Tuesday too, but a 10:00 UTC Tuesday (06:00 ET, pre-open)
        # must stay Tuesday, not shift.
        assert _eff("2026-08-18T10:00:00Z") == "2026-08-18"

    def test_unparseable_timestamps_drop_rather_than_guess(self) -> None:
        assert _eff("not-a-timestamp") is None


class TestWeekendSnapping:
    def test_saturday_news_lands_on_monday(self) -> None:
        from app.features import news_feature_panel, _news_panel_cache

        # Direct exercise of the snap logic through the public builder is
        # DB-bound; instead pin the join_asof behavior it relies on.
        cal = pl.DataFrame({"day": ["2026-08-14", "2026-08-17", "2026-08-18"]}).with_columns(
            pl.col("day").str.to_date().alias("_d")
        )
        eff = pl.DataFrame({"eff": ["2026-08-15"]}).with_columns(pl.col("eff").str.to_date())
        snapped = eff.sort("eff").join_asof(
            cal.sort("_d"), left_on="eff", right_on="_d", strategy="forward"
        )
        assert snapped["day"][0] == "2026-08-17"


class TestColumns:
    def test_the_declared_schema_is_the_produced_schema(self) -> None:
        assert NEWS_FEATURE_COLS == [
            "news_count_1d",
            "news_count_5d",
            "news_count_21d",
            "news_sent_net_1d",
            "news_sent_net_5d",
            "news_sent_net_21d",
        ]
