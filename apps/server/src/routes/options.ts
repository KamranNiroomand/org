import type { FastifyInstance } from 'fastify';
import { desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../config.js';
import { marketDb } from '../db/market/index.js';
import { captureRuns, modelRuns, optionQuotes, trackedUnderlyings } from '../db/market/schema.js';
import {
  getLastCaptureResult,
  getNextCaptureRun,
  runOptionsCapture,
} from '../lib/scheduler.js';
import { listUniverse, retierByLiquidity } from '../lib/options/universe.js';
import { nowIso } from '../lib/util.js';
import { auditForLeakage } from '../lib/agents/leakageAudit.js';
import { quantHealthy } from '../lib/quant.js';

/**
 * Status and control for the options corpus.
 *
 * Read-heavy on purpose. The corpus may be produced on a different machine and
 * reach this one through a synced folder, in which case this server is a
 * reader and the write endpoints below are simply never called here.
 */
export async function optionsRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Everything the UI needs to answer "is this thing actually running?" —
   * which, while there is no model yet, is the only honest question to ask.
   */
  app.get('/api/options/status', async () => {
    const days = marketDb
      .select({
        day: optionQuotes.tradingDay,
        quotes: sql<number>`count(*)`,
        liquid: sql<number>`sum(case when ${optionQuotes.liquid} then 1 else 0 end)`,
        priced: sql<number>`sum(case when ${optionQuotes.ivBps} is not null then 1 else 0 end)`,
      })
      .from(optionQuotes)
      .groupBy(optionQuotes.tradingDay)
      .orderBy(desc(optionQuotes.tradingDay))
      .limit(30)
      .all();

    const totals = marketDb
      .select({
        quotes: sql<number>`count(*)`,
        firstDay: sql<string | null>`min(${optionQuotes.tradingDay})`,
        lastDay: sql<string | null>`max(${optionQuotes.tradingDay})`,
      })
      .from(optionQuotes)
      .get();

    const universe = marketDb
      .select({ tier: trackedUnderlyings.tier, n: sql<number>`count(*)` })
      .from(trackedUnderlyings)
      .groupBy(trackedUnderlyings.tier)
      .all();

    const lastRun = marketDb
      .select()
      .from(captureRuns)
      .orderBy(desc(captureRuns.startedAt))
      .limit(1)
      .get();

    return {
      configured: config.market.configured,
      role: config.market.role,
      dataDir: config.market.dataDir,
      quantUp: await quantHealthy(),
      nextCapture: getNextCaptureRun(),
      lastCapture: getLastCaptureResult(),
      lastRun: lastRun ?? null,
      universe: Object.fromEntries(universe.map((u) => [u.tier, u.n])),
      /**
       * `days` is the number that matters most right now. The corpus can only
       * grow forward — a night not captured is a night gone — so a gap here is
       * permanent, and worth surfacing rather than discovering later.
       */
      totals: totals ?? { quotes: 0, firstDay: null, lastDay: null },
      days,
    };
  });

  app.get('/api/options/universe', async (req) => {
    const tier = (req.query as { tier?: string }).tier;
    return listUniverse({ tier: tier === 'core' || tier === 'research' ? tier : undefined });
  });

  /** Manual capture, for a first run or to fill in after the machine slept. */
  app.post('/api/options/capture', async (_req, reply) => {
    if (!config.market.isRunner) {
      return reply
        .code(409)
        .send({ error: 'This machine is a reader; capture runs on the runner machine.' });
    }
    if (!config.market.configured) {
      return reply.code(400).send({ error: 'POLYGON_API_KEY is not set' });
    }
    return runOptionsCapture(app.log, 'manual');
  });

  /**
   * Replaces the seeded tier guess with measured liquidity. Only meaningful
   * once capture has run for a while, which is why it is not automatic.
   */
  app.post('/api/options/retier', async () => retierByLiquidity());

  /**
   * The leakage auditor — an offline critique step, never in the live
   * prediction path. Reviews a feature, label, or backtest config for
   * lookahead, survivorship, and cost-optimism risk before a human trusts a
   * result trained on it. See lib/agents/leakageAudit.ts.
   */
  app.post('/api/quant/audit', async (req, reply) => {
    const parsed = z
      .object({
        name: z.string().min(1),
        kind: z.enum(['feature', 'label', 'backtest_config', 'cv_config', 'other']),
        sourceCode: z.string().min(1),
        description: z.string().optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: z.prettifyError(parsed.error) });

    if (!config.anthropic.configured) {
      return reply.code(503).send({ error: 'ANTHROPIC_API_KEY is not set — the leakage auditor cannot run.' });
    }

    try {
      return await auditForLeakage(parsed.data);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      app.log.error({ err }, 'Leakage audit failed');
      return reply.code(502).send({ error: message });
    }
  });

  /** Trained runs — challenger vs champion, per target. */
  app.get('/api/quant/runs', async (req) => {
    const target = (req.query as { target?: string }).target;
    return marketDb
      .select()
      .from(modelRuns)
      .where(target ? eq(modelRuns.target, target) : undefined)
      .orderBy(desc(modelRuns.registeredAt))
      .all();
  });

  /**
   * Manual promotion — a run becomes champion only when a person says so,
   * per the project plan's champion/shadow/promote policy. Never automatic
   * on an in-sample metric.
   */
  app.post<{ Params: { runId: string } }>('/api/quant/runs/:runId/promote', async (req, reply) => {
    const run = marketDb.select().from(modelRuns).where(eq(modelRuns.runId, req.params.runId)).get();
    if (!run) return reply.code(404).send({ error: 'Unknown run' });

    marketDb.transaction((tx) => {
      // Only one champion per target at a time.
      tx.update(modelRuns)
        .set({ status: 'retired' })
        .where(sql`${modelRuns.target} = ${run.target} and ${modelRuns.status} = 'champion'`)
        .run();
      tx.update(modelRuns)
        .set({ status: 'champion', promotedAt: nowIso() })
        .where(eq(modelRuns.runId, req.params.runId))
        .run();
    });
    return { ok: true };
  });
}
