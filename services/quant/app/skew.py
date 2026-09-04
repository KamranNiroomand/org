"""The skew map — what option traders are paying for, per name, per day.

Price says what a stock did; the chain says what people pay to be
protected from what it does next. This module measures that as skew —
25-delta put IV against 25-delta call IV on one fixed expiry rule — and
crosses it with the stock's one-month return into four quadrants:

    CONTRARIAN BID  down on the month, calls bid   (the interesting one)
    CHASE           up, calls bid                  (crowded, late)
    HEDGED RALLY    up, puts bid                   (rally not trusted)
    FEAR            down, puts bid                 (not a bargain yet)

Positioning, not prediction: skew says what protection costs, never
where price goes. The level is structural; the CHANGE is the signal —
which is why every row carries its five-session delta, computed
retrospectively from the stored chains (the corpus already holds the
history a spreadsheet builder waits six weeks for).

The five disciplines, from the source's own hard lessons, are built in
rather than remembered:
  1. No index put/call ratio anywhere — the number is a windowing
     choice wearing a sentiment costume (86% of SPY put OI is sub-0.10
     delta lottery paper).
  2. skew_norm (÷ ATM IV) ranks names WITHIN a sector; skew_pts (raw
     vol points) compares ACROSS sectors — ATM IV varies ~3x between
     Utilities and Semis, and dividing by a small number manufactures
     fear.
  3. A sector reading without an agreement share is an average hiding
     two outliers; agreement prints beside every sector row, and fewer
     than MIN_SECTOR_NAMES usable names is no sector reading at all.
  4. One bad mark can invert a name (a utility once printed -1.43).
     |skew_norm| above SANITY_CEILING is disbelieved (`suspect`), and a
     thin chain's numbers are shown but flagged and excluded from every
     aggregate — named, never silently dropped.
  5. A dated catalyst is not sentiment. With no forward earnings
     calendar in this corpus, the tell is used directly: front-expiry
     ATM IV far above the measured expiry's means event premium inside
     the front (`event_flag`), corroborated by an earnings-classified
     document in the last five sessions.
"""

from __future__ import annotations

import math

import polars as pl

from .features import _closest_to_delta

#: Decision #1 — strikes equidistant in probability, held forever.
TARGET_DELTA = 0.25
#: Decision #2 — the expiry closest to this many calendar days out,
#: inside the band, for every name without exception.
TARGET_DTE = 45
DTE_BAND = (25, 70)
#: Decision #5 — fewer liquid strikes than this at the chosen expiry is
#: a chain too thin to believe.
MIN_STRIKES = 8
#: Decision #6 — above this, assume a bad mark, not a real reading.
SANITY_CEILING = 1.0
#: Trap #3 — below this many usable names, refuse the sector reading.
MIN_SECTOR_NAMES = 5
#: Trap #5 — front ATM IV this many vol points over the measured expiry
#: reads as event premium, not positioning.
EVENT_IV_GAP = 0.08
#: A "25-delta" leg that actually sits at 0.41 delta measures a
#: different thing entirely (found live: SPY's greeks were missing on
#: one expiry and the nearest put was 16 delta-points away). A leg
#: farther than this from its target is no leg at all.
DELTA_TOLERANCE = 0.10
#: The reference rows drawn beside sector bars — never inside sector math.
BENCHMARKS = ("SPY", "QQQ", "IWM")

SENTENCE_LEVELS = ((0.15, "heavily"), (0.05, "clearly"), (0.0, "slightly"))
RVOL_HEAVY, RVOL_LIGHT = 1.5, 0.6

_skew_cache: dict[tuple, dict] = {}


def _quadrant(ret_1m: float | None, skew_norm: float | None) -> str | None:
    if ret_1m is None or skew_norm is None:
        return None
    if skew_norm >= 0:
        return "hedged_rally" if ret_1m >= 0 else "fear"
    return "chase" if ret_1m >= 0 else "contrarian_bid"


def _band_expiries(chain: pl.DataFrame, trading_day: str) -> list[tuple[str, int]]:
    """Band expiries ordered by closeness to TARGET_DTE — the rule is
    still one rule (nearest to 45), but an expiry that cannot resolve
    its three legs yields to the next-nearest rather than yielding a
    blank row (found live: SPY's nearest expiry carried no call greeks
    at all while three perfectly good expiries sat beside it)."""
    from datetime import date

    day = date.fromisoformat(trading_day)
    out = []
    for expiry in chain.get_column("expiry").unique().to_list():
        dte = (date.fromisoformat(expiry) - day).days
        if DTE_BAND[0] <= dte <= DTE_BAND[1]:
            out.append((expiry, dte))
    return sorted(out, key=lambda e: abs(e[1] - TARGET_DTE))


