import {
  pgTable,
  uuid,
  text,
  integer,
  numeric,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';

/**
 * GLiNER-extracted NER spans from emails / docs / web pages / web
 * summaries / LOIs / ICPOs / assays / deal notes. See migration
 * 0088 for the rationale (separate from entity_web_facts).
 *
 * Polymorphic source via (source_type, source_id) — text producers
 * pick the namespace.
 *
 * Discipline: GLiNER extracts; an LLM is only invoked when the
 * structured pass leaves ambiguity that needs synthesis. The
 * `resolved_entity_slug` column stays null until a separate
 * resolution pass maps the surface form to a known_entities row —
 * keeps detection and resolution as independent stages.
 */
export const extractedEntities = pgTable(
  'extracted_entities',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    sourceType: text('source_type').notNull(),
    sourceId: text('source_id').notNull(),

    label: text('label').notNull(),

    value: text('value').notNull(),

    startOffset: integer('start_offset'),
    endOffset: integer('end_offset'),

    confidence: numeric('confidence', { precision: 3, scale: 2 }),

    /** Optional resolved entity slug — written when a downstream
     *  resolver maps `value` to a known_entities row. */
    resolvedEntitySlug: text('resolved_entity_slug'),

    modelVersion: text('model_version').notNull().default('gliner-multitask-v1'),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    sourceIdx: index('extracted_entities_source_idx').on(
      table.sourceType,
      table.sourceId,
    ),
    labelIdx: index('extracted_entities_label_idx').on(table.label),
    resolvedIdx: index('extracted_entities_resolved_idx').on(
      table.resolvedEntitySlug,
    ),
  }),
);

export type ExtractedEntity = typeof extractedEntities.$inferSelect;
export type NewExtractedEntity = typeof extractedEntities.$inferInsert;

/** GLiNER labels used by procur's v1 extraction pass. Free text in
 *  the column; this constant is the inventory documented per Cole's
 *  brief. New labels slot in additively. */
export const GLINER_LABELS = [
  'company',
  'person',
  'title',
  'product',
  'fuel_grade',
  'crude_grade',
  'port',
  'terminal',
  'vessel',
  'bank',
  'payment_instrument',
  'incoterm',
  'country',
  'document_type',
] as const;
export type GlinerLabel = (typeof GLINER_LABELS)[number];

/** Source-type discriminator. Free text in the column; this constant
 *  is the inventory of values producers/consumers know about. */
export const EXTRACTED_ENTITY_SOURCE_TYPES = [
  'message',
  'document',
  'web_page',
  'web_summary',
  'inbound_email',
  'deal_note',
  'loi',
  'icpo',
  'assay',
] as const;
export type ExtractedEntitySourceType = (typeof EXTRACTED_ENTITY_SOURCE_TYPES)[number];
