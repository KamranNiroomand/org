import { and, desc, eq } from 'drizzle-orm';
import { config } from '../../config.js';
import { marketDb } from '../../db/market/index.js';
import { documents, docMentions } from '../../db/market/schema.js';
import { nowIso } from '../util.js';

/**
 * SEC EDGAR ingestion — free, no API key, and the more precisely timestamped
 * of the two text sources this project can reach today (see news.ts for the
 * other). Scoped to 8-Ks specifically: they are the event drivers the plan
 * calls out, and every other form type on `filings.recent` is skipped.
 *
 * Every request must carry a real, contactable User-Agent — SEC's fair-
 * access policy rate-limits or blocks anything else outright — so this
 * module refuses to run at all rather than send a request identifying
 * nobody. See `SEC_EDGAR_USER_AGENT` in config.ts.
 */

const TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const SUBMISSIONS_URL = (cik10: string) => `https://data.sec.gov/submissions/CIK${cik10}.json`;

function userAgent(): string {
  const ua = config.market.edgarUserAgent;
  if (!ua) throw new Error('SEC_EDGAR_USER_AGENT is not set — EDGAR ingestion is disabled without it.');
  return ua;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { 'User-Agent': userAgent(), Accept: 'application/json' } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`EDGAR ${res.status} ${res.statusText} at ${url}${body ? ` — ${body.slice(0, 300)}` : ''}`);
  }
  return (await res.json()) as T;
}

interface CompanyTickerEntry {
  cik_str: number;
  ticker: string;
  title: string;
}

/** Ticker -> zero-padded 10-digit CIK, fetched once per ingestion run. The
 * file is ~1MB and covers every registrant; a per-symbol lookup endpoint
 * does not exist, so this is the one call that has to fetch everything.
 */
async function fetchTickerToCik(): Promise<Map<string, string>> {
  const entries = await getJson<Record<string, CompanyTickerEntry>>(TICKERS_URL);
  const map = new Map<string, string>();
  for (const entry of Object.values(entries)) {
    map.set(entry.ticker.toUpperCase(), String(entry.cik_str).padStart(10, '0'));
  }
  return map;
}

interface SubmissionsRecent {
  form: string[];
  filingDate: string[];
  acceptanceDateTime: string[];
  accessionNumber: string[];
  primaryDocument: string[];
  primaryDocDescription: (string | null)[];
  items: string[];
}

interface SubmissionsResponse {
  filings: { recent: SubmissionsRecent };
}

export interface EightK {
  accessionNumber: string;
  acceptedAt: string;
  primaryDocument: string;
  items: string;
}

/** This symbol's 8-Ks from `filings.recent` — SEC does not offer a
 * form-type filter server-side, so every filing type is fetched and this
 * narrows it down. `filings.recent` covers roughly a year; older filings
 * live in a separate paginated `filings.files` index this module does not
 * walk, matching the plan's own framing of EDGAR as the event driver rather
 * than a full historical archive.
 */
async function fetchRecentEightKs(cik10: string): Promise<EightK[]> {
  const submissions = await getJson<SubmissionsResponse>(SUBMISSIONS_URL(cik10));
  const recent = submissions.filings.recent;
  const out: EightK[] = [];
  for (let i = 0; i < recent.form.length; i += 1) {
    if (recent.form[i] !== '8-K') continue;
    out.push({
      accessionNumber: recent.accessionNumber[i]!,
      acceptedAt: recent.acceptanceDateTime[i]!,
      primaryDocument: recent.primaryDocument[i]!,
      items: recent.items[i] ?? '',
    });
  }
  return out;
}

function filingUrl(cik10: string, accessionNumber: string, primaryDocument: string): string {
  // SEC's document path drops the leading zeros from the CIK and the dashes
  // from the accession number.
  const cikNoLeadingZeros = String(Number(cik10));
  const accessionNoDashes = accessionNumber.replaceAll('-', '');
  return `https://www.sec.gov/Archives/edgar/data/${cikNoLeadingZeros}/${accessionNoDashes}/${primaryDocument}`;
}

