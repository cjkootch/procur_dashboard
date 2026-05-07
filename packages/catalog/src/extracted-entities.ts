import 'server-only';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  db,
  extractedEntities,
  type ExtractedEntity,
  type ExtractedEntitySourceType,
  type GlinerLabel,
  type NewExtractedEntity,
} from '@procur/db';

/**
 * Helpers for the GLiNER NER layer (migration 0088). Producers run
 * GLiNER offline (Python module in services/ml-training) and feed
 * results back through `upsertExtractedEntities`. Consumers query
 * by source or by label to surface structured spans during chat /
 * approval previews.
 *
 * Discipline (per Cole's brief):
 *   - GLiNER extracts; an LLM is only invoked for ambiguous synthesis
 *     downstream. The catalog layer doesn't decide which to run —
 *     callers do.
 *   - `resolved_entity_slug` stays null on insert. A separate
 *     resolver pass (future) maps surface forms to known_entities.
 */

export interface ExtractedSpanInput {
  sourceType: ExtractedEntitySourceType | string;
  sourceId: string;
  label: GlinerLabel | string;
  value: string;
  startOffset?: number | null;
  endOffset?: number | null;
  confidence?: number | null;
  modelVersion?: string;
}

/**
 * Idempotent batch insert. The unique partial index in the migration
 * collapses re-extractions on the same `(source, label, value,
 * start_offset, model_version)` so re-running is safe. Failures are
 * caught and logged — a NER write must NEVER block the upstream
 * task that produced the text.
 */
export async function upsertExtractedEntities(
  spans: ExtractedSpanInput[],
): Promise<{ inserted: number }> {
  if (spans.length === 0) return { inserted: 0 };
  const rows: NewExtractedEntity[] = spans.map((s) => ({
    sourceType: s.sourceType,
    sourceId: s.sourceId,
    label: s.label,
    value: s.value,
    startOffset: s.startOffset ?? null,
    endOffset: s.endOffset ?? null,
    confidence:
      typeof s.confidence === 'number' ? String(s.confidence) : null,
    modelVersion: s.modelVersion ?? 'gliner-multitask-v1',
  }));
  try {
    const result = await db
      .insert(extractedEntities)
      .values(rows)
      .onConflictDoNothing();
    return { inserted: (result as { rowCount?: number }).rowCount ?? rows.length };
  } catch (err) {
    console.error('[gliner] insert failed', err, {
      count: rows.length,
      sourceType: rows[0]?.sourceType,
    });
    return { inserted: 0 };
  }
}

/** All spans for a given source (e.g. all NER spans on one inbound email). */
export async function listExtractedEntitiesForSource(input: {
  sourceType: ExtractedEntitySourceType | string;
  sourceId: string;
  modelVersion?: string;
}): Promise<ExtractedEntity[]> {
  const filters = [
    eq(extractedEntities.sourceType, input.sourceType),
    eq(extractedEntities.sourceId, input.sourceId),
    input.modelVersion
      ? eq(extractedEntities.modelVersion, input.modelVersion)
      : null,
  ].filter(Boolean);
  return db
    .select()
    .from(extractedEntities)
    .where(and(...(filters as never[])))
    .orderBy(desc(extractedEntities.confidence), extractedEntities.startOffset);
}

/**
 * All spans of a given label, across all sources. Useful for
 * "give me every port mentioned anywhere this week" queries.
 */
export async function listExtractedEntitiesByLabel(input: {
  label: GlinerLabel | string;
  limit?: number;
}): Promise<ExtractedEntity[]> {
  return db
    .select()
    .from(extractedEntities)
    .where(eq(extractedEntities.label, input.label))
    .orderBy(desc(extractedEntities.createdAt))
    .limit(input.limit ?? 100);
}

/**
 * Aggregate counts per label for one source — handy for "this email
 * mentioned 3 ports + 2 vessels + 1 incoterm" summaries.
 */
export async function summarizeExtractedEntities(input: {
  sourceType: ExtractedEntitySourceType | string;
  sourceId: string;
}): Promise<Array<{ label: string; count: number }>> {
  const rows = await db
    .select({
      label: extractedEntities.label,
      count: sql<number>`count(*)::int`,
    })
    .from(extractedEntities)
    .where(
      and(
        eq(extractedEntities.sourceType, input.sourceType),
        eq(extractedEntities.sourceId, input.sourceId),
      ),
    )
    .groupBy(extractedEntities.label)
    .orderBy(desc(sql`count(*)`));
  return rows.map((r) => ({ label: r.label, count: Number(r.count ?? 0) }));
}
