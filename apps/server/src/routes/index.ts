import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { encryptionAvailable } from '../crypto.js';
import { seedDefaultRules } from '../lib/categorize.js';
import { calendarRoutes } from './calendar.js';
import { financeRoutes } from './finance.js';
import { claudeRoutes } from './claude.js';
import { plaidRoutes } from './plaid.js';
import { ideaRoutes } from './ideas.js';
import { investmentRoutes } from './investments.js';
import { optionsRoutes } from './options.js';
import { paperRoutes } from './paper.js';
import { projectRoutes } from './projects.js';
import { stickyRoutes } from './stickies.js';
import { taskRoutes } from './tasks.js';
import { watchlistRoutes } from './watchlist.js';

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  seedDefaultRules();

  app.get('/api/health', async () => ({
    ok: true,
    version: '0.1.0',
    defaultCalendar: config.defaultCalendar,
    baseCurrency: config.baseCurrency,
    features: {
      plaid: config.plaid.configured,
      plaidEnv: config.plaid.env,
      claude: config.anthropic.configured,
      // Surfaced so the UI can explain why connecting a bank is unavailable,
      // rather than failing at the moment the user tries.
      encryption: encryptionAvailable(),
    },
  }));

  await app.register(taskRoutes);
  await app.register(projectRoutes);
  await app.register(stickyRoutes);
  await app.register(calendarRoutes);
  await app.register(financeRoutes);
  await app.register(investmentRoutes);
  await app.register(watchlistRoutes);
  await app.register(optionsRoutes);
  await app.register(paperRoutes);
  await app.register(ideaRoutes);
  await app.register(claudeRoutes);
  await app.register(plaidRoutes);
}
