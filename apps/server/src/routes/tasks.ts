import { and, asc, desc, eq, inArray, isNotNull, lte } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/index.js';
import { projects, tasks } from '../db/schema.js';
import { newId, nowIso, todayKey } from '../lib/util.js';

const priority = z.enum(['none', 'low', 'medium', 'high', 'urgent']);
const status = z.enum(['open', 'done', 'dropped']);
const civilKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

const createBody = z.object({
  title: z.string().min(1).max(500),
  notes: z.string().max(20_000).nullish(),
  priority: priority.default('none'),
  dueOn: civilKey.nullish(),
  projectId: z.string().nullish(),
  tags: z.array(z.string()).default([]),
});

const updateBody = createBody.partial().extend({ status: status.optional() });

export async function taskRoutes(app: FastifyInstance): Promise<void> {
  app.get<{
    Querystring: { status?: string; projectId?: string; tag?: string; due?: string };
  }>('/api/tasks', async (req) => {
    const q = req.query;
    const filters = [];

    if (q.status && q.status !== 'all') {
      filters.push(eq(tasks.status, q.status as 'open' | 'done' | 'dropped'));
    }
    if (q.projectId) filters.push(eq(tasks.projectId, q.projectId));
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

    const row = {
      id: newId(),
      title: body.title,
      notes: body.notes ?? null,
      status: 'open' as const,
      priority: body.priority,
      dueOn: body.dueOn ?? null,
      completedAt: null,
      projectId: body.projectId ?? null,
      tags: body.tags,
      sortOrder: 0,
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
    // can never disagree about whether a task is finished.
    const completedAt =
      body.status === undefined || body.status === existing.status
        ? existing.completedAt
        : body.status === 'done'
          ? nowIso()
          : null;

    const patch = {
      ...(body.title !== undefined && { title: body.title }),
      ...(body.notes !== undefined && { notes: body.notes ?? null }),
      ...(body.priority !== undefined && { priority: body.priority }),
      ...(body.dueOn !== undefined && { dueOn: body.dueOn ?? null }),
      ...(body.projectId !== undefined && { projectId: body.projectId ?? null }),
      ...(body.tags !== undefined && { tags: body.tags }),
      ...(body.status !== undefined && { status: body.status }),
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

  /** Bulk reorder, sent as an ordered list of ids. */
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

  /** Everything open and due on or before today — the Today tab's task list. */
  app.get('/api/tasks/agenda/today', async () => {
    const today = todayKey();
    const rows = db
      .select()
      .from(tasks)
      .where(and(eq(tasks.status, 'open'), isNotNull(tasks.dueOn), lte(tasks.dueOn, today)))
      .orderBy(asc(tasks.dueOn))
      .all();

    return {
      overdue: rows.filter((r) => r.dueOn! < today),
      today: rows.filter((r) => r.dueOn === today),
    };
  });
}

export async function projectRoutes(app: FastifyInstance): Promise<void> {
  const body = z.object({
    name: z.string().min(1).max(200),
    description: z.string().max(20_000).nullish(),
    status: z.enum(['active', 'paused', 'done', 'archived']).default('active'),
    color: z.string().default('violet'),
    targetOn: civilKey.nullish(),
  });

  app.get('/api/projects', async () => {
    const rows = db.select().from(projects).orderBy(asc(projects.name)).all();
    if (rows.length === 0) return [];

    const ids = rows.map((r) => r.id);
    const related = db
      .select({
        projectId: tasks.projectId,
        status: tasks.status,
        dueOn: tasks.dueOn,
      })
      .from(tasks)
      .where(inArray(tasks.projectId, ids))
      .all();

    const today = todayKey();
    return rows.map((p) => {
      const mine = related.filter((t) => t.projectId === p.id);
      return {
        ...p,
        taskCount: mine.length,
        doneCount: mine.filter((t) => t.status === 'done').length,
        overdueCount: mine.filter(
          (t) => t.status === 'open' && t.dueOn !== null && t.dueOn < today,
        ).length,
      };
    });
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
    const row = db.select().from(projects).where(eq(projects.id, req.params.id)).get();
    if (!row) return reply.code(404).send({ error: 'Project not found' });

    return {
      ...row,
      tasks: db
        .select()
        .from(tasks)
        .where(eq(tasks.projectId, row.id))
        .orderBy(asc(tasks.sortOrder), asc(tasks.dueOn))
        .all(),
    };
  });

  app.post('/api/projects', async (req, reply) => {
    const parsed = body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: z.prettifyError(parsed.error) });

    const ts = nowIso();
    const row = {
      id: newId(),
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      status: parsed.data.status,
      color: parsed.data.color,
      targetOn: parsed.data.targetOn ?? null,
      createdAt: ts,
      updatedAt: ts,
    };
    db.insert(projects).values(row).run();
    return reply.code(201).send(row);
  });

  app.patch<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
    const parsed = body.partial().safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: z.prettifyError(parsed.error) });

    const d = parsed.data;
    db.update(projects)
      .set({
        ...(d.name !== undefined && { name: d.name }),
        ...(d.description !== undefined && { description: d.description ?? null }),
        ...(d.status !== undefined && { status: d.status }),
        ...(d.color !== undefined && { color: d.color }),
        ...(d.targetOn !== undefined && { targetOn: d.targetOn ?? null }),
        updatedAt: nowIso(),
      })
      .where(eq(projects.id, req.params.id))
      .run();

    const row = db.select().from(projects).where(eq(projects.id, req.params.id)).get();
    return row ?? reply.code(404).send({ error: 'Project not found' });
  });

  app.delete<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
    // Tasks survive their project — the schema nulls the reference rather than
    // cascading, because deleting a project should not silently destroy work.
    db.delete(projects).where(eq(projects.id, req.params.id)).run();
    return reply.code(204).send();
  });
}
