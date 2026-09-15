"""Congressional trade ingestion — the STOCK Act's own paper trail.

Members of Congress must disclose trades within 45 days (Periodic
Transaction Reports). Every paid "Pelosi tracker" resells the same free
primary source this module reads directly: the House Clerk publishes a
daily-updated zip per year whose XML indexes every filing, and each PTR
is a digitally-generated PDF that extracts to clean text.

What the data honestly is — and is not:
- Amounts are RANGES ($1,001-$15,000 buckets), not fills. The feature
  layer uses signed midpoints; precision theater would be dishonest.
- The legal 45-day lag means a filing often describes a trade from
  weeks ago. `trans_date` vs `filed_date` carries that gap; any feature
  built on this table must key on FILED date (when the market could
  know), never transaction date — using trans_date is lookahead.
- House only, for now. The Senate's system sits behind a session
  handshake; the House is ~4x the members and includes the most-watched
  filers.

Run ON THE RUNNER:
    uv run python -m app.congress --backfill      # 2025 + 2026 to date
    uv run python -m app.congress --incremental   # re-pull current year (new PTRs only)
"""

from __future__ import annotations

import argparse
import io
import re
import sqlite3
import time
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from datetime import date
from pathlib import Path

DB = Path.home() / ".org" / "market" / "market.db"
UA = {"User-Agent": "Mozilla/5.0 (research; contact kaamraan.niroomand@gmail.com)"}
THROTTLE_S = 0.5

#: "Apple Inc. (AAPL) [ST]" or "... (BE) [OP]" — ticker in parens, then
#: the asset-type tag. ST is shares, OP is an options row (Pelosi's
#: signature: shares AND deep-ITM calls of the same name, same day —
#: which is why asset_type is part of the table's PK). Untagged ticker
#: rows are treated as ST; [AB]/[GS]/fund rows have no ticker parens
#: and never match.
ROW_RE = re.compile(
    r"\(([A-Z][A-Z.\-]{0,6})\)\s*(?:\[(ST|OP)\])?\s*"  # ticker, asset tag
    r"(P|S)(?:\s*\(partial\))?\s+"                 # buy/sell
    r"(\d{2}/\d{2}/\d{4})\s+(\d{2}/\d{2}/\d{4})\s+"  # trans, notif dates
    r"\$([\d,]+)\s*-\s*\$([\d,]+)",                # amount range
    re.S,
)

#: The free-text description under an [OP] row, when the filer states
#: the terms: "Purchased 100 call options with a strike price of $100
#: and an expiration date of 6/17/27." All three fields are optional in
#: the wild — whatever parses is kept, the rest stays null.
OPT_DESC_RE = re.compile(
    r"(call|put)s?\s+options?(?:.*?strike\s+price\s+of\s+\$([\d,.]+))?"
    r"(?:.*?expiration\s+date\s+of\s+(\d{1,2}/\d{1,2}/\d{2,4}))?",
    re.S | re.I,
)


def _get(url: str) -> bytes:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def _iso(mdY: str) -> str:
    m, d, y = mdY.split("/")
    return f"{y}-{m.zfill(2)}-{d.zfill(2)}"  # unpadded months break string date sorts


def _year_index(year: int) -> list[tuple[str, str, str]]:
    """(member, filed_date_iso, doc_id) for every PTR in the year."""
    blob = _get(f"https://disclosures-clerk.house.gov/public_disc/financial-pdfs/{year}FD.zip")
    with zipfile.ZipFile(io.BytesIO(blob)) as z:
        xml_bytes = z.read(f"{year}FD.xml")
    out = []
    for m in ET.fromstring(xml_bytes):
        if (m.findtext("FilingType") or "") != "P":
            continue
        member = f"{m.findtext('First') or ''} {m.findtext('Last') or ''}".strip()
        filed = m.findtext("FilingDate") or ""
        try:
            filed_iso = _iso(filed)
        except Exception:
            continue
        doc = m.findtext("DocID") or ""
        if doc:
            out.append((member, filed_iso, doc))
    return out


