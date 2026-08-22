import { eq, inArray, like } from 'drizzle-orm';
import { config } from '../../../config.js';
import { db } from '../../../db/index.js';
import { instruments } from '../../../db/schema.js';
import { resolveThemeQuery } from './resolveTheme.js';

export interface BoxResolution {
  symbols: string[];
  resolutionMethod: 'ticker_match' | 'thematic_match';
  /** Only set for a thematic match — surfaced so the UI can show what the
   * one LLM call actually resolved the question to. */
  normalizedTheme: string | null;
}

/** Path A: ticker or name match, zero LLM calls. Tried first because it's
 * instant at this table's size (~7,000 rows) and covers the common case
 * ("NVDA", "moderna") without spending any budget. */
function resolveDirectMatches(query: string): string[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];

  const upper = trimmed.toUpperCase();
  if (/^[A-Z]{1,6}(-[A-Z])?(\.[A-Z]{1,3})?$/.test(upper)) {
    const bySymbol = db.select({ symbol: instruments.symbol }).from(instruments).where(eq(instruments.symbol, upper)).all();
    if (bySymbol.length > 0) return bySymbol.map((r) => r.symbol);
  }

  // SQLite's LIKE is case-insensitive for ASCII by default — no lower()
  // wrapping needed, matching this codebase's existing name-search sites
  // (lib/market.ts, routes/ideas.ts, routes/finance.ts).
  const byName = db
    .select({ symbol: instruments.symbol })
    .from(instruments)
    .where(like(instruments.name, `%${trimmed}%`))
    .limit(config.panel.maxSymbolsPerBoxQuery)
    .all();
  return byName.map((r) => r.symbol);
}

/**
 * Path B: one bounded LLM call to turn an open-ended question ("what looks
 * good in defense right now") into a set of `instruments.sector` values,
 * only reached when Path A found nothing.
 *
 * The plan's original sketch also folded in a keyword search against recent
 * `documents` titles, resolved back to symbols via `docMentions`. Left out
 * here: `docMentions.underlying` is in the vendor's symbol format, and
 * converting it back to this app's format isn't the safe one-line reversal
 * it looks like — `toVendorSymbol` only ever converts a hyphenated US share
 * class (`BRK-B` -> `BRK.B`), and blindly reversing every dot back to a
 * hyphen would mangle a Canadian symbol's real `.TO`/`.V` exchange suffix
 * (`SHOP.TO` -> `SHOP-TO`, a symbol that doesn't exist). Sector matching
 * alone is a real, useful answer to a thematic query; getting keyword
 * resolution right needs a proper reverse-lookup this app doesn't have yet,
 * not a guess that would occasionally return a wrong symbol silently.
 */
async function resolveThematicMatches(query: string): Promise<{ symbols: string[]; normalizedTheme: string }> {
  const sectorRows = db
    .selectDistinct({ sector: instruments.sector })
    .from(instruments)
    .all()
    .map((r) => r.sector)
    .filter((s): s is string => s !== null);

  const theme = await resolveThemeQuery(query, sectorRows);

  const matches =
    theme.matchedSectors.length > 0
      ? db
          .select({ symbol: instruments.symbol })
          .from(instruments)
          .where(inArray(instruments.sector, theme.matchedSectors))
          .limit(config.panel.maxSymbolsPerBoxQuery)
          .all()
      : [];

  return { symbols: matches.map((r) => r.symbol), normalizedTheme: theme.normalizedTheme };
}

export async function resolveBoxQuery(query: string): Promise<BoxResolution> {
  const direct = resolveDirectMatches(query);
  if (direct.length > 0) {
    return {
      symbols: direct.slice(0, config.panel.maxSymbolsPerBoxQuery),
      resolutionMethod: 'ticker_match',
      normalizedTheme: null,
    };
  }

  const thematic = await resolveThematicMatches(query);
  return { symbols: thematic.symbols, resolutionMethod: 'thematic_match', normalizedTheme: thematic.normalizedTheme };
}
