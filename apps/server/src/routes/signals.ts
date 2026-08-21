import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { db } from '../db/index.js';
import { radarRuns, radarScores } from '../db/schema.js';
import { RADAR_DISCLAIMER } from '../lib/radar/score.js';
import { runRadarScoring } from '../lib/radar/run.js';
import { getLastRadarResult, getNextRadarRun } from '../lib/scheduler.js';
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
}
