"""Crowding guard — the diversification the sector cap cannot see.

The sector cap stops eight positions wearing one GICS label; it cannot
stop eight positions wearing one *factor*. An AI-infrastructure book
spread across Information Technology, Communication Services, and
Industrials passes every sector check and still moves as a single bet —
the equal-weight-diversification illusion the crowding literature keeps
re-documenting, and the exact shape of this book's own A/B/C incident.

The measure is deliberately primitive: the candidate's average pairwise
correlation of daily log returns against the names already held, over a
63-session window. No factor model, no shrinkage — with ~10 positions
and a quarter of daily data, a plain Pearson mean is as much structure
as the sample supports, and it is auditable by eye.

The engine rejects a candidate whose average correlation with the book
exceeds its threshold once the book holds enough names for the average
to mean something. Fail-open like every overlay: too little data → no
score → no veto.
"""

from __future__ import annotations

import math

import polars as pl

CORR_WINDOW = 63
#: Fewer overlapping sessions than this and a correlation is mostly
#: sampling noise wearing a decimal point.
MIN_OVERLAP = 40
#: Below this many held names an "average correlation with the book"
#: is an anecdote, not a statistic.
MIN_HELD = 3


def _daily_log_returns(bars: pl.DataFrame, window: int) -> dict[str, dict[str, float]]:
    """symbol -> {day -> log return}, restricted to the trailing window."""
    out: dict[str, dict[str, float]] = {}
    for sym, group in bars.sort("day").group_by("symbol", maintain_order=True):
        days = group.get_column("day").to_list()
        closes = group.get_column("close").to_list()
        rets = {
            days[i + 1]: math.log(closes[i + 1] / closes[i])
            for i in range(len(closes) - 1)
            if closes[i] > 0 and closes[i + 1] > 0
        }
        tail = dict(sorted(rets.items())[-window:])
        if tail:
            out[str(sym[0] if isinstance(sym, tuple) else sym)] = tail
    return out


def _pearson(a: dict[str, float], b: dict[str, float]) -> float | None:
    days = sorted(set(a) & set(b))
    if len(days) < MIN_OVERLAP:
        return None
    xs = [a[d] for d in days]
    ys = [b[d] for d in days]
    n = len(days)
    mx = sum(xs) / n
    my = sum(ys) / n
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    sxx = sum((x - mx) ** 2 for x in xs)
    syy = sum((y - my) ** 2 for y in ys)
    if sxx <= 0 or syy <= 0:
        return None
    return sxy / math.sqrt(sxx * syy)


def crowding_scores(
    bars: pl.DataFrame,
    held: list[str],
    candidates: list[str],
    window: int = CORR_WINDOW,
) -> dict[str, dict]:
    """candidate -> {avg_corr, n_held_used} where computable.

    A candidate is scored only against held names with enough overlapping
    history; when fewer than MIN_HELD are usable, the candidate gets no
    score at all — the guard abstains rather than vetoing on noise.
    """
    rets = _daily_log_returns(bars, window)
    out: dict[str, dict] = {}
    for cand in candidates:
        cand_rets = rets.get(cand)
        if cand_rets is None:
            continue
        corrs = []
        for h in held:
            if h == cand:
                continue
            h_rets = rets.get(h)
            if h_rets is None:
                continue
            c = _pearson(cand_rets, h_rets)
            if c is not None:
                corrs.append(c)
        if len(corrs) >= MIN_HELD:
            out[cand] = {
                "avg_corr": round(sum(corrs) / len(corrs), 4),
                "n_held_used": len(corrs),
            }
    return out