def _parse_ptr(pdf_bytes: bytes) -> list[dict]:
    from pypdf import PdfReader

    text = "\n".join(page.extract_text() or "" for page in PdfReader(io.BytesIO(pdf_bytes)).pages)
    matches = list(ROW_RE.finditer(text))
    rows = []
    for i, m in enumerate(matches):
        ticker, tag, code, trans, _notif, lo, hi = m.groups()
        asset_type = tag or "ST"
        option_type = strike = option_expiry = None
        if asset_type == "OP":
            # The terms live in the description BELOW the row, before the
            # next row starts — scan only that slice so one row's strike
            # can never bleed into its neighbor's.
            tail = text[m.end() : matches[i + 1].start() if i + 1 < len(matches) else m.end() + 500]
            d = OPT_DESC_RE.search(tail)
            if d:
                option_type = d.group(1).lower()
                strike = float(d.group(2).replace(",", "")) if d.group(2) else None
                if d.group(3):
                    mm, dd, yy = d.group(3).split("/")
                    option_expiry = f"{yy if len(yy) == 4 else '20' + yy}-{mm.zfill(2)}-{dd.zfill(2)}"
        rows.append(
            {
                "symbol": ticker,
                "code": code,
                "asset_type": asset_type,
                "trans_date": _iso(trans),
                "amount_min": float(lo.replace(",", "")),
                "amount_max": float(hi.replace(",", "")),
                "option_type": option_type,
                "strike": strike,
                "option_expiry": option_expiry,
            }
        )
    return rows


def _normalize_dates(con: sqlite3.Connection) -> None:
    """Early ingests wrote unpadded filed dates ('2026-8-21'), which
    poison string comparisons — '2026-1-05' sorts AFTER '2026-06-17'.
    Idempotent repair pass, run at every ingest."""
    fixed = 0
    for (val,) in list(con.execute("select distinct filed_date from congress_trades where length(filed_date) < 10")):
        y, m, d = val.split("-")
        con.execute(
            "update congress_trades set filed_date = ? where filed_date = ?",
            (f"{y}-{m.zfill(2)}-{d.zfill(2)}", val),
        )
        fixed += 1
    if fixed:
        con.commit()
        print(f"normalized {fixed} unpadded filed_date value(s)")


def ingest(years: list[int], redo_member: str | None = None) -> None:
    con = sqlite3.connect(DB, timeout=120)
    con.execute("pragma busy_timeout = 120000")
    _normalize_dates(con)
    if redo_member:
        # Re-parse a member's known docs — how rows that predate a parser
        # improvement (the options rows) get their second chance.
        con.execute("delete from congress_trades where member like ?", (f"%{redo_member}%",))
        con.commit()
    parsed = rows_written = skipped = errors = 0
    for year in years:
        try:
            index = _year_index(year)
        except Exception as e:
            print(f"{year}: index failed — {e}")
            continue
        print(f"{year}: {len(index)} PTRs indexed")
        known = {r[0] for r in con.execute("select distinct doc_id from congress_trades")}
        for member, filed, doc in index:
            if doc in known:
                skipped += 1
                continue
            try:
                pdf = _get(f"https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/{year}/{doc}.pdf")
                txns = _parse_ptr(pdf)
            except Exception:
                errors += 1
                continue
            finally:
                time.sleep(THROTTLE_S)
            parsed += 1
            for t in txns:
                con.execute(
                    "insert or ignore into congress_trades"
                    " (doc_id, member, chamber, symbol, code, asset_type, trans_date, filed_date,"
                    "  amount_min, amount_max, option_type, strike, option_expiry)"
                    " values (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (doc, member, "house", t["symbol"], t["code"], t["asset_type"], t["trans_date"], filed,
                     t["amount_min"], t["amount_max"], t["option_type"], t["strike"], t["option_expiry"]),
                )
                rows_written += 1
            con.commit()
    print(f"done: {parsed} PTRs parsed, {rows_written} trades written, {skipped} already known, {errors} errors")
    con.close()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--backfill", action="store_true")
    ap.add_argument("--incremental", action="store_true")
    ap.add_argument("--redo-member", default=None, help="delete and re-parse this member's docs (parser upgrades)")
    args = ap.parse_args()
    if args.backfill == bool(args.incremental):
        raise SystemExit("pass exactly one of --backfill / --incremental")
    year = date.today().year
    ingest([year - 1, year] if args.backfill else [year], redo_member=args.redo_member)


if __name__ == "__main__":
    main()
