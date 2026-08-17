import { asc, eq, max } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { STICKY_COLORS } from '@org/shared';
import { z } from 'zod';
import { db } from '../db/index.js';
import { stickyNotes } from '../db/schema.js';
import { newId, nowIso } from '../lib/util.js';
import { patchOf } from './_shared.js';

const createBody = z.object({
  body: z.string().max(5_000).default(''),
  color: z.enum(STICKY_COLORS).default('yellow'),
});

const updateBody = patchOf(createBody);

/**
 * Sticky notes on the Todo board.
 *
 * A note is created empty and typed into, so `body` defaults to the empty
 * string rather than being required — the "+" button should not open a dialog
 * just to collect a first character.
 */
export async function stickyRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/stickies', async () =>
    db
      .select()
      .from(stickyNotes)
      .orderBy(asc(stickyNotes.sortOrder), asc(stickyNotes.createdAt))
      .all(),
  );

  app.post('/api/stickies', async (req, reply) => {
    const parsed = createBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: z.prettifyError(parsed.error) });

    const last = db.select({ m: max(stickyNotes.sortOrder) }).from(stickyNotes).get();
    const ts = nowIso();
    const row = {
      id: newId(),
      body: parsed.data.body,
      color: parsed.data.color,
      sortOrder: (last?.m ?? -1) + 1,
      createdAt: ts,
      updatedAt: ts,
    };

    db.insert(stickyNotes).values(row).run();
    return reply.code(201).send(row);
  });

  app.patch<{ Params: { id: string } }>('/api/stickies/:id', async (req, reply) => {
    const parsed = updateBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: z.prettifyError(parsed.error) });

    const d = parsed.data;
    db.update(stickyNotes)
      .set({
        ...(d.body !== undefined && { body: d.body }),
        ...(d.color !== undefined && { color: d.color }),
        updatedAt: nowIso(),
      })
      .where(eq(stickyNotes.id, req.params.id))
      .run();

    const row = db.select().from(stickyNotes).where(eq(stickyNotes.id, req.params.id)).get();
    return row ?? reply.code(404).send({ error: 'Note not found' });
  });

  app.delete<{ Params: { id: string } }>('/api/stickies/:id', async (req, reply) => {
    db.delete(stickyNotes).where(eq(stickyNotes.id, req.params.id)).run();
    return reply.code(204).send();
  });

  /** Bulk reorder, sent as an ordered list of ids. */
  app.post('/api/stickies/reorder', async (req, reply) => {
    const parsed = z.object({ ids: z.array(z.string()) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Expected { ids: string[] }' });

    db.transaction((tx) => {
      parsed.data.ids.forEach((id, i) => {
        tx.update(stickyNotes)
          .set({ sortOrder: i, updatedAt: nowIso() })
          .where(eq(stickyNotes.id, id))
          .run();
      });
    });
    return { ok: true };
  });
}
