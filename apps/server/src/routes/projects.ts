import { asc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/index.js';
import { projects, tasks } from '../db/schema.js';
import { newId, nowIso, todayKey } from '../lib/util.js';
import { civilKey, patchOf } from './_shared.js';

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
        estimateMinutes: tasks.estimateMinutes,
        trackedSeconds: tasks.trackedSeconds,
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
        // A card is a summary, not a stopwatch: a timer that is running right
        // now contributes nothing until it stops and banks its interval.
        estimateMinutes: mine.reduce((sum, t) => sum + (t.estimateMinutes ?? 0), 0),
        trackedSeconds: mine.reduce((sum, t) => sum + t.trackedSeconds, 0),
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
    const parsed = patchOf(body).safeParse(req.body);
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
