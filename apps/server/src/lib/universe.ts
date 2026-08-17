import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { instruments } from '../db/schema.js';
import { TSX_COMPOSITE } from '../data/indices.js';
import { nowIso } from './util.js';

/**
 * Building the tradeable universe.
 *
 * US listings come from the symbol directories Nasdaq publishes as plain
 * pipe-delimited files — free, keyless, and authoritative, since they are what
 * the exchange itself distributes. Canadian coverage comes from the S&P/TSX
 * Composite: the TSX Venture tail is thousands of micro-cap shells that would
 * add noise to a market map without adding market.
 *
 * This runs nightly. Listings change slowly, and re-reading two files is far
 * cheaper than discovering a delisting the hard way.
 */

const NASDAQ_LISTED = 'https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt';
const OTHER_LISTED = 'https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt';

/** Single letters in the `otherlisted` exchange column. */
const EXCHANGES: Record<string, string> = {
  N: 'NYSE',
  A: 'NYSE American',
  P: 'NYSE Arca',
  Z: 'Cboe BZX',
  V: 'IEX',
};

/**
 * The two sector sources speak different vocabularies — Nasdaq's screener says
 * "Finance" and "Technology" where GICS, which the index lists follow, says
 * "Financials" and "Information Technology". Left alone the filter shows both
 * spellings and each silently hides the other's rows. GICS wins, as the more
 * standard of the two.
 */
const SECTOR_ALIASES: Record<string, string> = {
  Finance: 'Financials',
  Technology: 'Information Technology',
  'Basic Materials': 'Materials',
  Healthcare: 'Health Care',
  Telecommunications: 'Communication Services',
  Miscellaneous: 'Other',
};

const normalizeSector = (raw: string | null): string | null =>
  raw === null ? null : (SECTOR_ALIASES[raw] ?? raw);

export interface UniverseRow {
  symbol: string;
  name: string;
  exchange: string;
  country: 'US' | 'CA';
  sector: string | null;
}

/**
 * Nasdaq's own screener, in its bulk form: one request per exchange returns
 * every listing with a sector attached. Yahoo's quote endpoint carries no
 * sector at all, and asking it per symbol would be seven thousand calls, so
 * this is what makes the sector filter work beyond the S&P 500.
 */
const SCREENER = (exchange: string) =>
  `https://api.nasdaq.com/api/screener/stocks?tableonly=false&download=true&exchange=${exchange}`;

interface ScreenerRow {
  symbol?: string;
  sector?: string;
}

/** Symbol to sector for the US market. Failures degrade to no sector. */
async function fetchSectors(): Promise<Map<string, string>> {
  const out = new Map<string, string>();

  const results = await Promise.allSettled(
    ['NASDAQ', 'NYSE', 'AMEX'].map(async (exchange) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60_000);
      try {
        const res = await fetch(SCREENER(exchange), {
          signal: controller.signal,
          headers: {
            // The endpoint returns 403 to a bare programmatic request.
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
            Accept: 'application/json',
          },
        });
        if (!res.ok) throw new Error(`screener ${exchange} returned HTTP ${res.status}`);
        return (await res.json()) as { data?: { rows?: ScreenerRow[] } };
      } finally {
        clearTimeout(timeout);
      }
    }),
  );

  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    for (const row of result.value.data?.rows ?? []) {
      const sector = row.sector?.trim();
      if (row.symbol && sector) out.set(row.symbol.trim(), sector);
    }
  }

  return out;
}

