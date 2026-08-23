import { eq } from 'drizzle-orm';
import { db } from '../../../db/index.js';
import { panelAgentTurns, panelRuns, panelSymbolAnalyses } from '../../../db/schema.js';
import { config } from '../../../config.js';
import { mapLimit } from '../../options/polygon.js';
import { newId, nowIso } from '../../util.js';
import { buildSymbolContext } from './context.js';
import { runRound1, runRound2 } from './specialists.js';
import { runSynthesis } from './synthesize.js';
import { PANEL_AGENT_CONCURRENCY, PanelBudgetExceeded, withPanelBudget, type CallBudgeted } from './budget.js';
import { SPECIALISTS, type Specialist, type Round1Turn, type Round2Turn } from './types.js';

/**
 * Runs one round for every specialist, tolerating individual failures
 * instead of the fail-fast semantics a bare `Promise.all` (via `mapLimit`)
 * would give: a network blip or a mid-round budget exhaustion on one
 * specialist must not discard the other three specialists' already-paid-for
 * results. Each agent's own error (including `PanelBudgetExceeded`) is
 * caught individually; the caller decides what an empty or partial result
 * means for the symbol as a whole.
 */
async function collectRound<T extends { agent: Specialist }>(
  callBudgeted: CallBudgeted,
  runCall: (agent: Specialist) => Promise<T>,
): Promise<{ turns: T[]; budgetError: PanelBudgetExceeded | null; errors: string[] }> {
  const errors: string[] = [];
  let budgetError: PanelBudgetExceeded | null = null;
  const settled = await mapLimit(SPECIALISTS, PANEL_AGENT_CONCURRENCY, async (agent): Promise<T | null> => {
    try {
      return await callBudgeted(() => runCall(agent));
    } catch (err) {
      if (err instanceof PanelBudgetExceeded) budgetError = err;
      errors.push(`${agent}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  });
  return { turns: settled.filter((t): t is T => t !== null), budgetError, errors };
}

/**
 * Orchestrates one symbol end to end: round 1 (4 parallel, independent
 * calls) → persist whichever succeeded → round 2 (4 parallel calls, each
 * reading round 1's real transcript) → persist whichever succeeded →
 * synthesis → update the symbol's `panelSymbolAnalyses` row with the real
 * verdict and mark it complete.
 *
 * The analysis row is created with placeholder values *before* any call
 * runs, not after — so a crash partway through (a budget exhaustion, a
 * network failure) still leaves the turns that did complete attached to a
 * real row, readable via `GET /api/signals/panel/:runId`, rather than
 * orphaned or lost because the parent row was never inserted.
 * `synthesisComplete` (false until the final update) is what actually
 * distinguishes that partial/interrupted state from a symbol the panel
 * genuinely finished and rated `not_notable` — the placeholder values alone
 * are indistinguishable from a real "found nothing" verdict.
 */
async function runPanelForSymbol(callBudgeted: CallBudgeted, runId: string, symbol: string): Promise<void> {
  const ctx = buildSymbolContext(symbol);
  if (!ctx) throw new Error(`${symbol}: not found in instruments`);

  const analysisId = newId();
  db.insert(panelSymbolAnalyses)
    .values({
      id: analysisId,
      runId,
      symbol: ctx.symbol,
      stance: 'not_notable',
      summary: '',
      agreements: [],
      disagreements: [],
      openQuestions: [],
      synthesisComplete: false,
      createdAt: nowIso(),
    })
    .run();

  const round1 = await collectRound<Round1Turn>(callBudgeted, (agent) => runRound1(agent, ctx));
  if (round1.turns.length > 0) persistTurns(analysisId, 1, round1.turns);
  if (round1.turns.length === 0) {
    throw round1.budgetError ?? new Error(`${symbol}: every round-1 specialist call failed (${round1.errors.join('; ')})`);
  }

  const round2 = await collectRound<Round2Turn>(callBudgeted, (agent) => runRound2(agent, ctx, round1.turns));
  if (round2.turns.length > 0) persistTurns(analysisId, 2, round2.turns);

  // Stop here — without a full picture from at least one round, synthesis
  // would just spend the last of an exhausted budget restating a partial
  // transcript, or (for a non-budget failure) summarizing round 1 alone as
  // if round 2's cross-examination never happened.
  if (round1.budgetError || round2.budgetError) throw (round1.budgetError ?? round2.budgetError)!;
  if (round2.turns.length === 0) {
    throw new Error(`${symbol}: every round-2 specialist call failed (${round2.errors.join('; ')})`);
  }

  const synthesis = await callBudgeted(() => runSynthesis(ctx, round1.turns, round2.turns));
  db.update(panelSymbolAnalyses)
    .set({
      stance: synthesis.stance,
      summary: synthesis.summary,
      agreements: synthesis.agreements,
      disagreements: synthesis.disagreements,
      openQuestions: synthesis.openQuestions,
      synthesisComplete: true,
    })
    .where(eq(panelSymbolAnalyses.id, analysisId))
    .run();
}

function persistTurns(analysisId: string, round: 1 | 2, turns: readonly (Round1Turn | Round2Turn)[]): void {
  const at = nowIso();
  db.insert(panelAgentTurns)
    .values(
      turns.map((t) => ({
        id: newId(),
        analysisId,
        round,
        agent: t.agent,
        stance: t.stance,
        confidence: t.confidence,
        reasoning: t.reasoning,
        citedInputs: t.citedInputs,
        respondingTo: 'respondingTo' in t ? t.respondingTo : null,
        revisedPosition: 'revisedPosition' in t ? t.revisedPosition : null,
        createdAt: at,
      })),
    )
    .run();
}

export interface StartPanelRunParams {
  trigger: 'nightly_radar' | 'box_query';
  query: string | null;
  resolutionMethod: 'ticker_match' | 'thematic_match' | 'radar_shortlist';
  symbols: string[];
}

/** Guards against a second run of the same trigger overlapping with one
 * already in progress — same shape as `capturing`/`watchlistTextSyncing` in
 * scheduler.ts. Kept separate per trigger, not one shared flag: a box query
 * and the nightly radar run overlapping is an unlikely timing coincidence,
 * not something worth rejecting, but two *nightly* runs overlapping (a slow
 * run still going when the next night's `PANEL_CRON` tick fires) is exactly
 * the unbounded-concurrency risk `withBudget` exists to prevent — each
 * would get its own budget counter and double real spend/concurrency. */
let boxQueryRunning = false;
let nightlyPanelRunning = false;

/**
 * Creates the `panelRuns` bookkeeping row and returns its id immediately —
 * the actual work runs in the background (fire-and-forget, matching the
 * options side's `/api/options/text-sync` "kick off, poll for status"
 * shape) since a real panel run costs multiple sequential LLM round trips
 * per symbol and a route handler has no business blocking on that.
 */
export function startPanelRun(params: StartPanelRunParams): string {
  const runId = newId();
  const startedAt = nowIso();
  db.insert(panelRuns)
    .values({
      id: runId,
      trigger: params.trigger,
      query: params.query,
      resolutionMethod: params.resolutionMethod,
      symbols: params.symbols,
      startedAt,
      model: config.anthropic.model,
    })
    .run();

  if (params.trigger === 'box_query' && boxQueryRunning) {
    db.update(panelRuns)
      .set({ status: 'failed', finishedAt: nowIso(), errors: ['A box query was already in progress; try again once it finishes.'] })
      .where(eq(panelRuns.id, runId))
      .run();
    return runId;
  }
  if (params.trigger === 'nightly_radar' && nightlyPanelRunning) {
    db.update(panelRuns)
      .set({ status: 'failed', finishedAt: nowIso(), errors: ['A nightly panel run was already in progress; skipped this run.'] })
      .where(eq(panelRuns.id, runId))
      .run();
    return runId;
  }

  if (params.symbols.length === 0) {
    // Nothing resolved — a genuinely empty candidate set, not a failure of
    // the panel itself. Marked 'failed' (the enum has no third "nothing to
    // do" state) with an explanatory error rather than 'done', so an empty
    // run never reads as "checked, found nothing interesting".
    db.update(panelRuns)
      .set({ status: 'failed', finishedAt: nowIso(), errors: ['No symbols resolved for this run.'] })
      .where(eq(panelRuns.id, runId))
      .run();
    return runId;
  }

  if (params.trigger === 'box_query') boxQueryRunning = true;
  if (params.trigger === 'nightly_radar') nightlyPanelRunning = true;

  void executePanelRun(runId, params.symbols)
    .catch((err) => {
      // Last-resort catch — executePanelRun's own try/catch already
      // attributes every per-symbol and budget failure to a specific cause
      // and always reaches its own final status update. This only fires on
      // something that escaped that (a bug in the orchestration itself), so
      // the run doesn't hang at 'running' forever with no explanation.
      db.update(panelRuns)
        .set({ status: 'failed', finishedAt: nowIso(), errors: [err instanceof Error ? err.message : String(err)] })
        .where(eq(panelRuns.id, runId))
        .run();
    })
    .finally(() => {
      if (params.trigger === 'box_query') boxQueryRunning = false;
      if (params.trigger === 'nightly_radar') nightlyPanelRunning = false;
    });

  return runId;
}

async function executePanelRun(runId: string, symbols: string[]): Promise<void> {
  const callBudgeted = withPanelBudget(runId);
  const errors: string[] = [];
  let completed = 0;
  let hitBudget = false;

  await mapLimit(symbols, config.panel.symbolConcurrency, async (symbol) => {
    // Once the shared budget is blown, don't start any symbol that hasn't
    // begun yet — mapLimit's workers each check this before pulling their
    // next item, so an exhausted budget stops new work within one symbol's
    // worth of latency rather than only after every worker happens to hit
    // the cap independently. Recorded explicitly, not silently — without
    // this, a skipped symbol has no panelSymbolAnalyses row and no errors
    // entry naming it, so a client has no way to tell "never got to this
    // one" apart from "still in progress" while polling a finished run.
    if (hitBudget) {
      errors.push(`${symbol}: skipped — panel budget already exhausted`);
      return;
    }
    try {
      await runPanelForSymbol(callBudgeted, runId, symbol);
      completed += 1;
    } catch (err) {
      if (err instanceof PanelBudgetExceeded) {
        hitBudget = true;
        errors.push(err.message);
        return;
      }
      errors.push(`${symbol}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  const status = completed === 0 ? 'failed' : hitBudget || errors.length > 0 ? 'partial' : 'done';
  db.update(panelRuns).set({ status, finishedAt: nowIso(), errors }).where(eq(panelRuns.id, runId)).run();
}
