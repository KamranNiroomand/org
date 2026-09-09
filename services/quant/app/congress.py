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

#: "Apple Inc. (AAPL) [ST]" — ticker in parens, stock-type tag. The [ST]
#: anchor keeps treasuries, funds, and options rows out.
ROW_RE = re.compile(
    r"\(([A-Z][A-Z.\-]{0,6})\)\s*(?:\[ST\])?\s*"  # ticker
    r"(P|S)(?:\s*\(partial\))?\s+"                 # buy/sell
    r"(\d{2}/\d{2}/\d{4})\s+(\d{2}/\d{2}/\d{4})\s+"  # trans, notif dates
    r"\$([\d,]+)\s*-\s*\$([\d,]+)",                # amount range
    re.S,
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
    rows = []
    for ticker, code, trans, _notif, lo, hi in ROW_RE.findall(text):
        rows.append(
            {
                "symbol": ticker,
                "code": code,
                "trans_date": _iso(trans),
                "amount_min": float(lo.replace(",", "")),
                "amount_max": float(hi.replace(",", "")),
            }
        )
    return rows


def ingest(years: list[int]) -> None:
    con = sqlite3.connect(DB, timeout=120)
    con.execute("pragma busy_timeout = 120000")
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
                    " (doc_id, member, chamber, symbol, code, trans_date, filed_date, amount_min, amount_max)"
                    " values (?,?,?,?,?,?,?,?,?)",
                    (doc, member, "house", t["symbol"], t["code"], t["trans_date"], filed,
                     t["amount_min"], t["amount_max"]),
                )
                rows_written += 1
            con.commit()
    print(f"done: {parsed} PTRs parsed, {rows_written} trades written, {skipped} already known, {errors} errors")
    con.close()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--backfill", action="store_true")
    ap.add_argument("--incremental", action="store_true")
    args = ap.parse_args()
    if args.backfill == bool(args.incremental):
        raise SystemExit("pass exactly one of --backfill / --incremental")
    year = date.today().year
    ingest([year - 1, year] if args.backfill else [year])


if __name__ == "__main__":
    main()
