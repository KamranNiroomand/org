/**
 * Shared shapes for the multi-agent panel — the box's own module doc
 * comments (context.ts, specialists.ts, synthesize.ts) explain what each
 * piece is for; this file just gives them one vocabulary to agree on.
 */

/** Travels with every API response returning panel data, verbatim — same
 * discipline as `RADAR_DISCLAIMER` in `lib/radar/score.ts`, and for the same
 * reason: this is reasoning about public data, never investment advice, and
 * that promise has to survive all the way to the UI, not just this file. */
export const PANEL_DISCLAIMER =
  'Reasoning from public data by four AI specialists and a synthesizer — not investment advice, ' +
  'not a recommendation, and not validated against outcomes. Read the disagreements, not just the ' +
  'headline stance; a split panel is telling you something a single verdict would hide.';

/**
 * Per-call timeout/retry override for every Anthropic call this module
 * makes — found the hard way: the SDK's own default (10 minutes, retried up
 * to twice) let one slow call stall an entire panel run for the better part
 * of ten minutes with `symbolConcurrency: 2` holding both concurrency slots
 * hostage, since `mapLimit`'s worker for that slot can't move to the next
 * symbol until the current call settles. 90s × 2 attempts bounds one call's
 * worst case to three minutes instead — long enough for a genuinely slow
 * generation, short enough that a stalled panel run fails that one symbol
 * (caught by `executePanelRun`'s per-symbol try/catch) rather than hanging
 * the whole run.
 */
export const ANTHROPIC_CALL_OPTIONS = { timeout: 90_000, maxRetries: 1 };

export const SPECIALISTS = ['momentum', 'fundamentals', 'news_sentiment', 'skeptic'] as const;
export type Specialist = (typeof SPECIALISTS)[number];

/** Everything one specialist sees about one symbol. Built once per symbol,
 * reused unchanged across both rounds and all four specialists — nobody
 * gets a different picture of the facts, only a different lens on them. */
export interface SymbolContext {
  symbol: string;
  name: string;
  price: number | null;
  dayChangePercent: number | null;
  marketCap: number | null;
  sector: string | null;
  trailingPe: number | null;
  forwardPe: number | null;
  priceToBook: number | null;
  dividendYield: number | null;
  fiftyTwoWeekHigh: number | null;
  fiftyTwoWeekLow: number | null;
  volume: number | null;
  avgVolume10Day: number | null;
  /** Present only when this symbol is an actual position, never fabricated
   * as "not held" if the lookup simply failed — see context.ts. */
  holding: { quantity: number; avgCost: number; currency: string } | null;
  /** Present only when this symbol cleared today's radar shortlist — most
   * box queries (an arbitrary ticker) will have this null, which every
   * specialist's system prompt must treat as "not screened", never as
   * "screened and unremarkable". */
  radar: {
    score: number;
    rank: number;
    momentumZ: number | null;
    trendPct: number | null;
    newHigh: boolean;
    volumeRatio: number | null;
    volumeZ: number | null;
    sentimentZ: number | null;
    inputsUsed: string[];
  } | null;
  /**
   * What the symbol's own sector did today, because no company trades in
   * a vacuum: an NVDA earnings report moves every AI-adjacent name
   * whether or not an article tags them. Built from the same sector's
   * largest peers (by market cap) so a specialist can distinguish "this
   * stock moved" from "everything like it moved" — the difference
   * between idiosyncratic news and a sector tide, which changes what a
   * move means. Null when the symbol has no sector or no peers.
   */
  sectorPulse: {
    sector: string;
    /** How many peers the averages below are computed over. */
    peerCount: number;
    avgDayChangePercent: number | null;
    /** The single largest absolute mover among those peers today. */
    biggestMover: { symbol: string; dayChangePercent: number } | null;
    /** Sector-mates' news from the last 48h that carries a classified
     * event (earnings, M&A, regulatory...) — the "something happened in
     * this neighbourhood" signal, capped at 3 headlines. */
    recentSectorEvents: Array<{ symbol: string; title: string; eventType: string | null }>;
  } | null;
  /**
   * Present only when the stock paper book holds this symbol. This is what
   * turns a daily news read into a position review: the specialists see
   * the thesis the book bought under, how the position has done since, and
   * what the panel said about it last time — so a verdict can be anchored
   * to "has anything changed since we bought" instead of re-rolled from
   * scratch on each day's noise. A quiet day is NOT evidence against a
   * held thesis, and the prompts say so explicitly.
   */
  heldThesis: {
    book: 'short' | 'long';
    entryDay: string;
    entryPrice: number;
    daysHeld: number;
    currentReturnPct: number | null;
    /** The panel synthesis the entry was made under (thesis_ref), verbatim.
     * Null when the entry predates thesis recording or was quant-only. */
    originalThesis: string | null;
    /** The panel's most recent completed read of this symbol before today —
     * the stability anchor. Changing away from it should take evidence. */
    priorStance: { stance: SynthesisStance; day: string; summary: string } | null;
  } | null;
  /** Newest first, capped at 10 — see context.ts for the cap's reasoning. */
  recentDocuments: Array<{
    title: string;
    summary: string | null;
    publishedAt: string;
    source: 'polygon_news' | 'edgar';
    sentiment: 'positive' | 'negative' | 'neutral' | null;
    eventType: string | null;
  }>;
}

export type AgentStance = 'bullish' | 'bearish' | 'neutral';
export type Confidence = 'low' | 'medium' | 'high';

/** One specialist's round-1 turn — independent, no visibility into the
 * other three specialists yet. */
export interface Round1Turn {
  agent: Specialist;
  stance: AgentStance;
  confidence: Confidence;
  /** The specialist's probability that the symbol outperforms its own
   * sector over the next 21 sessions — the scoreable number behind the
   * words. Persisted so calibration (Brier scores per specialist) can be
   * measured against outcomes once enough history accrues. */
  probUp: number;
  /** The one concrete observation that would most change this stance —
   * required because a view with no falsifier is a mood, and because
   * "what would change your mind" is the discipline that separates
   * forecasters from narrators. */
  falsifier: string;
  reasoning: string;
  /** The specific SymbolContext fields this reasoning actually rests on —
   * required so a claim can be checked against the input it came from,
   * not floated as an unattributed opinion. */
  citedInputs: string[];
}

/** One specialist's round-2 turn — conditioned on the real round-1
 * transcript from all four specialists, not a summary of it. See
 * specialists.ts's own doc comment for why the transcript itself, verbatim,
 * is what gets fed back in. */
export interface Round2Turn extends Round1Turn {
  /** Which other specialist(s) this turn is actually engaging with —
   * required so "revise if it changes your mind" has a concrete anchor,
   * not a vague gesture at "the discussion". */
  respondingTo: Specialist[];
  revisedPosition: boolean;
}

export type SynthesisStance = 'notable' | 'mixed' | 'not_notable';

/** The panel's one user-facing verdict — deliberately never on the
 * bullish/bearish axis (see synthesize.ts), and never a fifth opinion:
 * every field here must trace back to something the four specialists
 * actually said across both rounds. */
export type ThesisVerdict = 'intact' | 'weakened' | 'broken';

export interface SynthesisResult {
  stance: SynthesisStance;
  summary: string;
  agreements: string[];
  disagreements: string[];
  openQuestions: string[];
  /** Only when the context carried a heldThesis: the panel's judgment of
   * the ORIGINAL entry thesis, on its own axis. `stance` above answers
   * "was today notable" and re-rolls daily; this answers "does the reason
   * we own it still hold", which should only move on evidence. Null when
   * the symbol isn't held. */
  thesisVerdict: ThesisVerdict | null;
}
