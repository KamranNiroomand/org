import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import Fastify from 'fastify';
import { config } from './config.js';
import { runMigrations } from './db/migrate.js';
import { runMarketMigrations } from './db/market/migrate.js';
import { runPaperMigrations } from './db/paper/migrate.js';
import { registerAuth } from './auth.js';
import { registerRoutes } from './routes/index.js';
import { startScheduler } from './lib/scheduler.js';
import { describeBootVersion, versionStatus } from './lib/version.js';

const app = Fastify({
  logger: {
    level: 'info',
    transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } },
  },
});

async function main() {
  runMigrations();
  // Every migration up to this point had been applied by hand during
  // development — this was the one call missing to make that automatic, the
  // same way the personal database already works.
  runMarketMigrations();
  runPaperMigrations();

  await app.register(cookie);
  await app.register(cors, {
    // The Vite dev server runs on a different port, so credentialed requests
    // need an explicit origin — `*` is not allowed with credentials.
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      const ok = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+)(:\d+)?$/.test(origin);
      cb(null, ok);
    },
    credentials: true,
  });

  await registerAuth(app);
  await registerRoutes(app);

  await app.listen({ port: config.port, host: config.host });

  startScheduler(app.log);

  const where = config.bindLan
    ? `http://${config.host}:${config.port} (LAN — password required)`
    : `http://127.0.0.1:${config.port} (localhost only)`;
  // First line after the port, deliberately: when something is wrong the
  // first question is "is this even the code I think it is?", and for a
  // week the log could not answer it. See lib/version.ts.
  app.log.info(describeBootVersion());
  const v = versionStatus();
  if (v.dirty) {
    app.log.warn('Working tree has uncommitted changes — the running code matches no commit exactly');
  }
  app.log.info(`Org server on ${where}`);
  app.log.info(`Database ${config.dbPath}`);
  app.log.info(
    `Plaid ${config.plaid.configured ? `configured (${config.plaid.env})` : 'not configured — add keys to .env'}`,
  );
}

main().catch((err) => {
  app.log.error(err);
  process.exit(1);
});
