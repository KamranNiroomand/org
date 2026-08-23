import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/index.js';
import { realEstateRuns } from '../db/schema.js';
import { config } from '../config.js';
import { QuantUnavailable } from '../lib/quant.js';
import { startRealEstateRun } from '../lib/agents/realestate/run.js';
import { RE_DISCLAIMER, type Province } from '../lib/agents/realestate/types.js';

const PROPERTY_INPUT_SCHEMA = z.object({
  address: z.string().min(1).max(300),
  askingPriceCents: z.number().int().positive(),
  propertyType: z.string().min(1).max(80),
  beds: z.number().int().nonnegative().nullable(),
  baths: z.number().nonnegative().nullable(),
  sqft: z.number().int().positive().nullable(),
  yearBuilt: z.number().int().nullable(),
  hoaFeeCentsMonthly: z.number().int().nonnegative().default(0),
  estimatedAnnualPropertyTaxCents: z.number().int().nonnegative(),
  estimatedAnnualInsuranceCents: z.number().int().nonnegative().default(120_000),
  downPaymentPct: z.number().min(5).max(100),
  mortgageRatePct: z.number().positive().max(30),
  amortizationYears: z.number().int().positive().max(35).default(25),
  expectedMonthlyRentCents: z.number().int().nonnegative().default(0),
  marginalTaxRatePct: z.number().min(0).max(75),
  province: z.enum(['ON', 'OTHER']).default('OTHER'),
  city: z.string().max(120).nullable().default(null),
  isPrimaryResidence: z.boolean().default(true),
  realtorCommissionPct: z.number().min(0).max(20).default(5),
  legalFeesCents: z.number().int().nonnegative().default(150_000),
  otherClosingCostsCents: z.number().int().nonnegative().default(80_000),
  maintenanceReservePct: z.number().min(0).max(50).default(5),
  vacancyAllowancePct: z.number().min(0).max(50).default(4),
  propertyMgmtFeePct: z.number().min(0).max(50).default(0),
  listingDescription: z.string().max(20_000).nullable().default(null),
});

export async function realEstateRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Kick off one property's analysis. Returns 202 immediately with the run
   * id — the client polls GET /api/realestate/:runId for status, same
   * "kick off, poll" shape as the stock panel's box query.
   */
  app.post('/api/realestate/analyze', async (req, reply) => {
    const parsed = PROPERTY_INPUT_SCHEMA.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: z.prettifyError(parsed.error) });
    if (!config.anthropic.configured) return reply.code(503).send({ error: 'ANTHROPIC_API_KEY is not set.' });

    const input = { ...parsed.data, province: parsed.data.province as Province };
    try {
      const runId = await startRealEstateRun(input);
      return reply.code(202).send({ runId, disclaimer: RE_DISCLAIMER });
    } catch (err) {
      if (err instanceof QuantUnavailable) return reply.code(503).send({ error: err.message });
      throw err;
    }
  });

  /** One run's full detail, exactly as persisted — nothing re-summarized here. */
  app.get<{ Params: { runId: string } }>('/api/realestate/:runId', async (req, reply) => {
    const run = db.select().from(realEstateRuns).where(eq(realEstateRuns.id, req.params.runId)).get();
    if (!run) return reply.code(404).send({ error: 'Unknown real-estate run' });
    return { run, disclaimer: RE_DISCLAIMER };
  });

  /** Run history, most recent first. */
  app.get('/api/realestate', async () => ({
    runs: db.select().from(realEstateRuns).orderBy(desc(realEstateRuns.startedAt)).limit(30).all(),
  }));
}
