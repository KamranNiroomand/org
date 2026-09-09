"""SEC Form 4 insider-transaction ingestion — the free half of "follow the
big insiders".

Corporate officers and directors must file Form 4 within two business
days of trading their own stock, and the filings are free from EDGAR
with years of history. The literature's finding (Lakonishok & Lee 2001,
Cohen, Malloy & Pomorski 2012 "Decoding Inside Information") is
specific: clustered OPEN-MARKET PURCHASES (code P) by officers predict
returns; sales predict little (they happen for taxes, diversification,
divorce); grants (code A) predict nothing. The feature layer therefore
aggregates signed open-market value, not filing counts.

(The congressional-trades version of this idea — the "Pelosi tracker" —
lives behind paid aggregators; the free community mirrors are dead.
This module covers the better-documented signal at zero cost.)

Run ON THE RUNNER (the corpus owner):
    uv run python -m app.insider --backfill     # full history per symbol
    uv run python -m app.insider --incremental  # last ~7 days of filings

Politeness: data.sec.gov allows ~10 req/s; this throttles to ~5/s and
identifies itself with the repo's registered user agent. A full backfill
is a few hours of quiet background work; incremental nightly runs are
seconds per symbol with new filings.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import time
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

DB = Path.home() / ".org" / "market" / "market.db"
THROTTLE_S = 0.2
#: Cap Form 4 fetches per symbol per run — the megacaps file hundreds a
#: year (10b5-1 plans); the newest N capture the active signal window.
MAX_FILINGS_PER_SYMBOL = 60


def _ua() -> str:
    for env_path in (Path.home() / "dev" / "Org" / ".env", Path.home() / "Desktop" / "org" / ".env"):
        if env_path.exists():
            for line in env_path.read_text().splitlines():
                if line.startswith("SEC_EDGAR_USER_AGENT="):
                    return line.split("=", 1)[1].strip()
    raise SystemExit("SEC_EDGAR_USER_AGENT not found in .env — EDGAR requires an identifying UA")


def _get(url: str, ua: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": ua})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


def _cik_map(ua: str) -> dict[str, str]:
    raw = json.loads(_get("https://www.sec.gov/files/company_tickers.json", ua))
    return {row["ticker"].upper(): str(row["cik_str"]).zfill(10) for row in raw.values()}


def _parse_form4(xml_bytes: bytes) -> list[dict]:
    """One filing's non-derivative transactions. Namespace-agnostic on
    purpose: EDGAR's Form 4 XML has drifted across schema versions, and a
    parser pinned to one namespace silently returns nothing on another."""
    root = ET.fromstring(xml_bytes)

    def find(el, path):
        for e in el.iter():
            if e.tag.split("}")[-1] == path:
                return e
        return None

    def text(el, *path):
        cur = el
        for p in path:
            cur = find(cur, p) if cur is not None else None
        return cur.text.strip() if cur is not None and cur.text else None

    owner = text(root, "reportingOwner", "rptOwnerName") or "unknown"
    is_officer = 1 if (text(root, "reportingOwner", "isOfficer") or "0") in ("1", "true") else 0
    is_director = 1 if (text(root, "reportingOwner", "isDirector") or "0") in ("1", "true") else 0

    out = []
    for el in root.iter():
        if el.tag.split("}")[-1] != "nonDerivativeTransaction":
            continue
        code = text(el, "transactionCoding", "transactionCode")
        if not code:
            continue
        shares_s = text(el, "transactionAmounts", "transactionShares", "value")
        price_s = text(el, "transactionAmounts", "transactionPricePerShare", "value")
        shares = float(shares_s) if shares_s else None
        price = float(price_s) if price_s else None
        out.append(
            {
                "trans_date": text(el, "transactionDate", "value"),
                "code": code,
                "shares": shares,
                "price": price,
                "value_usd": shares * price if shares is not None and price is not None else None,
                "insider_name": owner,
                "is_officer": is_officer,
                "is_director": is_director,
            }
        )
    return out


def ingest(symbols: list[str] | None, incremental: bool) -> None:
    ua = _ua()
    con = sqlite3.connect(DB, timeout=120)
    con.execute("pragma busy_timeout = 120000")
    universe = symbols or [
        r[0] for r in con.execute("select symbol from tracked_underlyings where active=1 order by symbol")
    ]
    ciks = _cik_map(ua)
    cutoff = time.strftime("%Y-%m-%d", time.gmtime(time.time() - 10 * 86400)) if incremental else None

    filings = rows_written = missing_cik = errors = 0
    for i, symbol in enumerate(universe):
        cik = ciks.get(symbol.upper())
        if not cik:
            missing_cik += 1
            continue
        try:
            sub = json.loads(_get(f"https://data.sec.gov/submissions/CIK{cik}.json", ua))
            time.sleep(THROTTLE_S)
            recent = sub["filings"]["recent"]
            wanted = [
                (recent["filingDate"][j], recent["accessionNumber"][j], recent["primaryDocument"][j])
                for j in range(len(recent["form"]))
                if recent["form"][j] == "4" and (cutoff is None or recent["filingDate"][j] >= cutoff)
            ][:MAX_FILINGS_PER_SYMBOL]
            known = {
                r[0] for r in con.execute("select distinct accession from insider_trades where symbol=?", (symbol,))
            }
            for filed, accession, primary_doc in wanted:
                if accession in known:
                    continue
                acc_path = accession.replace("-", "")
                doc = primary_doc.split("/")[-1]
                url = f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{acc_path}/{doc}"
                try:
                    txns = _parse_form4(_get(url, ua))
                except Exception:
                    errors += 1
                    continue
                finally:
                    time.sleep(THROTTLE_S)
                filings += 1
                for t in txns:
                    con.execute(
                        "insert or ignore into insider_trades"
                        " (accession, symbol, filed_date, trans_date, insider_name, is_officer, is_director,"
                        "  code, shares, price, value_usd) values (?,?,?,?,?,?,?,?,?,?,?)",
                        (
                            accession, symbol, filed, t["trans_date"], t["insider_name"],
                            t["is_officer"], t["is_director"], t["code"], t["shares"], t["price"], t["value_usd"],
                        ),
                    )
                    rows_written += 1
            con.commit()
        except Exception as e:
            errors += 1
            if errors <= 5:
                print(f"  {symbol}: {e}")
        if (i + 1) % 50 == 0:
            print(f"[{i + 1}/{len(universe)}] filings {filings}, rows {rows_written}, errors {errors}")

    print(
        f"done: {filings} filings parsed, {rows_written} rows written, "
        f"{missing_cik} symbols without a CIK, {errors} errors"
    )
    con.close()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--backfill", action="store_true")
    ap.add_argument("--incremental", action="store_true")
    ap.add_argument("--symbols", nargs="*", default=None)
    args = ap.parse_args()
    if args.backfill == bool(args.incremental):
        raise SystemExit("pass exactly one of --backfill / --incremental")
    ingest(args.symbols, incremental=args.incremental)


if __name__ == "__main__":
    main()
