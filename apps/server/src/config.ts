import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * Environment parsing. Anything invalid stops the process here rather than
 * surfacing as a confusing failure ten minutes into a bank sync.
 */

const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(5174),
  BIND_LAN: bool,
  APP_PASSWORD: z.string().optional(),
  DB_PATH: z.string().optional(),

  PLAID_ENV: z.enum(['sandbox', 'production']).default('sandbox'),
  PLAID_CLIENT_ID: z.string().optional(),
  PLAID_SECRET: z.string().optional(),
  PLAID_COUNTRY_CODES: z.string().default('CA,US'),
  SYNC_CRON: z.string().default('0 6 * * *'),

  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-opus-5'),

  DEFAULT_CALENDAR: z.enum(['miladi', 'shamsi']).default('miladi'),
  BASE_CURRENCY: z.string().default('CAD'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment:\n' + z.prettifyError(parsed.error));
  process.exit(1);
}
const env = parsed.data;

/**
 * Binding to the LAN puts a database of bank transactions on whatever network
 * you happen to be joined to. The password isn't optional in that case — the
 * two ship together or not at all.
 */
if (env.BIND_LAN && !env.APP_PASSWORD) {
  console.error(
    'BIND_LAN=true exposes this app — and your financial data — to your local\n' +
      'network. Set APP_PASSWORD in .env, or set BIND_LAN=false to stay on\n' +
      'localhost only.',
  );
  process.exit(1);
}

export const config = {
  port: env.PORT,
  host: env.BIND_LAN ? '0.0.0.0' : '127.0.0.1',
  bindLan: env.BIND_LAN,
  password: env.APP_PASSWORD ?? null,

  /** Outside the repo by default, so it can never be committed by accident. */
  dbPath: env.DB_PATH ?? join(homedir(), '.org', 'org.db'),
  dbDir: env.DB_PATH ? join(env.DB_PATH, '..') : join(homedir(), '.org'),

  plaid: {
    env: env.PLAID_ENV,
    clientId: env.PLAID_CLIENT_ID ?? null,
    secret: env.PLAID_SECRET ?? null,
    countryCodes: env.PLAID_COUNTRY_CODES.split(',').map((c) => c.trim()).filter(Boolean),
    configured: Boolean(env.PLAID_CLIENT_ID && env.PLAID_SECRET),
  },

  anthropic: {
    apiKey: env.ANTHROPIC_API_KEY ?? null,
    model: env.ANTHROPIC_MODEL,
    configured: Boolean(env.ANTHROPIC_API_KEY),
  },

  syncCron: env.SYNC_CRON,
  defaultCalendar: env.DEFAULT_CALENDAR,
  baseCurrency: env.BASE_CURRENCY,
} as const;

export type Config = typeof config;
