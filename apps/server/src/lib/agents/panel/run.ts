import { eq } from 'drizzle-orm';
import { db } from '../../../db/index.js';
import { panelAgentTurns, panelRuns, panelSymbolAnalyses } from '../../../db/schema.js';
import { config } from '../../../config.js';
import { mapLimit } from '../../options/polygon.js';
import { newId, nowIso } from '../../util.js';
import { buildSymbolContext } from './context.js';
import { runRound1, runRound2 } from './specialists.js';
import { runSynthesis } from './synthesize.js';
import { PANEL_AGENT_CONCURRENCY, PanelBudgetExceeded, withBudget, type CallBudgeted } from './budget.js';
import { SPECIALISTS, type Round1Turn, type Round2Turn } from './types.js';

/**
 * Orchestrates one symbol end to end: round 1 (4 parallel, independent
 * calls) → persist those turns → round 2 (4 parallel calls, each reading
 * round 1's real transcript) → persist those turns → synthesis → update the
 * symbol's `panelSymbolAnalyses` row with the real verdict.
 *
 * The analysis row is created with placeholder values *before* any call
 * runs, not after — so a crash partway through (a budget exhaustion, a
 * network failure) still leaves the turns that did complete attached to a
 * real row, readable via `GET /api/signals/panel/:runId`, rather than
 * orphaned or lost because the parent row was never inserted.
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
      createdAt: nowIso(),
    })
    .run();

  const round1 = await mapLimit(SPECIALISTS, PANEL_AGENT_CONCURRENCY, (agent) =>
    callBudgeted(() => runRound1(agent, ctx)),
  );
  persistTurns(analysisId, 1, round1);

  const round2 = await mapLimit(SPECIALISTS, PANEL_AGENT_CONCURRENCY, (agent) =>
    callBudgeted(() => runRound2(agent, ctx, round1)),
  );
  persistTurns(analysisId, 2, round2);

  const synthesis = await callBudgeted(() => runSynthesis(ctx, round1, round2));
  db.update(panelSymbolAnalyses)
    .set({
      stance: synthesis.stance,
      summary: synthesis.summary,
      agreements: synthesis.agreements,
      disagreements: synthesis.disagreements,
      openQuestions: synthesis.openQuestions,
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

/** Guards against a second box query while one is already running —
 * same shape as `capturing`/`watchlistTextSyncing` in scheduler.ts. Scoped
 * to box queries only: the nightly radar-triggered run and a box query
 * overlapping is an unlikely timing coincidence, not the double-click a
 * person can actually trigger by hand, so it isn't worth rejecting. */
let boxQueryRunning = false;

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
    });

  return runId;
}

async function executePanelRun(runId: string, symbols: string[]): Promise<void> {
  const callBudgeted = withBudget(runId);
  const errors: string[] = [];
  let completed = 0;
  let hitBudget = false;

  await mapLimit(symbols, config.panel.symbolConcurrency, async (symbol) => {
    // Once the shared budget is blown, don't start any symbol that hasn't
    // begun yet — mapLimit's workers each check this before pulling their
    // next item, so an exhausted budget stops new work within one symbol's
    // worth of latency rather than only after every worker happens to hit
    // the cap independently.
    if (hitBudget) return;
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
