import { and, asc, desc, eq, isNotNull, isNull, lte, max } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/index.js';
import { projects, tasks } from '../db/schema.js';
import { newId, nowIso, todayKey } from '../lib/util.js';
import { civilKey, patchOf } from './_shared.js';

const priority = z.enum(['none', 'low', 'medium', 'high', 'urgent']);
const status = z.enum(['open', 'done', 'dropped']);

/** A month of minutes. Past this, someone typed a phone number into the box. */
const estimateMinutes = z.number().int().min(0).max(43_200);

const createBody = z.object({
  title: z.string().min(1).max(500),
  notes: z.string().max(20_000).nullish(),
  priority: priority.default('none'),
  dueOn: civilKey.nullish(),
  projectId: z.string().nullish(),
  tags: z.array(z.string()).default([]),
  estimateMinutes: estimateMinutes.nullish(),
});

const updateBody = patchOf(createBody).extend({
  status: status.optional(),
  // Editable so time logged away from the keyboard can be corrected by hand.
  // `timerStartedAt` deliberately is not — see the PATCH handler.
  trackedSeconds: z.number().int().min(0).max(31_536_000).optional(),
});

/** Seconds banked by an interval that started at `startedAt` and ends now. */
function intervalSeconds(startedAt: string, now: number): number {
  const started = Date.parse(startedAt);
  if (Number.isNaN(started)) return 0;
  return Math.max(0, Math.floor((now - started) / 1000));
}

