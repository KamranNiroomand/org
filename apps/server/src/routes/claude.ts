import Anthropic from '@anthropic-ai/sdk';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { ideaLinks, ideas, projects, tasks } from '../db/schema.js';
import { newId, nowIso } from '../lib/util.js';

/**
 * Claude assistance for the Ideas tab.
 *
 * The API key stays server-side — the browser talks to these routes, never to
 * Anthropic. That's not just tidiness: a key shipped to the browser is a key
 * published to anyone who opens devtools.
 */

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!config.anthropic.apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set');
  }
  client ??= new Anthropic({ apiKey: config.anthropic.apiKey });
  return client;
}

const SYSTEM = `You are a thinking partner inside Kamran's personal operating
system — the app he runs his life out of. He drafts ideas here: projects,
businesses, software, plans, things he's turning over.

Be concrete and direct. Engage with the actual substance of what he wrote
rather than restating it back to him. Where an idea is underspecified, say what
specifically is missing rather than asking him to "consider the details".
Prefer a strong recommendation over an exhaustive survey of options.

Keep responses focused and brief — this renders in a side panel, not a
document. Skip preamble; lead with the substance.`;

const PROMPTS = {
  expand: `Develop this idea further. What does it look like fully realised?
Push on the parts that are only sketched, and add the dimensions the author
hasn't reached yet. Be specific enough to be useful.`,

  critique: `Find the holes in this idea. What are the strongest objections?
What would have to be true for it to work, and how likely is each? Where is the
author being optimistic? Say plainly if the core is sound and the problems are
fixable — a critique that manufactures doubt is as useless as one that
flatters.`,

  relate: `What does this connect to? Adjacent ideas worth exploring, prior art
worth knowing about, and analogous problems from other domains that suggest an
approach.`,
} as const;

const BREAKDOWN_SCHEMA = {
  type: 'object' as const,
  properties: {
    projectName: {
      type: 'string' as const,
      description: 'A short, concrete name for the project. Not a restatement of the idea title.',
    },
    summary: {
      type: 'string' as const,
      description: 'One or two sentences on what doing this actually involves.',
    },
    tasks: {
      type: 'array' as const,
      description: 'Ordered first steps. Each one a concrete action, not a theme.',
      items: {
        type: 'object' as const,
        properties: {
          title: {
            type: 'string' as const,
            description: 'An action starting with a verb, e.g. "Draft the schema for X".',
          },
          priority: {
            type: 'string' as const,
            enum: ['low', 'medium', 'high', 'urgent'],
          },
          notes: { type: 'string' as const },
        },
        required: ['title', 'priority', 'notes'],
        additionalProperties: false,
      },
    },
  },
  required: ['projectName', 'summary', 'tasks'],
  additionalProperties: false,
};