def _leg_iv(at_expiry: pl.DataFrame, target: float, option_type: str) -> float | None:
    """The leg's IV — but only if the nearest contract is genuinely near
    the target delta. See DELTA_TOLERANCE."""
    leg = _closest_to_delta(at_expiry, target, option_type)
    if leg.height == 0:
        return None
    delta, iv = leg["delta"][0], leg["iv"][0]
    if delta is None or iv is None or abs(float(delta) - target) > DELTA_TOLERANCE:
        return None
    return float(iv)


def _front_atm_iv(chain: pl.DataFrame, trading_day: str, chosen_expiry: str) -> float | None:
    """ATM IV of the nearest expiry BEFORE the chosen one — the event tell."""
    from datetime import date

    day = date.fromisoformat(trading_day)
    fronts = [
        e
        for e in chain.get_column("expiry").unique().to_list()
        if e < chosen_expiry and (date.fromisoformat(e) - day).days >= 1
    ]
    if not fronts:
        return None
    front = min(fronts)
    atm = _closest_to_delta(chain.filter(pl.col("expiry") == front), 0.5, "call")
    if atm.height == 0:
        return None
    v = atm["iv"][0]
    return float(v) if v is not None else None


def _measure_name(chain: pl.DataFrame, trading_day: str) -> dict | None:
    """The three IVs and their derived skews for one name, one day."""
    liquid = chain.filter(pl.col("liquid") & pl.col("iv").is_not_null())
    if liquid.height == 0:
        return None
    resolved = None
    for expiry, dte in _band_expiries(liquid, trading_day):
        at_expiry = liquid.filter(pl.col("expiry") == expiry)
        atm_iv = _leg_iv(at_expiry, 0.5, "call")
        call_iv = _leg_iv(at_expiry, TARGET_DELTA, "call")
        put_iv = _leg_iv(at_expiry, -TARGET_DELTA, "put")
        if atm_iv is not None and call_iv is not None and put_iv is not None and atm_iv > 0:
            resolved = (expiry, dte, at_expiry, atm_iv, call_iv, put_iv)
            break
    if resolved is None:
        return None
    expiry, dte, at_expiry, atm_iv, call_iv, put_iv = resolved
    strikes = at_expiry.get_column("strike").n_unique()

    skew_pts = float(put_iv) - float(call_iv)
    skew_norm = skew_pts / float(atm_iv)
    front_iv = _front_atm_iv(liquid, trading_day, expiry)
    return {
        "expiry": expiry,
        "dte": dte,
        "atm_iv": round(float(atm_iv), 4),
        "put25_iv": round(float(put_iv), 4),
        "call25_iv": round(float(call_iv), 4),
        "skew_pts": round(skew_pts, 4),
        "skew_norm": round(skew_norm, 4),
        "chain_ok": strikes >= MIN_STRIKES,
        "suspect": abs(skew_norm) > SANITY_CEILING,
        "front_gap": round(float(front_iv) - float(atm_iv), 4) if front_iv is not None else None,
    }


#: Everyday names for the four corners — what each situation IS, not
#: trader shorthand. The enum stays stable for code; these are the
#: words a person reads.
QUADRANT_PLAIN = {
    "contrarian_bid": "falling, but quiet optimism is building",
    "chase": "rising, and the crowd is already in",
    "hedged_rally": "rising, but being insured against a fall",
    "fear": "falling, and getting scarier",
}


