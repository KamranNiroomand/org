import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';

/**
 * The paper book lives on the always-on runner (see role.ts's
 * `ownsPaperBook`); a reader serves the SAME routes by forwarding them
 * verbatim to the runner's server. One writer, one database, and the UI
 * a person actually looks at keeps working unchanged.
 *
 * Registered INSTEAD of paper.ts's local routes on proxying readers —
 * never alongside them. GETs and POSTs forward method, path, query, and
 * JSON body; the runner's status code and body come back untouched, so
 * error semantics (400 PaperError messages, 409 role refusals) survive
 * the hop. A runner that is unreachable answers 503 with a reason a
 * person can act on, rather than hanging the UI.
 */

const FORWARD_TIMEOUT_MS = 120_000;

async function forward(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const base = config.market.runnerHttpUrl;
  if (!base) {
    await reply.code(500).send({ error: 'paperProxy registered without MARKET_RUNNER_HTTP_URL' });
    return;
  }
  const search = req.raw.url?.includes('?') ? req.raw.url.slice(req.raw.url.indexOf('?')) : '';
  const url = `${base}${req.url.split('?')[0]}${search}`;
  try {
    const res = await fetch(url, {
      method: req.method,
      headers: { 'content-type': 'application/json' },
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : JSON.stringify(req.body ?? {}),
      signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
    });
    const text = await res.text();
    reply.code(res.status).header('content-type', res.headers.get('content-type') ?? 'application/json');
    await reply.send(text.length > 0 ? text : undefined);
  } catch (err) {
    await reply.code(503).send({
      error:
        `The trading machine (${base}) is unreachable — the paper book lives there. ` +
        `${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

export async function paperProxyRoutes(app: FastifyInstance): Promise<void> {
  for (const prefix of ['/api/paper', '/api/stocks']) {
    app.all(`${prefix}`, forward);
    app.all(`${prefix}/*`, forward);
  }
}
