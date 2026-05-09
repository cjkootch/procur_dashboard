import 'server-only';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  db,
  entityFacts,
  ENTITY_FACT_SOURCES,
  ENTITY_FACT_TYPES,
  type EntityFact,
  type EntityFactSource,
  type EntityFactType,
} from '@procur/db';

/**
 * Entity Facts catalog helpers (Phase 1 of the entity-cleanup
 * architecture). The store is provenance-aware: every label-write
 * is tagged with a source, optional confidence, and evidence.
 * Reads use `getCurrentEntityFacts` which queries the
 * current_entity_facts view (highest authority active fact per
 * (entity, fact_type)).
 *
 * Multi-source coexistence is the whole point — Apollo's
 * `industry='Manufacturing'` and an operator's
 * `industry='Hospitality'` both stay queryable so Phase 2 can
 * surface the conflict in the review queue. Don't supersede
 * blindly; only call recordEntityFact with supersedePrior=true
 * when an authoritative source (operator confirmation) replaces
 * uncertain prior values.
 */

export type { EntityFact, EntityFactSource, EntityFactType };
export { ENTITY_FACT_SOURCES, ENTITY_FACT_TYPES };

export interface RecordFactInput {
  entitySlug: string;
  factType: EntityFactType | (string & {});
  value: string;
  source: EntityFactSource;
  /** 0.0–1.0. Omit for human/operator_edit (implicit confidence 1.0). */
  confidence?: number;
  evidence?: Record<string, unknown>;
  /** User id (when source = human / operator_edit) or system component name. */
  recordedBy?: string;
  /** When true, mark every prior active fact for the same
   *  (entity, fact_type) as superseded by this new row. Use only
   *  for authoritative writes (operator-confirmed, post-review).
   *  Default false — multi-source facts coexist; the view picks
   *  authority for reads. */
  supersedePrior?: boolean;
}

export async function recordEntityFact(
  input: RecordFactInput,
): Promise<EntityFact> {
  const [created] = await db
    .insert(entityFacts)
    .values({
      entitySlug: input.entitySlug,
      factType: input.factType,
      value: input.value,
      source: input.source,
      confidence:
        input.confidence != null ? String(input.confidence) : null,
      evidenceJson: input.evidence ?? {},
      recordedBy: input.recordedBy ?? null,
    })
    // Partial unique on (entity_slug, fact_type, value, source) WHERE
    // superseded_at IS NULL — re-recording an identical active fact
    // is a no-op. Operator clicking accept twice doesn't double-write.
    .onConflictDoNothing()
    .returning();

  if (!created) {
    // The conflict-do-nothing branch hit. Re-fetch the existing row
    // so the caller still gets a consistent return type.
    const [existing] = await db
      .select()
      .from(entityFacts)
      .where(
        and(
          eq(entityFacts.entitySlug, input.entitySlug),
          eq(entityFacts.factType, input.factType),
          eq(entityFacts.value, input.value),
          eq(entityFacts.source, input.source),
          isNull(entityFacts.supersededAt),
        ),
      )
      .limit(1);
    if (!existing) {
      throw new Error('recordEntityFact: insert + refetch both empty');
    }
    return existing;
  }

  if (input.supersedePrior) {
    // neon-http doesn't support transactions; sequential UPDATE is
    // fine because the partial-unique index lets the new row coexist
    // with prior actives until we mark them superseded. The brief
    // window where multiple actives exist is harmless — the view
    // will already prefer the new row by authority + recency.
    await db
      .update(entityFacts)
      .set({ supersededAt: new Date(), supersededBy: created.id })
      .where(
        and(
          eq(entityFacts.entitySlug, input.entitySlug),
          eq(entityFacts.factType, input.factType),
          isNull(entityFacts.supersededAt),
          sql`${entityFacts.id} <> ${created.id}`,
        ),
      );
  }

  return created;
}

/**
 * Read the highest-authority active fact for each fact_type on an
 * entity. Returns a Map<factType, EntityFact> — empty when the
 * entity has no facts recorded yet.
 */
export async function getCurrentEntityFacts(
  entitySlug: string,
): Promise<Map<string, EntityFact>> {
  const result = await db.execute<{
    id: string;
    entity_slug: string;
    fact_type: string;
    value: string;
    source: string;
    confidence: string | null;
    evidence_json: Record<string, unknown>;
    recorded_by: string | null;
    recorded_at: Date;
  }>(sql`
    SELECT id, entity_slug, fact_type, value, source, confidence,
           evidence_json, recorded_by, recorded_at
      FROM current_entity_facts
     WHERE entity_slug = ${entitySlug}
  `);
  const out = new Map<string, EntityFact>();
  for (const r of result.rows) {
    out.set(r.fact_type, {
      id: r.id,
      entitySlug: r.entity_slug,
      factType: r.fact_type,
      value: r.value,
      source: r.source,
      confidence: r.confidence,
      evidenceJson: r.evidence_json,
      recordedBy: r.recorded_by,
      recordedAt: r.recorded_at,
      supersededAt: null,
      supersededBy: null,
    });
  }
  return out;
}

/**
 * List every fact on an entity (active + superseded), most recent
 * first. Powers the entity-profile audit panel and conflict-review
 * surface in Phase 2.
 */
export async function listEntityFactsForEntity(
  entitySlug: string,
): Promise<EntityFact[]> {
  return await db
    .select()
    .from(entityFacts)
    .where(eq(entityFacts.entitySlug, entitySlug))
    .orderBy(desc(entityFacts.recordedAt));
}

export interface EntityFactConflict {
  entitySlug: string;
  factType: string;
  values: string[];
  sources: string[];
}

/**
 * Find entities where multiple active facts of the same type
 * disagree on `value`. Phase 2 will surface these in the
 * feedback-events review queue so the operator can pick the
 * canonical answer (writing a `human`-source fact that supersedes
 * the conflicting ones).
 *
 * Cheap query — group + having; no scan past the partial active
 * index. Safe to call from the dashboard.
 */
export async function listEntityFactConflicts(): Promise<
  EntityFactConflict[]
> {
  const result = await db.execute<{
    entity_slug: string;
    fact_type: string;
    values: string[];
    sources: string[];
  }>(sql`
    SELECT entity_slug,
           fact_type,
           ARRAY_AGG(DISTINCT value) AS values,
           ARRAY_AGG(DISTINCT source) AS sources
      FROM entity_facts
     WHERE superseded_at IS NULL
     GROUP BY entity_slug, fact_type
    HAVING COUNT(DISTINCT value) > 1
     ORDER BY entity_slug, fact_type
  `);
  return result.rows.map((r) => ({
    entitySlug: r.entity_slug,
    factType: r.fact_type,
    values: r.values,
    sources: r.sources,
  }));
}

/** Suppresses unused-import lint when this file is imported for
 *  types only. */
export const __entityFactsHelpersTouch = sql`1`;