/** Scoped to source='edgar' specifically — see news.ts's identical fix for
 * why an unscoped query here silently drops real, unfetched 8-Ks whenever
 * a news article landed more recently than the last known filing did.
 */
function latestKnownAcceptedAt(underlying: string): string | null {
  const row = marketDb
    .select({ publishedAt: documents.publishedAt })
    .from(docMentions)
    .innerJoin(documents, eq(documents.id, docMentions.documentId))
    .where(and(eq(docMentions.underlying, underlying), eq(documents.source, 'edgar')))
    .orderBy(desc(documents.publishedAt))
    .limit(1)
    .get();
  return row?.publishedAt ?? null;
}

function persistFilings(symbol: string, cik10: string, filings: readonly EightK[]): number {
  if (filings.length === 0) return 0;
  const now = nowIso();
  let written = 0;

  marketDb.transaction((tx) => {
    for (const f of filings) {
      const id = `edgar:${f.accessionNumber}`;
      const inserted = tx
        .insert(documents)
        .values({
          id,
          source: 'edgar',
          sourceId: f.accessionNumber,
          publishedAt: f.acceptedAt,
          ingestedAt: now,
          title: `8-K${f.items ? ` (items ${f.items})` : ''} — ${symbol}`,
          summary: null,
          url: filingUrl(cik10, f.accessionNumber, f.primaryDocument),
          docType: '8-K',
          edgarItems: f.items || null,
        })
        .onConflictDoNothing({ target: [documents.source, documents.sourceId] })
        .run();
      if (inserted.changes > 0) written += 1;

      // EDGAR carries no sentiment — the column stays null rather than a
      // fabricated score, same reasoning as the doc_mentions table comment.
      tx.insert(docMentions)
        .values({ documentId: id, underlying: symbol, sentiment: null, sentimentReasoning: null })
        .onConflictDoNothing({ target: [docMentions.documentId, docMentions.underlying] })
        .run();
    }
  });

  return written;
}

export interface EdgarIngestSummary {
  symbolsDone: number;
  symbolsUnresolved: string[];
  filingsFetched: number;
  documentsWritten: number;
  errors: string[];
}

export interface EdgarFetchers {
  tickerToCik: () => Promise<Map<string, string>>;
  eightKs: (cik10: string) => Promise<EightK[]>;
}

const REAL_FETCHERS: EdgarFetchers = { tickerToCik: fetchTickerToCik, eightKs: fetchRecentEightKs };

/**
 * `fetchers` defaults to the real SEC calls and is only ever overridden in
 * tests — same dependency-injection shape as `ingestNewsForUniverse` in
 * news.ts, so the persist/cutoff logic gets real test coverage without a
 * live call, including the source-scoping bug that lived in that logic
 * (see latestKnownAcceptedAt's doc comment).
 */
export async function ingestEdgarForUniverse(
  symbols: readonly string[],
  fetchers: EdgarFetchers = REAL_FETCHERS,
): Promise<EdgarIngestSummary> {
  userAgent(); // fail before the first request, not partway through the universe.

  const summary: EdgarIngestSummary = {
    symbolsDone: 0,
    symbolsUnresolved: [],
    filingsFetched: 0,
    documentsWritten: 0,
    errors: [],
  };

  const tickerToCik = await fetchers.tickerToCik();

  // Sequential, not mapLimit'd like news.ts — SEC's fair-access policy asks
  // for a moderate, steady request rate rather than bursts, and this is a
  // free public service with no plan to fall back to if it starts blocking.
  for (const symbol of symbols) {
    const cik10 = tickerToCik.get(symbol.toUpperCase());
    if (!cik10) {
      summary.symbolsUnresolved.push(symbol);
      summary.symbolsDone += 1;
      continue;
    }

    try {
      const all = await fetchers.eightKs(cik10);
      const cutoff = latestKnownAcceptedAt(symbol);
      const fresh = cutoff ? all.filter((f) => f.acceptedAt > cutoff) : all;
      summary.filingsFetched += fresh.length;
      summary.documentsWritten += persistFilings(symbol, cik10, fresh);
    } catch (err) {
      summary.errors.push(`${symbol}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      summary.symbolsDone += 1;
    }
  }

  return summary;
}
