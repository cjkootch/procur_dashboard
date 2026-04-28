import {
  pgTable,
  uuid,
  text,
  numeric,
  boolean,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Corporate ownership relationships — who owns whom across the energy
 * industry. Sourced from GEM's Global Energy Ownership Tracker (GEOT)
 * "Entity Ownership" sheet (~26K rows, March 2026).
 *
 * Distinct from `known_entities` (which is the asset/operator rolodex):
 * this table captures the GRAPH of company-to-company ownership, not
 * the asset operators themselves. e.g.
 *
 *   subject  = "Sonatrach"
 *   parent   = "Government of Algeria"
 *   share_pct = 100
 *
 * Combined with the known_entities operator field, this lets us walk
 * "Eni Sannazzaro Refinery → operator Eni S.p.A. → 30% Italian govt,
 * 70% public" and surface the sovereign backing of every refinery.
 *
 * Public-domain (CC-BY-4.0 from GEM). No companyId scoping.
 */
export const entityOwnership = pgTable(
  'entity_ownership',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** 'gem-geot' (only source for now). Scope keeps the table
        future-proof for additional ownership data sources. */
    source: text('source').notNull(),

    /** GEM's stable entity ID for the subject entity (E100000000003). */
    subjectGemId: text('subject_gem_id').notNull(),
    subjectName: text('subject_name').notNull(),

    /** GEM ID for the parent / interested party. */
    parentGemId: text('parent_gem_id').notNull(),
    parentName: text('parent_name').notNull(),

    /** 0..100 — % of subject owned by parent. May be 0 (informational
        relationship recorded for completeness). */
    sharePct: numeric('share_pct', { precision: 5, scale: 2 }),

    /** True when the share value was inferred from public records
        rather than directly published. */
    shareImputed: boolean('share_imputed').default(false).notNull(),

    /** Comma-separated list (verbatim from GEM) of source URLs that
        backed the relationship. Stored as text — can be split client-
        side when displaying. */
    sourceUrls: text('source_urls'),

    ingestedAt: timestamp('ingested_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    // Source-specific uniqueness — re-running the ingest updates rows.
    sourceUniq: uniqueIndex('entity_ownership_source_uniq_idx').on(
      table.source,
      table.subjectGemId,
      table.parentGemId,
    ),
    // Trigram indexes on names for fuzzy-match lookups by entity name
    // (callers don't have GEM IDs; they have "Eni" or "Sonatrach").
    subjectNameTrgmIdx: index('entity_ownership_subject_name_trgm_idx').using(
      'gin',
      sql`${table.subjectName} gin_trgm_ops`,
    ),
    parentNameTrgmIdx: index('entity_ownership_parent_name_trgm_idx').using(
      'gin',
      sql`${table.parentName} gin_trgm_ops`,
    ),
    // Walk the chain forward (subject → parent) and backward
    // (parent → subjects); btree on the canonical IDs is the path.
    subjectGemIdx: index('entity_ownership_subject_gem_idx').on(table.subjectGemId),
    parentGemIdx: index('entity_ownership_parent_gem_idx').on(table.parentGemId),
  }),
);

export type EntityOwnership = typeof entityOwnership.$inferSelect;
export type NewEntityOwnership = typeof entityOwnership.$inferInsert;
