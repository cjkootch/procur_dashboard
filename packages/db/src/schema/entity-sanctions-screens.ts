import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Per-entity sanctions-screen verdicts pushed by vex's
 * SanctionsScreeningAgent. See migration 0055 for the rationale +
 * idempotency notes; mirrors the contact-enrichment pattern (mig 0052).
 *
 * Append-log: one row per screen run, keyed by
 * (vex_tenant_id, screen_id). Rows are immutable — a re-screen
 * produces a new row.
 *
 * Display surfaces resolve to "latest per (source_list)" by default;
 * full multi-tenant breakdown is available on request.
 */
export const entitySanctionsScreens = pgTable(
  'entity_sanctions_screens',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** known_entities.slug OR external_suppliers.id (same UUID-or-slug
        shape getEntityProfile accepts as canonicalKey). */
    entitySlug: text('entity_slug').notNull(),

    /** Vex's stable per-tenant id. Opaque; never deref'd into vex's
        user model on procur's side. */
    vexTenantId: text('vex_tenant_id').notNull(),
    /** Vex-generated UUIDv4 per share-call. Replay key for 5xx
        retries — UNIQUE on (vex_tenant_id, screen_id) lets us
        ON CONFLICT DO NOTHING cleanly. */
    screenId: text('screen_id').notNull(),

    /** Verbatim entity name vex sent — useful for audit + drift
        detection when vex's record diverges from known_entities.name. */
    legalName: text('legal_name').notNull(),

    /** 'clear' | 'potential_match' | 'confirmed_match'. Validated
        at the route; stored as text so future additions don't
        require a migration. */
    status: text('status').notNull(),

    /** Source-list codes the screen ran against — US CSL components
        (SDN, NS-PLC, SSI, FSE, DPL, EL, UVL, MEU, DTC, ISN, CAP),
        'EU', 'UK_OFSI', etc. The full coverage assertion. */
    sourcesChecked: text('sources_checked').array().notNull(),

    /** Per-list match details. Each entry has shape
        { source_list, sdn_uid, programs[], confidence_band, sdn_type }.
        Empty array when status='clear'. */
    matches: jsonb('matches')
      .notNull()
      .default(sql`'[]'::jsonb`),

    /** When vex performed the screen (NOT when procur received the
        row — see created_at for the latter). */
    screenedAt: timestamp('screened_at', { withTimezone: true }).notNull(),

    /** Provider tag — 'vex' today; reserved for future sources. */
    source: text('source').notNull().default('vex'),

    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    dedupIdx: uniqueIndex('entity_sanctions_screens_dedup_idx').on(
      table.vexTenantId,
      table.screenId,
    ),
    entityIdx: index('entity_sanctions_screens_entity_idx').on(
      table.entitySlug,
    ),
    screenedAtIdx: index('entity_sanctions_screens_screened_at_idx').on(
      table.entitySlug,
      table.screenedAt,
    ),
  }),
);

/** Source-list codes vex emits. Application-level allowlist for the
 *  route's payload validation. Schema column stays text[] so adding
 *  a new code never requires a migration. */
export const SANCTIONS_SOURCE_LISTS = [
  // US Consolidated Screening List components
  'SDN',
  'NS-PLC',
  'SSI',
  'FSE',
  'DPL',
  'EL',
  'UVL',
  'MEU',
  'DTC',
  'ISN',
  'CAP',
  // EU consolidated
  'EU',
  // UK OFSI
  'UK_OFSI',
] as const;

export type SanctionsSourceList = (typeof SANCTIONS_SOURCE_LISTS)[number];

export const SANCTIONS_STATUSES = [
  'clear',
  'potential_match',
  'confirmed_match',
] as const;

export type SanctionsStatus = (typeof SANCTIONS_STATUSES)[number];

export const SANCTIONS_CONFIDENCE_BANDS = [
  'high_confidence',
  'fuzzy_review',
] as const;

export type SanctionsConfidenceBand =
  (typeof SANCTIONS_CONFIDENCE_BANDS)[number];

export const SANCTIONS_SDN_TYPES = [
  'individual',
  'entity',
  'vessel',
  'aircraft',
] as const;

export type SanctionsSdnType = (typeof SANCTIONS_SDN_TYPES)[number];

export type EntitySanctionsScreenRow =
  typeof entitySanctionsScreens.$inferSelect;
export type NewEntitySanctionsScreenRow =
  typeof entitySanctionsScreens.$inferInsert;
