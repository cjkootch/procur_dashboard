import {
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Provenance-aware label store. One row per (entity, fact_type,
 * value, source) — multiple sources can disagree about the same
 * fact, which is the whole point. Read paths go through the
 * `current_entity_facts` view (defined in migration 0113) which
 * picks the highest-authority active fact per (entity, fact_type).
 *
 * Authority order:
 *   human → operator_edit → website_crawl → apollo → ingest → model
 *
 * Soft-delete pattern: setting `superseded_at` retires a fact
 * without losing audit history. Operator-confirmed facts that
 * supersede prior ones leave the prior facts queryable for
 * "what did Apollo say before Cole corrected it?" debugging.
 *
 * The label-types convention is canonical but the column is plain
 * text — extending the vocabulary (e.g. compliance_tag,
 * risk_category) is additive, no migration required.
 */

export const ENTITY_FACT_TYPES = [
  'industry',
  'company_role',
  'market_segment',
  'product_category',
] as const;
export type EntityFactType = (typeof ENTITY_FACT_TYPES)[number];

export const ENTITY_FACT_SOURCES = [
  'human',
  'operator_edit',
  'website_crawl',
  'apollo',
  'ingest',
  'model',
] as const;
export type EntityFactSource = (typeof ENTITY_FACT_SOURCES)[number];

export const entityFacts = pgTable(
  'entity_facts',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** known_entities.slug OR external_suppliers.id — same shape
     *  the rest of the entity-keyed tables (supplier_approvals,
     *  fuel_consumption_signals, entity_contact_enrichments) use. */
    entitySlug: text('entity_slug').notNull(),

    /** Canonical types: industry / company_role / market_segment /
     *  product_category. Free-text so extensions are additive. */
    factType: text('fact_type').notNull(),

    /** The label value. Free-text; the operator's accepted values
     *  for each fact_type act as the de-facto vocabulary. */
    value: text('value').notNull(),

    /** Where this fact came from. Drives authority ordering in
     *  current_entity_facts view. */
    source: text('source').notNull(),

    /** 0.00–1.00. Optional; null means the source didn't report
     *  one (e.g. operator edit — implicit confidence = 1.0). */
    confidence: numeric('confidence', { precision: 3, scale: 2 }),

    /** Evidence supporting this fact — source URLs, snippets,
     *  Apollo person ids, page paths, conversation thread ids,
     *  whatever the recorder thought was relevant. */
    evidenceJson: jsonb('evidence_json')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),

    /** User id when source = human / operator_edit; system
     *  component name otherwise (e.g. 'website_crawler', 'apollo_enrich'). */
    recordedBy: text('recorded_by'),

    recordedAt: timestamp('recorded_at', { withTimezone: true })
      .notNull()
      .defaultNow(),

    /** Set when this fact has been replaced by another. NULL = active.
     *  Soft-delete preserves audit history. */
    supersededAt: timestamp('superseded_at', { withTimezone: true }),

    /** FK to entity_facts.id of the replacement (no DB-level FK
     *  declared since both rows live in this table; loose link). */
    supersededBy: uuid('superseded_by'),
  },
  (table) => ({
    entitySlugIdx: index('entity_facts_entity_slug_idx').on(table.entitySlug),
    typeValueIdx: index('entity_facts_type_value_idx').on(
      table.factType,
      table.value,
    ),
    // Partial unique + active indexes are declared in the migration
    // so drizzle-kit's introspection doesn't fight the WHERE clause.
  }),
);

export type EntityFact = typeof entityFacts.$inferSelect;
export type NewEntityFact = typeof entityFacts.$inferInsert;
