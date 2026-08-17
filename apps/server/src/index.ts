import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import Fastify from 'fastify';
import { config } from './config.js';
import { runMigrations } from './db/migrate.js';
import { registerAuth } from './auth.js';
import { registerRoutes } from './routes/index.js';
import { startScheduler } from './lib/scheduler.js';

const app = Fastify({
  logger: {
    level: 'info',
    transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } },
  },
});

async function main() {
  runMigrations();

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