async function fetchText(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Keeps common stock only.
 *
 * Test issues are exchange scaffolding. ETFs are excluded because a market map
 * sized by market cap has no room for funds — a fund's assets are not a
 * company's value, and mixing them double-counts every holding. Preferreds,
 * warrants, units and rights are filtered by shape: they all carry suffix
 * punctuation that plain common stock never does.
 */
function parseDirectory(
  text: string,
  opts: { symbolIdx: number; nameIdx: number; etfIdx: number; testIdx: number; exchangeIdx?: number; exchange?: string },
): UniverseRow[] {
  const out: UniverseRow[] = [];
  for (const line of text.split('\n').slice(1)) {
    const parts = line.split('|');
    if (parts.length < 5) continue;
    // The files end with a "File Creation Time" trailer rather than data.
    if (parts[0]!.startsWith('File Creation')) continue;
    if (parts[opts.testIdx]?.trim() === 'Y') continue;
    if (parts[opts.etfIdx]?.trim() === 'Y') continue;

    const symbol = parts[opts.symbolIdx]!.trim();
    if (!/^[A-Z]{1,5}$/.test(symbol)) continue;

    const rawExchange = opts.exchange ?? parts[opts.exchangeIdx!]?.trim() ?? '';
    out.push({
      symbol,
      name: parts[opts.nameIdx]!.trim(),
      exchange: opts.exchange ?? EXCHANGES[rawExchange] ?? rawExchange,
      country: 'US',
      sector: null,
    });
  }
  return out;
}

/** Fetches the full universe. Throws only if both US directories fail. */
export async function fetchUniverse(): Promise<UniverseRow[]> {
  const [nasdaq, other] = await Promise.allSettled([
    fetchText(NASDAQ_LISTED),
    fetchText(OTHER_LISTED),
  ]);

  const rows: UniverseRow[] = [];
  if (nasdaq.status === 'fulfilled') {
    rows.push(
      ...parseDirectory(nasdaq.value, {
        symbolIdx: 0,
        nameIdx: 1,
        etfIdx: 6,
        testIdx: 3,
        exchange: 'NASDAQ',
      }),
    );
  }
  if (other.status === 'fulfilled') {
    rows.push(
      ...parseDirectory(other.value, { symbolIdx: 0, nameIdx: 1, etfIdx: 4, testIdx: 6, exchangeIdx: 2 }),
    );
  }
  if (rows.length === 0) throw new Error('Both US symbol directories failed to load');

  // Canadian rows bring their own sector; Nasdaq's screener covers only the
  // US tapes, so nothing else would supply one.
  const canadian = new Set<string>();
  for (const [symbol, name, sector] of TSX_COMPOSITE) {
    rows.push({ symbol, name, exchange: 'TSX', country: 'CA', sector });
    canadian.add(symbol);
  }

  const sectors = await fetchSectors();
  for (const row of rows) {
    if (!canadian.has(row.symbol)) row.sector = sectors.get(row.symbol) ?? null;
    row.sector = normalizeSector(row.sector);
  }

  // A symbol can appear on more than one tape; first listing wins.
  return [...new Map(rows.map((r) => [r.symbol, r])).values()];
}

export interface UniverseOutcome {
  added: number;
  updated: number;
  removed: number;
  total: number;
}

/**
 * Reconciles the stored universe with the freshly fetched one.
 *
 * Existing rows keep their quote data — only the listing facts are refreshed —
 * so a universe refresh never blanks the map while waiting for the next sweep.
 */
export async function refreshUniverse(): Promise<UniverseOutcome> {
  const incoming = await fetchUniverse();
  const existing = new Set(
    db.select({ symbol: instruments.symbol }).from(instruments).all().map((r) => r.symbol),
  );

  const outcome: UniverseOutcome = { added: 0, updated: 0, removed: 0, total: incoming.length };
  const seen = new Set(incoming.map((r) => r.symbol));

  db.transaction((tx) => {
    for (const row of incoming) {
      if (existing.has(row.symbol)) {
        tx.update(instruments)
          .set({ name: row.name, exchange: row.exchange, country: row.country, sector: row.sector })
          .where(sql`${instruments.symbol} = ${row.symbol}`)
          .run();
        outcome.updated++;
      } else {
        tx.insert(instruments)
          .values({ ...row, listedAt: nowIso() })
          .onConflictDoNothing()
          .run();
        outcome.added++;
      }
    }

    const stale = [...existing].filter((s) => !seen.has(s));
    for (const symbol of stale) {
      tx.delete(instruments).where(sql`${instruments.symbol} = ${symbol}`).run();
    }
    outcome.removed = stale.length;
  });

  return outcome;
}
