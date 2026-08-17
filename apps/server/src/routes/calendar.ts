import { and, asc, eq, gte, lte } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/index.js';
import { events, tasks } from '../db/schema.js';
import { newId, nowIso } from '../lib/util.js';

const civilKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const body = z.object({
  title: z.string().min(1).max(500),
  notes: z.string().max(20_000).nullish(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  allDay: z.boolean().default(false),
  location: z.string().max(500).nullish(),
  color: z.string().default('blue'),
});

export async function calendarRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Events overlapping a window. The window is passed as civil days and
   * widened by a day on each side before comparing against stored instants,
   * which avoids dropping an event that starts at 23:00 local on the boundary.
   */
  app.get<{ Querystring: { from?: string; to?: string } }>('/api/events', async (req) => {
    const { from, to } = req.query;
    const filters = [];
    if (from) filters.push(gte(events.endsAt, `${from}T00:00:00.000Z`));
    if (to) filters.push(lte(events.startsAt, `${to}T23:59:59.999Z`));

    return db
      .select()
      .from(events)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(asc(events.startsAt))
      .all();
  });

  app.post('/api/events', async (req, reply) => {
    const parsed = body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: z.prettifyError(parsed.error) });
    if (parsed.data.endsAt < parsed.data.startsAt) {
      return reply.code(400).send({ error: 'Event ends before it starts' });
    }

    const ts = nowIso();
    const row = {
      id: newId(),
      title: parsed.data.title,
      notes: parsed.data.notes ?? null,
      startsAt: parsed.data.startsAt,
      endsAt: parsed.data.endsAt,
      allDay: parsed.data.allDay,
      location: parsed.data.location ?? null,
      color: parsed.data.color,
      createdAt: ts,
      updatedAt: ts,
    };
    db.insert(events).values(row).run();
    return reply.code(201).send(row);
  });

  app.patch<{ Params: { id: string } }>('/api/events/:id', async (req, reply) => {
    const parsed = body.partial().safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: z.prettifyError(parsed.error) });

    const d = parsed.data;
    db.update(events)
      .set({
        ...(d.title !== undefined && { title: d.title }),
        ...(d.notes !== undefined && { notes: d.notes ?? null }),
        ...(d.startsAt !== undefined && { startsAt: d.startsAt }),
        ...(d.endsAt !== undefined && { endsAt: d.endsAt }),
        ...(d.allDay !== undefined && { allDay: d.allDay }),
        ...(d.location !== undefined && { location: d.location ?? null }),
        ...(d.color !== undefined && { color: d.color }),
        updatedAt: nowIso(),
      })
      .where(eq(events.id, req.params.id))
      .run();

    const row = db.select().from(events).where(eq(events.id, req.params.id)).get();
    return row ?? reply.code(404).send({ error: 'Event not found' });
  });

  app.delete<{ Params: { id: string } }>('/api/events/:id', async (req, reply) => {
    db.delete(events).where(eq(events.id, req.params.id)).run();
    return reply.code(204).send();
  });

  /**
   * Everything that belongs on a calendar between two days: events plus tasks
   * carrying a due date. The calendar shouldn't have to know these live in
   * different tables, so they're merged into one shape here.
   */
  app.get<{ Querystring: { from: string; to: string } }>('/api/calendar', async (req, reply) => {
    const parsed = z.object({ from: civilKey, to: civilKey }).safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'from and to must be YYYY-MM-DD' });
    }
    const { from, to } = parsed.data;

    const eventRows = db
      .select()
      .from(events)
      .where(and(gte(events.endsAt, `${from}T00:00:00.000Z`), lte(events.startsAt, `${to}T23:59:59.999Z`)))
      .all();

    const taskRows = db
      .select()
      .from(tasks)
      .where(and(gte(tasks.dueOn, from), lte(tasks.dueOn, to)))
      .all();

    return {
      events: eventRows,
      tasks: taskRows.map((t) => ({
        id: t.id,
        title: t.title,
        dueOn: t.dueOn,
        status: t.status,
        priority: t.priority,
        projectId: t.projectId,
      })),
    };
  });
}
