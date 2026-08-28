"""Equal-risk position sizing — capital follows the stop, not the slot.

The book used to hand every position the same slice of capital. With
vol-scaled stops that is quietly unequal risk: a 20%-stop position and a
13%-stop position on equal capital put different dollar amounts on the
line, so the book's realized risk is dominated by whichever volatile
names happen to be in it. The engine's own sizing comment said
"volatility belongs in position sizing" — this module is that sentence,
implemented.

Fixed-fractional sizing, the standard practice: every position risks the
same dollars-at-stop. capital_i = dollar_risk / stop_pct_i, where
dollar_risk is chosen so a reference-stop position exactly fills an
equal-weight slice — the book's overall footprint stays what it was,
only the internal allocation moves from "same capital" to "same risk".

Clamped to [0.5, 1.5]x the equal slice: sizing is a tilt, not a lever.
An extremely quiet name must not swallow the book (its stop being tight
is partly an estimate, and estimates are exactly what position limits
exist to distrust), and an extremely wild one must not shrink to
irrelevance while still occupying a slot.
"""

from __future__ import annotations

#: The stop distance at which a position exactly fills its equal-weight
#: slice. Chosen at the middle of the observed stop range (5%..30% by
#: rule): tighter stops size up toward the 1.5x clamp, wider ones size
#: down toward 0.5x.
REFERENCE_STOP = 0.15

SIZE_CLAMP = (0.5, 1.5)


def equal_risk_capital(
    book_capital_e4: int,
    max_positions: int,
    picks: list[dict],
) -> dict[str, int]:
    """Per-symbol capital (E4) for `picks` = [{"symbol", "stop_pct"}].

    Pure arithmetic, no market access: callers supply the stop the
    engine actually intends to use, so sizing and stopping can never
    disagree about the risk. A missing or degenerate stop_pct sizes at
    the plain equal slice — unknown risk gets the neutral allocation,
    never a levered one.
    """
    if max_positions <= 0 or book_capital_e4 <= 0:
        return {p["symbol"]: 0 for p in picks}
    slice_e4 = book_capital_e4 / max_positions
    dollar_risk = slice_e4 * REFERENCE_STOP
    lo, hi = SIZE_CLAMP

    out: dict[str, int] = {}
    for p in picks:
        stop = p.get("stop_pct")
        if stop is None or not (0 < stop < 1):
            out[p["symbol"]] = int(round(slice_e4))
            continue
        raw = dollar_risk / stop
        out[p["symbol"]] = int(round(min(hi * slice_e4, max(lo * slice_e4, raw))))
    return out
