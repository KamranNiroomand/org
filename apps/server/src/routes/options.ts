import type { FastifyInstance } from 'fastify';
import { desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../config.js';
import { marketDb } from '../db/market/index.js';
import { captureRuns, documents, modelRuns, optionQuotes, trackedUnderlyings } from '../db/market/schema.js';
import {
  getLastCaptureResult,
  getNextCaptureRun,
  getLastRetrainResult,
  getNextRetrainRun,
  getLastTextSyncResult,
  getNextTextSyncRun,
  getLastExitRecheckResult,
  getNextExitRecheckRun,
  runOptionsCapture,
  runRetrain,
  runTextSync,
} from '../lib/scheduler.js';
import { listUniverse, retierByLiquidity } from '../lib/options/universe.js';
import { repriceDay } from '../lib/options/reprice.js';
import { pullMarketSnapshot } from '../lib/options/marketPull.js';
import { nowIso, todayKey } from '../lib/util.js';
import { auditForLeakage } from '../lib/agents/leakageAudit.js';
import { narrateSignal } from '../lib/agents/narrate.js';
import { proposeHypotheses } from '../lib/agents/hypotheses.js';
import { modelPerformance, quantHealthy, rankDay, QuantRefusal, QuantUnavailable } from '../lib/quant.js';

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

    /**
     * `symbolsDone` counts symbols *attempted*, not symbols that actually
     * wrote a quote — a run can say `symbolsDone: 566` while well over half
     * of them silently 429'd. `symbolsFailed` (a real column — see
     * capture.ts's own status-write comment) is what tells the UI whether
     * "done" really means done.
     */
    const lastRun = marketDb
      .select()
      .from(captureRuns)
      .orderBy(desc(captureRuns.startedAt))
      .limit(1)
      .get();

    const text = marketDb
      .select({
        total: sql<number>`count(*)`,
        news: sql<number>`sum(case when ${documents.source} = 'polygon_news' then 1 else 0 end)`,
        edgar: sql<number>`sum(case when ${documents.source} = 'edgar' then 1 else 0 end)`,
        classified: sql<number>`sum(case when ${documents.eventType} is not null then 1 else 0 end)`,
      })
      .from(documents)
      .get();

    return {
      configured: config.market.configured,
      role: config.market.role,
      dataDir: config.market.dataDir,
      quantUp: await quantHealthy(),
      nextCapture: getNextCaptureRun(),
      lastCapture: getLastCaptureResult(),
      nextRetrain: getNextRetrainRun(),
      lastRetrain: getLastRetrainResult(),
      nextTextSync: getNextTextSyncRun(),
      lastTextSync: getLastTextSyncResult(),
      nextExitRecheck: getNextExitRecheckRun(),
      lastExitRecheck: getLastExitRecheckResult(),
      lastRun: lastRun ?? null,
      text: text ?? { total: 0, news: 0, edgar: 0, classified: 0 },
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

  /** Manual retrain — the weekly cron calls the same function. */
  app.post('/api/quant/retrain', async (_req, reply) => {
    if (!config.market.isRunner) {
      return reply
        .code(409)
        .send({ error: 'This machine is a reader; training runs on the runner, which holds the corpus.' });
    }
    return runRetrain(app.log, 'manual');
  });

  /** Manual news/EDGAR sync — the market-hours cron calls the same function. */
  app.post('/api/options/text-sync', async (_req, reply) => {
    if (!config.market.isRunner) {
      return reply
        .code(409)
        .send({ error: 'This machine is a reader; text ingestion writes to market.db, which only the runner may write.' });
    }
    return runTextSync(app.log, 'manual');
  });

  /**
   * Manual snapshot pull — the reader's nightly job calls the same
   * function. Deliberately an in-process call rather than pointing the UI
   * at `npm run market:pull`: that CLI script is a separate process with
   * its own `marketDb` connection, so it can reopen only *its own*
   * short-lived handle — never the already-running server's, which is the
   * one actually answering every other request. Calling `pullMarketSnapshot`
   * from inside this handler is what lets `reopenMarketDb` reach the
   * connection that matters.
   */
  app.post('/api/options/pull', async (_req, reply) => {
    try {
      const result = await pullMarketSnapshot();
      if (!result.ok) return reply.code(409).send({ error: result.message });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      app.log.error({ err }, 'Manual pull failed');
      return reply.code(502).send({ error: message });
    }
  });

  /**
   * Replaces the seeded tier guess with measured liquidity. Only meaningful
   * once capture has run for a while, which is why it is not automatic.
   */
  app.post('/api/options/retier', async () => retierByLiquidity());

  /** The skew reader agent — STANDALONE research layer (user's design:
   * nothing in the engines reads its verdicts). POST runs it over
   * today's map shortlist; GET returns the day's verdicts. */
  app.post('/api/options/skew-agent', async (_req, reply) => {
    const { runSkewReader } = await import('../lib/agents/skewReader.js');
    const { sql: dsql } = await import('drizzle-orm');
    const { optionQuotes: oq } = await import('../db/market/schema.js');
    const day = marketDb.select({ d: dsql<string | null>`max(${oq.tradingDay})` }).from(oq).get()?.d;
    if (!day) return reply.code(503).send({ error: 'No captured chains yet.' });
    try {
      const res = await fetch(`${config.market.quantUrl}/options/skew`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ day }),
        signal: AbortSignal.timeout(300_000),
      });
      if (!res.ok) return reply.code(503).send({ error: `quant ${res.status}` });
      const map = (await res.json()) as { rows: Array<Record<string, unknown>> };
      const { paperDb } = await import('../db/paper/index.js');
      const { paperOrders, stockOrders } = await import('../db/paper/schema.js');
      const { eq: deq } = await import('drizzle-orm');
      const held = new Set<string>();
      for (const o of paperDb.select().from(paperOrders).where(deq(paperOrders.status, 'open')).all())
        held.add(o.underlying ?? o.occSymbol.slice(0, 6).trim());
      for (const o of paperDb.select().from(stockOrders).where(deq(stockOrders.status, 'open')).all())
        held.add(o.symbol);
      const rows = map.rows
        .filter((r) => r.chain_ok && !r.suspect)
        .map((r) => ({ ...(r as object), held: held.has(String(r.symbol)) })) as never[];
      return await runSkewReader(day, rows);
    } catch (err) {
      return reply.code(503).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/options/skew-agent', async (_req, reply) => {
    const { latestSkewReads } = await import('../lib/agents/skewReader.js');
    const { sql: dsql } = await import('drizzle-orm');
    const { optionQuotes: oq } = await import('../db/market/schema.js');
    const day = marketDb.select({ d: dsql<string | null>`max(${oq.tradingDay})` }).from(oq).get()?.d;
    if (!day) return reply.code(503).send({ error: 'No captured chains yet.' });
    return { day, reads: latestSkewReads(day) };
  });

  /** The skew map — what option traders are paying for, per name, per
   * day, in four quadrants. All math in the quant sidecar (skew.py);
   * this route only picks the day (latest captured unless given),
   * marks held names, and translates sidecar refusals into HTTP. */
  app.get<{ Querystring: { day?: string } }>('/api/options/skew', async (req, reply) => {
    const { sql } = await import('drizzle-orm');
    const { optionQuotes } = await import('../db/market/schema.js');
    const day =
      req.query.day ??
      marketDb
        .select({ d: sql<string | null>`max(${optionQuotes.tradingDay})` })
        .from(optionQuotes)
        .get()?.d;
    if (!day) return reply.code(503).send({ error: 'No captured chains yet.' });
    try {
      const res = await fetch(`${config.market.quantUrl}/options/skew`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ day }),
        signal: AbortSignal.timeout(300_000),
      });
      if (res.status === 409) {
        const body = (await res.json()) as { detail: string };
        return reply.code(503).send({ error: body.detail });
      }
      if (!res.ok) return reply.code(503).send({ error: `quant ${res.status}` });
      const map = (await res.json()) as { rows: Array<Record<string, unknown>> };
      const { paperDb } = await import('../db/paper/index.js');
      const { paperOrders, stockOrders } = await import('../db/paper/schema.js');
      const { eq } = await import('drizzle-orm');
      const held = new Set<string>();
      for (const o of paperDb.select().from(paperOrders).where(eq(paperOrders.status, 'open')).all()) {
        held.add(o.underlying ?? o.occSymbol.slice(0, 6).trim());
      }
      for (const o of paperDb.select().from(stockOrders).where(eq(stockOrders.status, 'open')).all()) {
        held.add(o.symbol);
      }
      for (const r of map.rows) r.held = held.has(String(r.symbol));
      return map;
    } catch (err) {
      return reply.code(503).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Recomputes IV/greeks for a day's already-captured quotes that came back
   * from capture unpriced — a rate-limited provider or a cold quant sidecar
   * leaves real rows with a null `iv_bps`. Never re-fetches from the vendor.
   */
  app.post('/api/options/reprice', async (req, reply) => {
    if (!config.market.isRunner) {
      return reply
        .code(409)
        .send({ error: 'This machine is a reader; pricing derives from the runner\'s own quotes.' });
    }
    const day = (req.query as { day?: string }).day ?? todayKey();
    return repriceDay(day);
  });

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

  /**
   * Explains one ranked contract's numbers in plain language. Never a price
   * predictor — see agents/narrate.ts. The caller supplies the already-
   * computed signal; this agent explains it, never recomputes it.
   */
  app.post('/api/quant/narrate', async (req, reply) => {
    const parsed = z
      .object({
        occSymbol: z.string().min(1),
        underlying: z.string().min(1),
        type: z.enum(['call', 'put']),
        strike: z.number().positive(),
        dte: z.number().int().positive(),
        marketPrice: z.number().positive(),
        marketIv: z.number().positive(),
        forecastVol: z.number().positive(),
        forecastDrift: z.number(),
        ev: z.number(),
        evPerRisk: z.number(),
        probProfit: z.number().min(0).max(1),
        modelBeatsBaseline: z.boolean(),
        modelInformationCoefficient: z.number(),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: z.prettifyError(parsed.error) });

    if (!config.anthropic.configured) {
      return reply.code(503).send({ error: 'ANTHROPIC_API_KEY is not set — the narrator cannot run.' });
    }

    try {
      return await narrateSignal(parsed.data);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      app.log.error({ err }, 'Narration failed');
      return reply.code(502).send({ error: message });
    }
  });

  /**
   * Proposes candidate features for a human to implement and test — never
   * implements or scores one. See agents/hypotheses.ts.
   */
  app.post('/api/quant/hypotheses', async (req, reply) => {
    const parsed = z
      .object({
        target: z.enum(['dir', 'vrp']),
        currentFeatureCols: z.array(z.string()).min(1),
        currentInformationCoefficient: z.number(),
        currentBeatsBaseline: z.boolean(),
        nSymbols: z.number().int().positive(),
        nTrainDays: z.number().int().positive(),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: z.prettifyError(parsed.error) });

    if (!config.anthropic.configured) {
      return reply.code(503).send({ error: 'ANTHROPIC_API_KEY is not set — the hypothesis generator cannot run.' });
    }

    try {
      return await proposeHypotheses(parsed.data);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      app.log.error({ err }, 'Hypothesis generation failed');
      return reply.code(502).send({ error: message });
    }
  });

  /**
   * The ranked signal board — every gate-passing contract for one trading
   * day, priced under the current model's forecast and sorted by expected
   * value. `force=true` by default: the model does not beat its own
   * out-of-fold baseline yet, and the caller must always get a board to
   * look at, with that fact attached to the response rather than hidden
   * behind a refusal — see rank.py's own module docstring.
   */
  app.get('/api/quant/rank', async (req, reply) => {
    const query = req.query as { day?: string; top?: string; force?: string; maxCapital?: string };
    const day = query.day ?? todayKey();
    const top = query.top ? Number(query.top) : 25;
    const force = query.force !== 'false';
    const maxCapital = query.maxCapital ? Number(query.maxCapital) : undefined;

    try {
      return await rankDay(day, top, force, maxCapital);
    } catch (err) {
      if (err instanceof QuantRefusal) return reply.code(409).send({ error: err.message });
      if (err instanceof QuantUnavailable) return reply.code(503).send({ error: err.message });
      const message = err instanceof Error ? err.message : 'Unknown error';
      app.log.error({ err }, 'Ranking failed');
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
  /**
   * Model-performance data for the dashboard. Thin on purpose — see
   * `modelPerformance` and performance.py on why the computation is not
   * here.
   */
  app.get('/api/quant/performance', async (req, reply) => {
    const query = req.query as { target?: string; run?: string };
    const target = typeof query?.target === 'string' ? query.target : 'dir';
    const run = typeof query?.run === 'string' ? query.run : undefined;
    try {
      return await modelPerformance(target, run);
    } catch (err) {
      if (err instanceof QuantUnavailable) {
        return reply.code(503).send({ error: `Quant service unavailable: ${err.message}` });
      }
      throw err;
    }
  });

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
