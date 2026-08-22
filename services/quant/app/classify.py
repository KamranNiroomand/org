"""Universe classification: separating common stock from the SPAC-derivative
noise (warrants, units, rights) that the exchange symbol directories name
alongside it.

Nasdaq's own listed-symbol directories mark preferreds, warrants, units, and
rights only on the OTHER-listed (NYSE/AMEX) tape, using a dotted suffix
(`.W`, `.U`, `.R`, `.P*`). The Nasdaq-listed tape carries no such marker: a
warrant is just the common stock's ticker with a bare letter appended
(`AACI` -> `AACIW`), indistinguishable by shape alone from a real, unrelated
company that happens to have a similarly-shaped ticker — stripping the
trailing letter off `TKR` ("Timken Company") lines up the real symbol `TK`
("Teekay Corporation Ltd."), two unrelated companies. Confirmed against this
app's own real universe: ticker-shape alone flags 817 candidates, of which
about a quarter (198) are exactly this kind of coincidental collision.

The name is what actually distinguishes them: a warrant/unit/right almost
always carries the *same* company name as its common stock, sometimes minus
a share-class suffix ("Armada Acquisition Corp. III Class A" / "Armada
Acquisition Corp. III"). Fuzzy string similarity after stripping the
boilerplate that legitimately varies between the two rows (share class,
corporate suffix, punctuation) is what `classify_universe` uses to tell a
real derivative from a same-shaped coincidence.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from rapidfuzz import fuzz

#: Nasdaq's own single-letter derivative suffixes. `P` (preferred) is
#: deliberately excluded: preferred tickers vary far more in how their name
#: relates to the common's (series letters, dividend rate spelled out) and
#: are already caught for the OTHER-listed tape by the dotted-suffix filter
#: in `universe.ts` — false positives here would cost more than the
#: warrants/units/rights this module is actually aimed at.
DERIVATIVE_SUFFIXES = ("W", "U", "R")

_KIND_BY_SUFFIX = {"W": "warrant", "U": "unit", "R": "right"}

#: Below this token-sort ratio (0-100, rapidfuzz's normalized edit-distance
#: family), two names are treated as different companies rather than the same
#: company under two listing rows. Tuned against this app's real universe: in
#: a manual audit of 198 real coincidental collisions (e.g. "Timken Company"
#: vs "Teekay Corporation Ltd."), every pair scored well under 60, while true
#: derivative pairs scored 100 (identical after normalization) or in the high
#: 90s (minor punctuation/spacing differences) — no observed pair sits in
#: between, so this threshold has no known false positive or negative to
#: trade off against.
NAME_SIMILARITY_THRESHOLD = 90

_CORPORATE_SUFFIXES = re.compile(
    r"\b("
    r"class\s+[a-z0-9]+"
    r"|inc(orporated)?"
    r"|co(rp(oration)?)?"
    r"|company"
    r"|ltd|limited"
    r"|plc|l\.?p\.?|n\.?v\.?|s\.?a\.?"
    r"|group|holdings?|the"
    r")\b\.?",
    re.IGNORECASE,
)
_PUNCTUATION = re.compile(r"[^\w\s]")
_WHITESPACE = re.compile(r"\s+")


def normalize_name(name: str) -> str:
    """Strips the boilerplate that legitimately differs between a company's
    common stock and its own warrant/unit/right listing, so the two rows'
    names compare on the part that actually identifies the company.
    """
    stripped = _CORPORATE_SUFFIXES.sub(" ", name.lower())
    stripped = _PUNCTUATION.sub(" ", stripped)
    return _WHITESPACE.sub(" ", stripped).strip()


@dataclass(frozen=True)
class SymbolRow:
    symbol: str
    name: str


def classify_universe(rows: list[SymbolRow]) -> dict[str, str]:
    """Returns, for every row that is a warrant/unit/right of another row in
    the same batch, `{symbol: "warrant" | "unit" | "right"}`. A symbol absent
    from the result is common stock as far as this function can tell — never
    included with a "common" value, so a caller only has to check membership.

    A suffix match alone never excludes: `AACIW` is only classified once a
    matching `AACI` row exists AND the two names are similar enough, so a
    standalone stock that happens to end in W/U/R (`GROW`, "U.S. Global
    Investors, Inc. Class A", no separate `GRO` row in the batch) is never
    touched, and a same-shaped coincidence between two unrelated real
    companies (`TKR`/`TK`) is correctly left alone too.
    """
    by_symbol = {row.symbol: row for row in rows}
    normalized_cache: dict[str, str] = {}

    def normalized(symbol: str) -> str:
        if symbol not in normalized_cache:
            normalized_cache[symbol] = normalize_name(by_symbol[symbol].name)
        return normalized_cache[symbol]

    excluded: dict[str, str] = {}
    for row in rows:
        symbol = row.symbol
        if "-" in symbol or len(symbol) < 2:
            continue
        suffix = symbol[-1]
        if suffix not in DERIVATIVE_SUFFIXES:
            continue

        base_symbol = symbol[:-1]
        if base_symbol not in by_symbol:
            continue

        similarity = fuzz.token_sort_ratio(normalized(symbol), normalized(base_symbol))
        if similarity >= NAME_SIMILARITY_THRESHOLD:
            excluded[symbol] = _KIND_BY_SUFFIX[suffix]

    return excluded
