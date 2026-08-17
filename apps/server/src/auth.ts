import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { config } from './config.js';

/**
 * Authentication exists only when the app is bound to the LAN. On localhost
 * there is nothing to defend against that a password would help with — anything
 * able to reach 127.0.0.1 can already read `~/.org/org.db` directly.
 *
 * When `BIND_LAN=true`, config.ts has already refused to boot without a
 * password, so `config.password` is non-null here.
 */

const SESSION_COOKIE = 'org_session';
const secret = randomBytes(32); // Rotates per restart, invalidating old sessions.

function sign(value: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

function makeToken(): string {
  const issued = String(Date.now());
  return `${issued}.${sign(issued)}`;
}

function verifyToken(token: string | undefined): boolean {
  if (!token) return false;
  const [issued, mac] = token.split('.');
  if (!issued || !mac) return false;

  const expected = sign(issued);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;

  // Thirty days, matching the cookie's own lifetime.
  return Date.now() - Number(issued) < 30 * 86_400_000;
}

/** Constant-time password comparison, so timing can't leak the password. */
function passwordMatches(given: string): boolean {
  if (!config.password) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(config.password);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function registerAuth(app: FastifyInstance): Promise<void> {
  app.get('/api/auth/status', async () => ({
    required: config.bindLan,
    configured: Boolean(config.password),
  }));

  app.post<{ Body: { password?: string } }>('/api/auth/login', async (req, reply) => {
    if (!config.bindLan) return { ok: true };

    if (!passwordMatches(req.body?.password ?? '')) {
      return reply.code(401).send({ error: 'Incorrect password' });
    }

    reply.setCookie(SESSION_COOKIE, makeToken(), {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 30 * 86_400,
    });
    return { ok: true };
  });

  app.post('/api/auth/logout', async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  if (!config.bindLan) return;

  app.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/api/auth/') || req.url === '/api/health') return;
    if (!req.url.startsWith('/api/')) return;

    if (!verifyToken(req.cookies[SESSION_COOKIE])) {
      return reply.code(401).send({ error: 'Not authenticated' });
    }
  });
}
