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

    /** Provider tag — 'vex' originally; 'apollo' added per
        apollo-integration-brief.md §4.4. */
    source: text('source').notNull().default('vex'),
    enrichedAt: timestamp('enriched_at', { withTimezone: true }).notNull(),

    // ─── Apollo people enrichment fields (per apollo brief §4.4) ──

    /** Apollo's stable person ID. Required when source = 'apollo';
        nullable for legacy source = 'vex' rows. Used for
        re-enrichment over time. */
    apolloPersonId: text('apollo_person_id'),

    /** Apollo's structured seniority field: 'owner' | 'founder' |
        'c_suite' | 'partner' | 'vp' | 'head' | 'director' |
        'manager' | 'senior' | 'entry' | 'intern'. Filterable in
        the Decision-makers panel. */
    seniority: text('seniority'),

    /** Apollo's data-freshness timestamp — distinct from enrichedAt
        (procur's last write to this row). */
    apolloLastRefreshedAt: timestamp('apollo_last_refreshed_at'),

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
    apolloPersonIdIdx: index('entity_contact_enrichments_apollo_person_id_idx').on(
      table.apolloPersonId,
    ),
    seniorityIdx: index('entity_contact_enrichments_seniority_idx').on(table.seniority),
  }),
);

export type EntityContactEnrichmentRow = typeof entityContactEnrichments.$inferSelect;
export type NewEntityContactEnrichmentRow = typeof entityContactEnrichments.$inferInsert;
