import {
  pgTable,
  uuid,
  text,
  timestamp,
  numeric,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Per-contact enrichment suggestions sourced from external
 * integrations (vex's ContactEnrichmentAgent today; provider-agnostic
 * via the `source` column). See migration 0052 for the rationale +
 * idempotency notes.
 *
 * Suggestion-not-overwrite: these are sidecar attributions, never
 * overwriting procur's primary contact-of-record (when one exists).
 * An operator can promote a vex suggestion to primary later via UI.
 */
export const entityContactEnrichments = pgTable(
  'entity_contact_enrichments',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** known_entities.slug OR external_suppliers.id (same shape that
        getEntityProfile accepts as canonicalKey). */
    entitySlug: text('entity_slug').notNull(),

    /** Verbatim name string the source sent. */
    contactName: text('contact_name').notNull(),
    /** Lowercased / punctuation-stripped form for dedup. */
    contactNameNormalized: text('contact_name_normalized').notNull(),

    email: text('email'),
    emailConfidence: numeric('email_confidence', { precision: 3, scale: 2 }),
    emailSourceUrl: text('email_source_url'),

    title: text('title'),
    titleConfidence: numeric('title_confidence', { precision: 3, scale: 2 }),
    titleSourceUrl: text('title_source_url'),

    phone: text('phone'),
    phoneConfidence: numeric('phone_confidence', { precision: 3, scale: 2 }),
    phoneSourceUrl: text('phone_source_url'),

    linkedinUrl: text('linkedin_url'),
    linkedinConfidence: numeric('linkedin_confidence', { precision: 3, scale: 2 }),
    linkedinSourceUrl: text('linkedin_source_url'),

    /** Provider tag — 'vex' today; reserved for future sources. */
    source: text('source').notNull().default('vex'),
    enrichedAt: timestamp('enriched_at', { withTimezone: true }).notNull(),

    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    dedupIdx: uniqueIndex('entity_contact_enrichments_dedup_idx').on(
      table.entitySlug,
      table.source,
      table.contactNameNormalized,
    ),
    entityIdx: index('entity_contact_enrichments_entity_idx').on(table.entitySlug),
  }),
);

export type EntityContactEnrichmentRow = typeof entityContactEnrichments.$inferSelect;
export type NewEntityContactEnrichmentRow = typeof entityContactEnrichments.$inferInsert;