def _sentence(row: dict) -> str:
    """The fixed per-name read, in words a non-trader understands — no
    puts, calls, skew, or premium anywhere. The numbers live in the
    table's own columns; this sentence carries only meaning."""
    protecting = row["skew_norm"] >= 0
    mag = abs(row["skew_norm"])
    level = next(word for cutoff, word in SENTENCE_LEVELS if mag >= cutoff)
    what = (
        f"big investors are paying {level} more to protect against a fall"
        if protecting
        else f"big investors are paying {level} more to bet on a rise"
    )
    parts = [f"{row['symbol']} — {what}"]
    if row.get("sector_rank_pct") is not None and protecting:
        parts.append(f"more caution here than in {row['sector_rank_pct']:.0f}% of similar companies")
    ret = row.get("ret_1m")
    if ret is not None:
        direction = "up" if ret >= 0 else "down"
        vs = row.get("ret_1m_vs_spy")
        vs_txt = (
            f" ({'ahead of' if (vs or 0) >= 0 else 'behind'} the market by {abs(vs):.1f}%)"
            if vs is not None
            else ""
        )
        parts.append(f"the stock is {direction} {abs(ret):.1f}% this month{vs_txt}")
    rvol = row.get("rvol")
    if rvol is not None:
        vol_word = (
            "a busier-than-usual" if rvol >= RVOL_HEAVY else "a quiet" if rvol <= RVOL_LIGHT else "an ordinary"
        )
        parts.append(f"on {vol_word} trading day")
    quadrant = row.get("quadrant")
    if quadrant:
        parts.append(f"situation: {QUADRANT_PLAIN.get(quadrant, quadrant)}")
    if row.get("event_flag"):
        parts.append(
            "note: a company announcement is coming up, and some of this caution is just that date being priced in"
        )
    return ". ".join(parts) + "."


def _measure_day(trading_day: str) -> dict[str, dict]:
    """Every underlying's skew measurement for one day, keyed by symbol."""
    from .db import read_quotes, reading

    with reading() as conn:
        symbols = [
            r["underlying"]
            for r in conn.execute(
                "SELECT DISTINCT c.underlying FROM option_quotes q "
                "JOIN option_contracts c ON c.occ_symbol = q.occ_symbol "
                "WHERE q.trading_day = ? ORDER BY c.underlying",
                (trading_day,),
            )
        ]
    out: dict[str, dict] = {}
    for symbol in symbols:
        chain = read_quotes(symbol, trading_day)
        if chain.height == 0:
            continue
        m = _measure_name(chain, trading_day)
        if m is not None:
            out[symbol] = m
    return out


