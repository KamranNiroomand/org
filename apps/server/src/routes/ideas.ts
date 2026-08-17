import { desc, eq, like, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/index.js';
import { ideaLinks, ideas } from '../db/schema.js';
import { newId, nowIso } from '../lib/util.js';
import { patchOf } from './_shared.js';

const body = z.object({
  title: z.string().min(1).max(500),
  body: z.string().max(200_000).default(''),
  tags: z.array(z.string()).default([]),
  status: z.enum(['seed', 'growing', 'parked', 'shipped']).default('seed'),
});

/** Pulls `[[wikilink]]` targets out of markdown. */
export function extractWikilinks(markdown: string): string[] {
  return [...markdown.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]!.trim()).filter(Boolean);
}

export async function ideaRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { q?: string; tag?: string; status?: string } }>(
    '/api/ideas',
    async (req) => {
      const { q, tag, status } = req.query;

      let rows = db
        .select()
        .from(ideas)
        .where(
          q
            ? or(like(ideas.title, `%${q}%`), like(ideas.body, `%${q}%`))
            : status
              ? eq(ideas.status, status as 'seed' | 'growing' | 'parked' | 'shipped')
              : undefined,
        )
        .orderBy(desc(ideas.updatedAt))
        .all();

      if (tag) rows = rows.filter((r) => r.tags.includes(tag));
      return rows;
    },
  );

  app.get<{ Params: { id: string } }>('/api/ideas/:id', async (req, reply) => {
    const row = db.select().from(ideas).where(eq(ideas.id, req.params.id)).get();
    if (!row) return reply.code(404).send({ error: 'Idea not found' });

    const links = db.select().from(ideaLinks).where(eq(ideaLinks.ideaId, row.id)).all();

    // Backlinks: other ideas whose text mentions this one by title. Cheap
    // enough at personal scale, and it means links work without bookkeeping.
    const backlinks = db
      .select({ id: ideas.id, title: ideas.title })
      .from(ideas)
      .where(like(ideas.body, `%[[${row.title}]]%`))
      .all();

    return { ...row, links, backlinks, wikilinks: extractWikilinks(row.body) };
  });

  app.post('/api/ideas', async (req, reply) => {
    const parsed = body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: z.prettifyError(parsed.error) });

    const ts = nowIso();
    const row = { id: newId(), ...parsed.data, createdAt: ts, updatedAt: ts };
    db.insert(ideas).values(row).run();
    return reply.code(201).send(row);
  });

  app.patch<{ Params: { id: string } }>('/api/ideas/:id', async (req, reply) => {
    const parsed = patchOf(body).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: z.prettifyError(parsed.error) });

    const d = parsed.data;
    db.update(ideas)
      .set({
        ...(d.title !== undefined && { title: d.title }),
        ...(d.body !== undefined && { body: d.body }),
        ...(d.tags !== undefined && { tags: d.tags }),
        ...(d.status !== undefined && { status: d.status }),
        updatedAt: nowIso(),
      })
      .where(eq(ideas.id, req.params.id))
      .run();

    const row = db.select().from(ideas).where(eq(ideas.id, req.params.id)).get();
    return row ?? reply.code(404).send({ error: 'Idea not found' });
  });

  app.delete<{ Params: { id: string } }>('/api/ideas/:id', async (req, reply) => {
    db.delete(ideas).where(eq(ideas.id, req.params.id)).run();
    return reply.code(204).send();
  });
}
