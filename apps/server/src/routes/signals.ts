import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/index.js';
import { panelAgentTurns, panelRuns, panelSymbolAnalyses, radarRuns, radarScores } from '../db/schema.js';
import { config } from '../config.js';
import { RADAR_DISCLAIMER } from '../lib/radar/score.js';
import { runRadarScoring } from '../lib/radar/run.js';
import { getLastPanelRunId, getLastRadarResult, getNextPanelRun, getNextRadarRun } from '../lib/scheduler.js';
import { resolveBoxQuery } from '../lib/agents/panel/boxResolve.js';
import { startPanelRun } from '../lib/agents/panel/run.js';
import { PANEL_DISCLAIMER } from '../lib/agents/panel/types.js';
import { todayKey } from '../lib/util.js';

export async function signalsRoutes(app: FastifyInstance): Promise<void> {
  /** Today's shortlist, ranked. The disclaimer travels with the data on every response, not just the UI. */
  app.get<{ Querystring: { day?: string } }>('/api/signals/radar', async (req) => {
    const day = req.query.day ?? todayKey();
    const items = db
      .select()
      .from(radarScores)
      .where(eq(radarScores.tradingDay, day))
      .orderBy(radarScores.rank)
      .all();
    return { day, disclaimer: RADAR_DISCLAIMER, items };
  });

  /** Manual trigger, matching the existing /api/signals/evaluate and /api/investments/market/sweep pattern. */
  app.post('/api/signals/radar/run', async () => runRadarScoring());

  /** Run history, most recent first — for a future "radar health" surface, matching /api/options/status. */
  app.get('/api/signals/radar/runs', async () => ({
    lastRun: getLastRadarResult(),
    nextRun: getNextRadarRun(),
    runs: db.select().from(radarRuns).orderBy(desc(radarRuns.startedAt)).limit(30).all(),
  }));

  /**
   * The box: resolve a ticker/company name or an open-ended question to a
   * bounded symbol list, then kick off a panel run over it. Returns 202
   * immediately with the run id — the client polls
   * GET /api/signals/panel/:runId for status, same shape as the options
   * side's capture-status polling.
   */
  app.post('/api/signals/box', async (req, reply) => {
    const parsed = z.object({ query: z.string().min(2).max(200) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: z.prettifyError(parsed.error) });
    if (!config.anthropic.configured) return reply.code(503).send({ error: 'ANTHROPIC_API_KEY is not set.' });

    const resolution = await resolveBoxQuery(parsed.data.query);
    const runId = startPanelRun({
      trigger: 'box_query',
      query: parsed.data.query,
      resolutionMethod: resolution.resolutionMethod,
      symbols: resolution.symbols,
    });
    return reply
      .code(202)
      .send({ runId, resolvedSymbols: resolution.symbols, normalizedTheme: resolution.normalizedTheme, disclaimer: PANEL_DISCLAIMER });
  });

  /** One panel run's full detail — every symbol's synthesis plus the literal
   * reasoning behind it (both rounds, all four specialists). Nothing here is
   * re-summarized by the route; it's exactly what got persisted. */
  app.get<{ Params: { runId: string } }>('/api/signals/panel/:runId', async (req, reply) => {
    const run = db.select().from(panelRuns).where(eq(panelRuns.id, req.params.runId)).get();
    if (!run) return reply.code(404).send({ error: 'Unknown panel run' });

    const analyses = db.select().from(panelSymbolAnalyses).where(eq(panelSymbolAnalyses.runId, run.id)).all();
    const analysesWithTurns = analyses.map((analysis) => ({
      ...analysis,
      turns: db
        .select()
        .from(panelAgentTurns)
        .where(eq(panelAgentTurns.analysisId, analysis.id))
        .orderBy(panelAgentTurns.round)
        .all(),
    }));

    return { run, analyses: analysesWithTurns, disclaimer: PANEL_DISCLAIMER };
  });

  /** Run history, most recent first. */
  app.get('/api/signals/panel', async () => ({
    lastRunId: getLastPanelRunId(),
    nextRun: getNextPanelRun(),
    runs: db.select().from(panelRuns).orderBy(desc(panelRuns.startedAt)).limit(30).all(),
  }));
}