def skew_map(trading_day: str) -> dict:
    """The full board for one day: rows, sector aggregates, benchmarks."""
    from .db import read_bars, read_doc_mentions, read_symbol_sectors, reading

    with reading() as conn:
        fp_row = conn.execute(
            "SELECT COUNT(*) n, MAX(as_of) m FROM option_quotes WHERE trading_day = ?",
            (trading_day,),
        ).fetchone()
        prior_days = [
            r["trading_day"]
            for r in conn.execute(
                "SELECT DISTINCT trading_day FROM option_quotes WHERE trading_day < ? "
                "ORDER BY trading_day DESC LIMIT 5",
                (trading_day,),
            )
        ]
    fingerprint = (trading_day, fp_row["n"], fp_row["m"])
    cached = _skew_cache.get(fingerprint)
    if cached is not None:
        return cached
    if fp_row["n"] == 0:
        return {"day": trading_day, "rows": [], "sectors": [], "benchmarks": [], "median_skew_norm": None}

    today = _measure_day(trading_day)
    prior_day = prior_days[-1] if len(prior_days) == 5 else None
    prior = _measure_day(prior_day) if prior_day else {}

    sectors_by_symbol = read_symbol_sectors()

    # Price and volume context from bars, one scan — bounded to the ~90
    # calendar days the 1-month return and 20-session RVOL actually use;
    # unbounded, the 10-year backfill made this a full-corpus scan.
    from datetime import date as _date, timedelta as _td

    _start = (_date.fromisoformat(trading_day) - _td(days=90)).isoformat()
    bars = read_bars(symbols=sorted(today.keys()) + ["SPY"], start=_start, end=trading_day)
    ret_1m: dict[str, float] = {}
    rvol: dict[str, float] = {}
    for sym, group in bars.filter(pl.col("day") <= trading_day).sort("day").group_by(
        "symbol", maintain_order=True
    ):
        key = str(sym[0] if isinstance(sym, tuple) else sym)
        closes = group.get_column("close").to_list()
        vols = group.get_column("volume").to_list()
        days = group.get_column("day").to_list()
        # The bar 21 sessions back must actually BE about a month back.
        # Half this corpus carries gapped history (a lossy backfill left
        # 271 names with months missing), and counting positions across
        # a gap printed DELL at +271% "on the month" against a December
        # close. A return whose endpoints aren't a month apart is not a
        # 1-month return; better no dot than a fictional one.
        if len(closes) >= 22 and closes[-22] > 0:
            from datetime import date

            span = (date.fromisoformat(days[-1]) - date.fromisoformat(days[-22])).days
            if span <= 45:
                ret_1m[key] = (closes[-1] / closes[-22] - 1.0) * 100.0
        if len(vols) >= 21:
            avg = sum(vols[-21:-1]) / 20.0
            if avg > 0:
                rvol[key] = vols[-1] / avg
    spy_ret = ret_1m.get("SPY")

    # Earnings docs in the last 5 sessions — trap #5's corroboration.
    earnings_recent: set[str] = set()
    mentions = read_doc_mentions().filter(pl.col("event_type") == "earnings")
    if mentions.height > 0 and prior_day is not None:
        cutoff = f"{prior_day}T00:00:00Z"
        earnings_recent = set(
            mentions.filter(pl.col("published_at") >= cutoff).get_column("underlying").to_list()
        )

    rows: list[dict] = []
    for symbol, m in today.items():
        r = dict(m)
        r["symbol"] = symbol
        r["sector"] = sectors_by_symbol.get(symbol)
        r["ret_1m"] = round(ret_1m[symbol], 2) if symbol in ret_1m else None
        r["ret_1m_vs_spy"] = (
            round(ret_1m[symbol] - spy_ret, 2) if symbol in ret_1m and spy_ret is not None else None
        )
        r["rvol"] = round(rvol[symbol], 2) if symbol in rvol else None
        p = prior.get(symbol)
        # A change between two readings is only a signal when BOTH ends
        # are believable — a suspect endpoint manufactures the biggest
        # "movers" on the board (found live: a bad FDX mark printed a
        # -2.2 five-day swing straight to the top of the list).
        endpoints_usable = (
            p is not None
            and m["chain_ok"] and not m["suspect"]
            and p["chain_ok"] and not p["suspect"]
        )
        r["delta_5d"] = round(m["skew_norm"] - p["skew_norm"], 4) if endpoints_usable else None
        r["quadrant"] = _quadrant(r["ret_1m"], m["skew_norm"])
        r["event_flag"] = bool(
            (m["front_gap"] is not None and m["front_gap"] > EVENT_IV_GAP)
            or symbol in earnings_recent
        )
        rows.append(r)

    # Sector ranks and aggregates — usable rows only (trap #4's exclusion),
    # ETFs carry no sector (read_symbol_sectors excludes the pseudo ones).
    usable = [r for r in rows if r["chain_ok"] and not r["suspect"] and r["sector"]]
    by_sector: dict[str, list[dict]] = {}
    for r in usable:
        by_sector.setdefault(r["sector"], []).append(r)
    for sector, members in by_sector.items():
        ranked = sorted(members, key=lambda x: x["skew_norm"])
        n = len(ranked)
        for i, r in enumerate(ranked):
            r["sector_rank_pct"] = round(100.0 * i / (n - 1), 1) if n > 1 else 50.0
    sectors = []
    for sector, members in sorted(by_sector.items()):
        if len(members) < MIN_SECTOR_NAMES:
            continue
        pts = [r["skew_pts"] for r in members]
        lean_put = sum(1 for p in pts if p >= 0)
        agreement = max(lean_put, len(pts) - lean_put) / len(pts)
        sectors.append(
            {
                "sector": sector,
                "mean_skew_pts": round(sum(pts) / len(pts), 4),
                "agreement": round(agreement, 2),
                "n": len(pts),
                "excluded": sum(
                    1 for r in rows if r["sector"] == sector and (not r["chain_ok"] or r["suspect"])
                ),
            }
        )

    for r in rows:
        r.setdefault("sector_rank_pct", None)
        r["sentence"] = _sentence(r)

    benchmarks = [
        {"symbol": b, "skew_pts": today[b]["skew_pts"], "skew_norm": today[b]["skew_norm"]}
        for b in BENCHMARKS
        if b in today
    ]
    norms = sorted(r["skew_norm"] for r in rows if r["chain_ok"] and not r["suspect"])
    median = norms[len(norms) // 2] if norms else None

    result = {
        "day": trading_day,
        "prior_day": prior_day,
        # Usable names by |change| (the signal), then the flagged tail —
        # shown and named, never hidden, per the honesty rule.
        "rows": sorted(
            rows,
            key=lambda r: (not (r["chain_ok"] and not r["suspect"]), -abs(r["delta_5d"] or 0.0)),
        ),
        "sectors": sectors,
        "benchmarks": benchmarks,
        "median_skew_norm": median,
    }
    _skew_cache.clear()
    _skew_cache[fingerprint] = result
    return result