export async function claudeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/claude/status', async () => ({
    configured: config.anthropic.configured,
    model: config.anthropic.model,
  }));

  /**
   * Expand / critique / relate — streamed to the browser as plain text so the
   * panel fills in progressively rather than sitting blank for ten seconds.
   */
  app.post<{ Params: { id: string } }>('/api/ideas/:id/assist', async (req, reply) => {
    const parsed = z
      .object({ action: z.enum(['expand', 'critique', 'relate']) })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Unknown action' });

    if (!config.anthropic.configured) {
      return reply.code(503).send({ error: 'ANTHROPIC_API_KEY is not set in .env' });
    }

    const idea = db.select().from(ideas).where(eq(ideas.id, req.params.id)).get();
    if (!idea) return reply.code(404).send({ error: 'Idea not found' });

    const others = db
      .select({ title: ideas.title })
      .from(ideas)
      .limit(40)
      .all()
      .map((i) => i.title)
      .filter((t) => t !== idea.title);

    const context =
      parsed.data.action === 'relate' && others.length > 0
        ? `\n\nOther ideas in his notes, for cross-referencing:\n${others.map((t) => `- ${t}`).join('\n')}`
        : '';

    reply.raw.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-cache',
      'x-accel-buffering': 'no',
    });

    try {
      const stream = getClient().messages.stream({
        model: config.anthropic.model,
        max_tokens: 16_000,
        system: SYSTEM,
        thinking: { type: 'adaptive' },
        messages: [
          {
            role: 'user',
            content: `${PROMPTS[parsed.data.action]}${context}\n\n---\n\n# ${idea.title}\n\n${idea.body}`,
          },
        ],
      });

      stream.on('text', (delta) => reply.raw.write(delta));
      await stream.finalMessage();
      reply.raw.end();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      app.log.error({ err }, 'Claude assist failed');
      // Headers are already sent, so the error has to ride the body.
      reply.raw.write(`\n\n[Error: ${message}]`);
      reply.raw.end();
    }
  });

  /**
   * Breakdown — turns an idea into a real project with real tasks.
   *
   * Uses structured outputs rather than asking for JSON in the prompt and
   * hoping: the schema is enforced by the API, so there's no parse step that
   * can fail on a stray backtick.
   */
  app.post<{ Params: { id: string } }>('/api/ideas/:id/breakdown', async (req, reply) => {
    if (!config.anthropic.configured) {
      return reply.code(503).send({ error: 'ANTHROPIC_API_KEY is not set in .env' });
    }

    const idea = db.select().from(ideas).where(eq(ideas.id, req.params.id)).get();
    if (!idea) return reply.code(404).send({ error: 'Idea not found' });

    let plan: {
      projectName: string;
      summary: string;
      tasks: Array<{ title: string; priority: 'low' | 'medium' | 'high' | 'urgent'; notes: string }>;
    };

    try {
      const response = await getClient().messages.create({
        model: config.anthropic.model,
        max_tokens: 16_000,
        system: SYSTEM,
        output_config: { format: { type: 'json_schema', schema: BREAKDOWN_SCHEMA } },
        messages: [
          {
            role: 'user',
            content:
              `Turn this idea into a project with a handful of concrete first ` +
              `tasks. Aim for the five to eight steps that actually unblock ` +
              `progress — not an exhaustive plan, and not vague headings like ` +
              `"research options".\n\n---\n\n# ${idea.title}\n\n${idea.body}`,
          },
        ],
      });

      const block = response.content.find((b) => b.type === 'text');
      if (!block || block.type !== 'text') {
        return reply.code(502).send({ error: 'Claude returned no content' });
      }
      plan = JSON.parse(block.text);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      app.log.error({ err }, 'Claude breakdown failed');
      return reply.code(502).send({ error: message });
    }

    // Write the project and its tasks in one transaction — a half-created
    // project with no tasks is worse than a clean failure.
    const ts = nowIso();
    const projectId = newId();

    db.transaction((tx) => {
      tx.insert(projects)
        .values({
          id: projectId,
          name: plan.projectName,
          description: plan.summary,
          status: 'active',
          color: 'violet',
          targetOn: null,
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      plan.tasks.forEach((t, i) => {
        tx.insert(tasks)
          .values({
            id: newId(),
            title: t.title,
            notes: t.notes || null,
            status: 'open',
            priority: t.priority,
            dueOn: null,
            completedAt: null,
            projectId,
            tags: ['from-idea'],
            sortOrder: i,
            createdAt: ts,
            updatedAt: ts,
          })
          .run();
      });

      tx.insert(ideaLinks)
        .values({
          id: newId(),
          ideaId: idea.id,
          targetType: 'project',
          targetId: projectId,
        })
        .onConflictDoNothing()
        .run();

      // An idea that produced a project is no longer just a seed.
      tx.update(ideas)
        .set({ status: idea.status === 'seed' ? 'growing' : idea.status, updatedAt: ts })
        .where(eq(ideas.id, idea.id))
        .run();
    });

    return reply.code(201).send({
      projectId,
      projectName: plan.projectName,
      summary: plan.summary,
      taskCount: plan.tasks.length,
    });
  });
}
