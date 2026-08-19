import { desc, eq, isNull } from 'drizzle-orm';
import { marketDb } from '../../db/market/index.js';
import { documents } from '../../db/market/schema.js';
import { classifyDocument } from '../agents/events.js';

/**
 * Runs agents/events.ts over documents that haven't been classified yet.
 *
 * Deliberately its own step, not inline with ingestion — news.ts and
 * edgar.ts write a document the moment it's captured, and classification is
 * a live LLM call per document with its own cost and failure modes. Coupling
 * the two would mean an LLM outage or rate limit blocks new documents from
 * being ingested at all, which is exactly backwards: the raw document is the
 * thing that cannot be re-fetched later, same reasoning `capture.ts` already
 * applies to option quotes. `eventType` staying null a while longer costs
 * nothing that can't be caught up.
 */

export interface ClassifySummary {
  attempted: number;
  classified: number;
  errors: string[];
}

export async function classifyUnclassifiedDocuments(limit = 50): Promise<ClassifySummary> {
  const pending = marketDb
    .select({
      id: documents.id,
      title: documents.title,
      summary: documents.summary,
      docType: documents.docType,
      edgarItems: documents.edgarItems,
    })
    .from(documents)
    .where(isNull(documents.eventType))
    .orderBy(desc(documents.publishedAt))
    .limit(limit)
    .all();

  const summary: ClassifySummary = { attempted: pending.length, classified: 0, errors: [] };

  for (const doc of pending) {
    try {
      const result = await classifyDocument({
        title: doc.title,
        summary: doc.summary,
        docType: doc.docType,
        items: doc.edgarItems,
      });
      marketDb
        .update(documents)
        .set({ eventType: result.eventType, eventConfidence: result.confidence })
        .where(eq(documents.id, doc.id))
        .run();
      summary.classified += 1;
    } catch (err) {
      summary.errors.push(`${doc.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return summary;
}
