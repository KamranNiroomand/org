"""Deep-history bars backfill — free data admitted only through a return-agreement gate.

The corpus's binding constraint is time, not width: ~2 years of Polygon
bars is ~60 independent 5-day periods, and no model grows past its data.
The paid plan caps history at 2 years; Yahoo's public chart endpoint
serves 10. The catch is silent adjustment mismatches (splits, dividends,
symbol changes) — the exact class of quiet data bug this system has been
burned by — so nothing is trusted, everything is audited:

**The gate, per symbol.** Take every day BOTH vendors cover (up to the
last 250 sessions). Require (a) Yahoo covers >= 90% of Polygon's days,
and (b) on >= 98% of shared days the two vendors' daily close-to-close
returns agree within 20 bps. Returns, not levels: a uniform adjustment
factor cancels in a return, so the comparison ignores harmless scaling
and catches exactly the harmful case — a split or dividend applied by
one vendor and not the other, which shows up as one huge fake return.
A symbol failing the gate contributes NOTHING; there is no partial
credit and no manual override.

**What gets written.** Only days strictly BEFORE the symbol's earliest
Polygon bar, tagged by insertion only (the schema has no vendor column;
recency is the provenance — every serving-time read touches recent days,
which remain 100% Polygon). Training features are return-based, so the
seam between vendors contributes one ordinary-looking return computed
across it — from Yahoo's last gated close to Polygon's first, both
split-adjusted by construction of the gate.

**Known, accepted limitation — survivorship.** Extending today's
universe backward trains on names that survived until today; a 2016
cross-section is missing that year's failures. This biases absolute
backtest returns optimistic but affects daily cross-sectional rank IC
much less (ranking within the surviving set is still a fair contest per
day). Recorded here so nobody mistakes the deeper corpus for an
unbiased one.

Run ON THE RUNNER (the corpus owner):
    uv run python -m app.history_backfill --dry-run   # gate + report only
    uv run python -m app.history_backfill --write     # insert gated rows
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

DB = Path.home() / ".org" / "market" / "market.db"
UA = {"User-Agent": "Mozilla/5.0"}
RANGE = "10y"
#: Gate thresholds — see module docstring.
MIN_COVERAGE = 0.90
MIN_AGREE = 0.98
RETURN_TOLERANCE = 0.002
#: Any single shared-day return disagreement this large rejects the whole
#: symbol — the one-missed-split case a percentage bar cannot catch.
GROSS_DISAGREEMENT = 0.05
OVERLAP_SESSIONS = 250
THROTTLE_S = 0.4


def _fetch_yahoo(symbol: str) -> list[dict] | None:
    """10y of daily bars from Yahoo's chart endpoint, oldest first.

    Yahoo's OHLC are split-adjusted (like Polygon `adjusted=true`);
    `adjclose` is additionally dividend-adjusted and is stored into the
    corpus's own `adj_close_e4` slot. Symbols Yahoo spells differently
    (share classes use a dash: BRK.B -> BRK-B) are translated; anything
    else that 404s is simply reported unfetchable.
    """
    ysym = symbol.replace(".", "-")
    url = (
        f"https://query1.finance.yahoo.com/v8/finance/chart/{ysym}"
        f"?range={RANGE}&interval=1d&events=split"
    )
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
            payload = json.load(r)
    except Exception:
        return None
    result = (payload.get("chart") or {}).get("result") or []
    if not result:
        return None
    node = result[0]
    ts = node.get("timestamp") or []
    quote = (node.get("indicators", {}).get("quote") or [{}])[0]
    adj = (node.get("indicators", {}).get("adjclose") or [{}])[0].get("adjclose") or []
    rows: list[dict] = []
    for i, t in enumerate(ts):
        o, h, low, c = (quote.get(k, [None] * len(ts))[i] for k in ("open", "high", "low", "close"))
        v = (quote.get("volume") or [None] * len(ts))[i]
        if None in (o, h, low, c) or c <= 0:
            continue
        rows.append(
            {
                "day": datetime.fromtimestamp(t, tz=timezone.utc).date().isoformat(),
                "open": float(o),
                "high": float(h),
                "low": float(low),
                "close": float(c),
                "adj_close": float(adj[i]) if i < len(adj) and adj[i] else None,
                "volume": int(v or 0),
            }
        )
    return rows or None


def _gate(yahoo: list[dict], polygon: dict[str, float]) -> tuple[bool, str]:
    """The return-agreement gate. `polygon` maps day -> close (dollars)."""
    poly_days = sorted(polygon)[-OVERLAP_SESSIONS:]
    if len(poly_days) < 60:
        return False, f"only {len(poly_days)} polygon sessions to compare against"
    ymap = {r["day"]: r["close"] for r in yahoo}
    shared = [d for d in poly_days if d in ymap]
    if len(shared) / len(poly_days) < MIN_COVERAGE:
        return False, f"coverage {len(shared)}/{len(poly_days)} below {MIN_COVERAGE:.0%}"
    agree = total = 0
    for prev, cur in zip(shared, shared[1:]):
        rp = polygon[cur] / polygon[prev] - 1.0
        ry = ymap[cur] / ymap[prev] - 1.0
        total += 1
        if abs(rp - ry) >= GROSS_DISAGREEMENT:
            # One unshared split is ONE enormous fake return — 1/250 days
            # sails past any percentage bar, and a single fake +100% day
            # is precisely what poisons momentum and vol features. Any
            # gross disagreement rejects outright, no averaging.
            return False, f"gross return disagreement on {cur} (|{rp:.4f} - {ry:.4f}|)"
        if abs(rp - ry) < RETURN_TOLERANCE:
            agree += 1
    if total == 0 or agree / total < MIN_AGREE:
        return False, f"returns agree on {agree}/{total} shared days, below {MIN_AGREE:.0%}"
    return True, f"agree {agree}/{total}, coverage {len(shared)}/{len(poly_days)}"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int, default=None, help="first N symbols only (smoke test)")
    args = ap.parse_args()
    if args.write == bool(args.dry_run):
        raise SystemExit("pass exactly one of --write / --dry-run")

    con = sqlite3.connect(DB)
    symbols = [r[0] for r in con.execute("select distinct symbol from equity_bars order by symbol")]
    if args.limit:
        symbols = symbols[: args.limit]

    accepted = rejected = unfetchable = 0
    inserted_total = 0
    rejections: list[str] = []
    for i, symbol in enumerate(symbols):
        poly = {
            d: c / 10_000
            for d, c in con.execute(
                "select day, close_e4 from equity_bars where symbol=? order by day", (symbol,)
            )
        }
        earliest = min(poly)
        yahoo = _fetch_yahoo(symbol)
        time.sleep(THROTTLE_S)
        if yahoo is None:
            unfetchable += 1
            continue
        ok, why = _gate(yahoo, poly)
        if not ok:
            rejected += 1
            rejections.append(f"{symbol}: {why}")
            continue
        accepted += 1
        older = [r for r in yahoo if r["day"] < earliest]
        if args.write and older:
            con.executemany(
                "insert or ignore into equity_bars"
                " (symbol, day, open_e4, high_e4, low_e4, close_e4, adj_close_e4, volume)"
                " values (?,?,?,?,?,?,?,?)",
                [
                    (
                        symbol,
                        r["day"],
                        round(r["open"] * 10_000),
                        round(r["high"] * 10_000),
                        round(r["low"] * 10_000),
                        round(r["close"] * 10_000),
                        round(r["adj_close"] * 10_000) if r["adj_close"] else None,
                        r["volume"],
                    )
                    for r in older
                ],
            )
            con.commit()
            inserted_total += len(older)
        if (i + 1) % 50 == 0:
            print(f"[{i + 1}/{len(symbols)}] accepted {accepted}, rejected {rejected}, unfetchable {unfetchable}")

    print(
        f"done: {accepted} accepted, {rejected} rejected, {unfetchable} unfetchable"
        + (f", {inserted_total} rows inserted" if args.write else " (dry run — nothing written)")
    )
    for line in rejections[:20]:
        print("  rejected:", line)
    con.close()


if __name__ == "__main__":
    main()