export async function taskRoutes(app: FastifyInstance): Promise<void> {
  app.get<{
    Querystring: { status?: string; projectId?: string; tag?: string; due?: string };
  }>('/api/tasks', async (req) => {
    const q = req.query;
    const filters = [];

    if (q.status && q.status !== 'all') {
      filters.push(eq(tasks.status, q.status as 'open' | 'done' | 'dropped'));
    }

    // Tri-state, because "tasks that belong to no project" is a real query and
    // an absent parameter must keep meaning "everything". A collection endpoint
    // that silently returns a subset is a trap for the next caller, so the
    // Todo/project split is a filter the Todo page asks for, not a default.
    if (q.projectId === 'none') filters.push(isNull(tasks.projectId));
    else if (q.projectId === 'any') filters.push(isNotNull(tasks.projectId));
    else if (q.projectId) filters.push(eq(tasks.projectId, q.projectId));

    // "due" means everything on or before that day that is still open — an
    // overdue task is more urgent than a task due today, not less relevant.
    if (q.due) {
      filters.push(and(isNotNull(tasks.dueOn), lte(tasks.dueOn, q.due))!);
    }

    const rows = db
      .select()
      .from(tasks)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(asc(tasks.dueOn), asc(tasks.sortOrder), desc(tasks.createdAt))
      .all();

    return q.tag ? rows.filter((r) => r.tags.includes(q.tag!)) : rows;
  });

  app.get<{ Params: { id: string } }>('/api/tasks/:id', async (req, reply) => {
    const row = db.select().from(tasks).where(eq(tasks.id, req.params.id)).get();
    return row ?? reply.code(404).send({ error: 'Task not found' });
  });

  app.post('/api/tasks', async (req, reply) => {
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: z.prettifyError(parsed.error) });
    }
    const body = parsed.data;
    const ts = nowIso();
    const projectId = body.projectId ?? null;

    // New tasks land at the end of their own list rather than all sharing slot
    // 0, which would make a manual order meaningless the moment you add to it.
    const scope = projectId === null ? isNull(tasks.projectId) : eq(tasks.projectId, projectId);
    const last = db.select({ m: max(tasks.sortOrder) }).from(tasks).where(scope).get();

    const row = {
      id: newId(),
      title: body.title,
      notes: body.notes ?? null,
      status: 'open' as const,
      priority: body.priority,
      dueOn: body.dueOn ?? null,
      completedAt: null,
      projectId,
      tags: body.tags,
      sortOrder: (last?.m ?? -1) + 1,
      estimateMinutes: body.estimateMinutes ?? null,
      trackedSeconds: 0,
      timerStartedAt: null,
      createdAt: ts,
      updatedAt: ts,
    };

    db.insert(tasks).values(row).run();
    return reply.code(201).send(row);
  });

  app.patch<{ Params: { id: string } }>('/api/tasks/:id', async (req, reply) => {
    const parsed = updateBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: z.prettifyError(parsed.error) });
    }
    const body = parsed.data;

    const existing = db.select().from(tasks).where(eq(tasks.id, req.params.id)).get();
    if (!existing) return reply.code(404).send({ error: 'Task not found' });

    // completedAt tracks status rather than being set by the caller, so the two
    // can never disagree about whether a task is finished. timerStartedAt is
    // held back for the same reason: it is derived state, and a client that
    // could write it could also lose an hour of tracked time.
    const finishing = body.status === 'done' && existing.status !== 'done';
    const completedAt =
      body.status === undefined || body.status === existing.status
        ? existing.completedAt
        : body.status === 'done'
          ? nowIso()
          : null;

    // Finishing a task stops its clock — otherwise a timer left running on a
    // completed task quietly accumulates overnight.
    const folding = finishing && existing.timerStartedAt !== null;
    const banked = body.trackedSeconds ?? existing.trackedSeconds;

    const patch = {
      ...(body.title !== undefined && { title: body.title }),
      ...(body.notes !== undefined && { notes: body.notes ?? null }),
      ...(body.priority !== undefined && { priority: body.priority }),
      ...(body.dueOn !== undefined && { dueOn: body.dueOn ?? null }),
      ...(body.projectId !== undefined && { projectId: body.projectId ?? null }),
      ...(body.tags !== undefined && { tags: body.tags }),
      ...(body.status !== undefined && { status: body.status }),
      ...(body.estimateMinutes !== undefined && {
        estimateMinutes: body.estimateMinutes ?? null,
      }),
      ...(body.trackedSeconds !== undefined && { trackedSeconds: banked }),
      ...(folding && {
        trackedSeconds: banked + intervalSeconds(existing.timerStartedAt!, Date.now()),
        timerStartedAt: null,
      }),
      completedAt,
      updatedAt: nowIso(),
    };

    db.update(tasks).set(patch).where(eq(tasks.id, req.params.id)).run();
    return db.select().from(tasks).where(eq(tasks.id, req.params.id)).get();
  });

  app.delete<{ Params: { id: string } }>('/api/tasks/:id', async (req, reply) => {
    db.delete(tasks).where(eq(tasks.id, req.params.id)).run();
    return reply.code(204).send();
  });

  /**
   * Bulk reorder, sent as an ordered list of ids.
   *
   * sortOrder is a plain global integer, but every list that reads it is scoped
   * by a WHERE first (one project, or the projectless inbox), so two scopes
   * sharing a number never collide on screen.
   */
  app.post('/api/tasks/reorder', async (req, reply) => {
    const parsed = z.object({ ids: z.array(z.string()) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Expected { ids: string[] }' });

    db.transaction((tx) => {
      parsed.data.ids.forEach((id, i) => {
        tx.update(tasks).set({ sortOrder: i, updatedAt: nowIso() }).where(eq(tasks.id, id)).run();
      });
    });
    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // Timer
  //
  // One timer runs at a time, enforced here rather than in the browser. Elapsed
  // is never counted client-side: the row stores banked seconds plus the instant
  // the open interval began, so a reload, a closed laptop, or a server restart
  // all recover the same number. Clock skew between the two is ignored — on a
  // single-user local app they are the same machine.
  // -------------------------------------------------------------------------

  /** The running task, if any. Cheap enough to poll. */
  app.get('/api/tasks/timer/active', async () => {
    const row = db.select().from(tasks).where(isNotNull(tasks.timerStartedAt)).get();
    return { task: row ?? null };
  });

  app.post<{ Params: { id: string } }>('/api/tasks/:id/timer/start', async (req, reply) => {
    const existing = db.select().from(tasks).where(eq(tasks.id, req.params.id)).get();
    if (!existing) return reply.code(404).send({ error: 'Task not found' });

    // Already running: leave the start instant alone. Restarting it would
    // silently discard however long it had been going.
    if (existing.timerStartedAt !== null) return { task: existing, stopped: [] };

    const now = Date.now();
    const ts = nowIso();

    const stopped = db.transaction((tx) => {
      const running = tx.select().from(tasks).where(isNotNull(tasks.timerStartedAt)).all();
      for (const t of running) {
        tx.update(tasks)
          .set({
            trackedSeconds: t.trackedSeconds + intervalSeconds(t.timerStartedAt!, now),
            timerStartedAt: null,
            updatedAt: ts,
          })
          .where(eq(tasks.id, t.id))
          .run();
      }

      tx.update(tasks)
        .set({ timerStartedAt: ts, updatedAt: ts })
        .where(eq(tasks.id, req.params.id))
        .run();

      // Re-read so the caller sees the folded totals, not the pre-stop rows.
      return running.map((t) => tx.select().from(tasks).where(eq(tasks.id, t.id)).get()!);
    });

    return { task: db.select().from(tasks).where(eq(tasks.id, req.params.id)).get(), stopped };
  });

  app.post<{ Params: { id: string } }>('/api/tasks/:id/timer/stop', async (req, reply) => {
    const existing = db.select().from(tasks).where(eq(tasks.id, req.params.id)).get();
    if (!existing) return reply.code(404).send({ error: 'Task not found' });

    // Stopping a stopped timer is not an error, it is a no-op.
    if (existing.timerStartedAt === null) return existing;

    db.update(tasks)
      .set({
        trackedSeconds:
          existing.trackedSeconds + intervalSeconds(existing.timerStartedAt, Date.now()),
        timerStartedAt: null,
        updatedAt: nowIso(),
      })
      .where(eq(tasks.id, req.params.id))
      .run();

    return db.select().from(tasks).where(eq(tasks.id, req.params.id)).get();
  });

  /**
   * Everything open and due on or before today — the Today tab's task list.
   *
   * Project tasks belong here. Today is a dashboard of what is due, not a mirror
   * of the Todo tab, and hiding project work from it would be misleading. Each
   * row carries its project name so "why is this here" is answerable at a glance.
   */
  app.get('/api/tasks/agenda/today', async () => {
    const today = todayKey();
    const rows = db
      .select({ task: tasks, projectName: projects.name })
      .from(tasks)
      .leftJoin(projects, eq(tasks.projectId, projects.id))
      .where(and(eq(tasks.status, 'open'), isNotNull(tasks.dueOn), lte(tasks.dueOn, today)))
      .orderBy(asc(tasks.dueOn))
      .all()
      .map((r) => ({ ...r.task, projectName: r.projectName }));

    return {
      overdue: rows.filter((r) => r.dueOn! < today),
      today: rows.filter((r) => r.dueOn === today),
    };
  });
}
