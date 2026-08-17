import { and, asc, eq, gte, lte } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { encrypt, encryptionAvailable } from '../crypto.js';
import { db } from '../db/index.js';
import { calendarFeeds, events, tasks } from '../db/schema.js';
import { feedEventCount, syncAllFeeds, syncFeed } from '../lib/calendarFeeds.js';
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

  // -------------------------------------------------------------------------
  // Subscribed calendars
  // -------------------------------------------------------------------------

  /**
   * Feed list. The URL is deliberately absent — it is a bearer credential for
   * the whole calendar, and nothing in the UI needs it back once saved.
   */
  app.get('/api/calendar/feeds', async () =>
    db
      .select({
        id: calendarFeeds.id,
        name: calendarFeeds.name,
        color: calendarFeeds.color,
        status: calendarFeeds.status,
        error: calendarFeeds.error,
        lastSyncAt: calendarFeeds.lastSyncAt,
      })
      .from(calendarFeeds)
      .orderBy(asc(calendarFeeds.name))
      .all()
      .map((f) => ({ ...f, eventCount: feedEventCount(f.id) })),
  );

  app.post('/api/calendar/feeds', async (req, reply) => {
    if (!encryptionAvailable()) {
      return reply.code(503).send({
        error:
          'The macOS Keychain is unreachable, so the calendar URL could not be stored ' +
          'encrypted. Adding a feed is blocked rather than saving it in plaintext.',
      });
    }

    const parsed = z
      .object({
        name: z.string().min(1).max(200),
        url: z.string().min(1).max(2000),
        color: z.string().default('blue'),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: z.prettifyError(parsed.error) });

    // Calendar apps hand out webcal:// links, which are just https:// wearing a
    // scheme that tells the OS to open a calendar app. fetch() rejects it.
    const raw = parsed.data.url.trim();
    const url = raw.replace(/^webcal:\/\//i, 'https://');
    if (!/^https?:\/\//i.test(url)) {
      return reply.code(400).send({ error: 'That does not look like a calendar URL' });
    }

    const id = newId();
    db.insert(calendarFeeds)
      .values({
        id,
        name: parsed.data.name,
        urlEnc: encrypt(url),
        color: parsed.data.color,
        status: 'ok',
        error: null,
        lastSyncAt: null,
        createdAt: nowIso(),
      })
      .run();

    // Sync straight away: a feed that shows nothing until 6am tomorrow reads as
    // broken, and a bad URL should be reported while the user is still here.
    const outcome = await syncFeed(id);
    return reply.code(201).send({ feedId: id, sync: outcome });
  });

  /** Manual refresh — same path the nightly job takes. */
  app.post('/api/calendar/feeds/sync', async (req) => {
    const parsed = z.object({ feedId: z.string().optional() }).safeParse(req.body ?? {});
    const feedId = parsed.success ? parsed.data.feedId : undefined;
    return feedId ? [await syncFeed(feedId)] : await syncAllFeeds();
  });

  app.delete<{ Params: { id: string } }>('/api/calendar/feeds/:id', async (req, reply) => {
    const feed = db.select().from(calendarFeeds).where(eq(calendarFeeds.id, req.params.id)).get();
    if (!feed) return reply.code(404).send({ error: 'Feed not found' });

    // Explicit rather than cascading — see the note on events.feedId. Both
    // statements share a transaction so a feed can never outlive its events or
    // vice versa. Hand-made events have a null feedId and are untouched.
    db.transaction((tx) => {
      tx.delete(events).where(eq(events.feedId, req.params.id)).run();
      tx.delete(calendarFeeds).where(eq(calendarFeeds.id, req.params.id)).run();
    });
    return reply.code(204).send();
  });
}
