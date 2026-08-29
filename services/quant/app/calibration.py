"""Brier-scoring the panel's probabilities against what happened.

Each specialist turn since the superforecaster upgrade carries probUp —
P(symbol outperforms its own sector over the next 21 sessions) — stated
in the prompt as "the number you would want to be graded on". This is
the grader. The Brier score is mean (p - outcome)^2: 0 is prophecy,
0.25 is what coin-flipping at p=0.5 earns, and a specialist ABOVE 0.25
is actively miscalibrated — worse than admitting ignorance.

The outcome is exactly the question's own terms: the symbol's forward
return over the next `horizon` sessions, versus the LEAVE-ONE-OUT mean
of its sector peers' forward returns from the same day. Same-sector,
same-window, own-return excluded — the same discipline as the sector
features, and for the same reason: a specialist must not be graded up
for a sector-wide tide it never predicted.

Only turns whose full horizon has elapsed are scoreable; the rest are
pending, reported as such rather than dropped silently. With the
probabilities starting 2026-08-28, the first scores mature in late
September — this module exists now so that maturation is automatic
rather than a future project.
"""

from __future__ import annotations

import polars as pl

HORIZON = 21


def brier_scores(
    turns: list[dict],
    bars: pl.DataFrame,
    sectors: dict[str, str],
    horizon: int = HORIZON,
) -> dict:
    """Per-specialist calibration from turns = [{specialist, symbol, day,
    prob_up}] against `bars` (symbol/day/close) and a symbol->sector map.
    """
    out: dict = {"horizon_days": horizon, "scoreable": 0, "pending": 0, "specialists": {}}
    if not turns or bars.height == 0:
        out["pending"] = len(turns)
        return out

    days = sorted(bars.get_column("day").unique().to_list())
    day_index = {d: i for i, d in enumerate(days)}

    # Forward return per (symbol, first day at-or-after the turn's day).
    closes: dict[str, dict[str, float]] = {}
    for sym, group in bars.sort("day").group_by("symbol", maintain_order=True):
        key = str(sym[0] if isinstance(sym, tuple) else sym)
        closes[key] = dict(zip(group.get_column("day").to_list(), group.get_column("close").to_list()))

    def forward_return(symbol: str, start_day: str) -> float | None:
        idx = day_index.get(start_day)
        if idx is None or idx + horizon >= len(days):
            return None
        c = closes.get(symbol, {})
        start, end = c.get(days[idx]), c.get(days[idx + horizon])
        if start is None or end is None or start <= 0:
            return None
        return end / start - 1.0

    # A turn's day may be a non-session (weekend read) — snap forward.
    def session_at_or_after(day: str) -> str | None:
        for d in days:
            if d >= day:
                return d
        return None

    per_spec: dict[str, list[float]] = {}
    for t in turns:
        prob = t.get("prob_up")
        symbol = t.get("symbol")
        spec = t.get("specialist", "unknown")
        start = session_at_or_after(str(t.get("day", "")))
        if prob is None or symbol is None or start is None:
            out["pending"] += 1
            continue
        own = forward_return(symbol, start)
        if own is None:
            out["pending"] += 1
            continue
        sector = sectors.get(symbol)
        peers = [
            s for s, sec in sectors.items() if sec == sector and s != symbol and s in closes
        ] if sector else []
        peer_rets = [r for r in (forward_return(s, start) for s in peers) if r is not None]
        if len(peer_rets) < 3:
            # Too few peers to define "its sector" — grade against zero
            # excess instead of pretending three names are a sector? No:
            # abstain. A grade against a fake benchmark is worse than no
            # grade.
            out["pending"] += 1
            continue
        outcome = 1.0 if own > sum(peer_rets) / len(peer_rets) else 0.0
        per_spec.setdefault(spec, []).append((float(prob) - outcome) ** 2)
        out["scoreable"] += 1

    for spec, sqerrs in per_spec.items():
        out["specialists"][spec] = {
            "n": len(sqerrs),
            "brier": round(sum(sqerrs) / len(sqerrs), 4),
        }
    if out["scoreable"] > 0:
        all_errs = [e for errs in per_spec.values() for e in errs]
        out["overall_brier"] = round(sum(all_errs) / len(all_errs), 4)
        out["coin_flip_reference"] = 0.25
    return out
