import { fetchIbkrQuotes, ibkrConfigured } from './ibkr.js';
import { fetchTradierQuotes, tradierConfigured, type TradierQuote } from './tradier.js';

/** A live NBBO quote — provider-agnostic; see the adapters for basis. */
export type LiveQuote = TradierQuote;

/**
 * The one seam the engines pull live bid/ask through. Providers are
 * overlays, never dependencies: whichever is configured answers, and
 * none configured (or any failure inside one) degrades to an empty map
 * and the print-basis path the engines already have.
 *
 * IBKR outranks Tradier when both are configured, because a logged-in
 * gateway session is real-time NBBO while the free Tradier sandbox is
 * 15-minute delayed — but either counts as basis 'measured': a price a
 * counterparty was actually showing.
 */
export async function fetchLiveNbbo(occSymbols: readonly string[]): Promise<Map<string, LiveQuote>> {
  if (ibkrConfigured()) {
    const quotes = await fetchIbkrQuotes(occSymbols);
    if (quotes.size > 0) return quotes;
    // A configured-but-empty IBKR answer (gateway asleep, session
    // expired) still deserves the Tradier fallback below when there is
    // one — dormant redundancy costs nothing here.
  }
  if (tradierConfigured()) return fetchTradierQuotes(occSymbols);
  return new Map();
}
