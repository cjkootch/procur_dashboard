import {
  doublePrecision,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { recordStatusEnum } from './enums';

/**
 * Per-field provenance entry. Stored as a map under `field_confidence`
 * on organizations and contacts. The merge layer reads these plus a
 * source-priority list to decide whether an incoming value should
 * overwrite the existing one.
 */
export interface FieldConfidenceEntry {
  value: unknown;
  source: string;
  confidence: number;
  updated_at: string;
}

export type FieldConfidenceMap = Record<string, FieldConfidenceEntry>;
export type ExternalKeys = Record<string, string>;

/**
 * Per docs/vex-into-procur-merge-brief.md Phase 1. CRM-style record of
 * the external organizations procur transacts with — buyers, suppliers,
 * brokers, intermediaries on fuel deals. Distinct from `companies`
 * (procur's own Clerk-org) and from `known_entities` (intelligence-derived
 * external entities). Phase 4+ will figure out bridges; for Phase 1
 * organizations is a fresh CRM table populated by the agent runtime.
 */
export const organizations = pgTable(
  'organizations',
  {
    id: text('id').primaryKey(),
    legalName: text('legal_name').notNull(),
    domain: text('domain'),
    industry: text('industry'),
    geo: jsonb('geo').$type<Record<string, unknown>>(),
    fitScore: doublePrecision('fit_score'),
    sourceOfTruth: text('source_of_truth'),
    externalKeys: jsonb('external_keys')
      .$type<ExternalKeys>()
      .notNull()
      .default({}),
    fieldConfidence: jsonb('field_confidence')
      .$type<FieldConfidenceMap>()
      .notNull()
      .default({}),
    /** Free-form tags appended by the chat agent. */
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    /** Counterparty role: buyer, supplier, broker, buyer_broker,
     *  internal, competitor. Text (not enum) so vocab can evolve. */
    kind: text('kind'),
    /** Counterparty-level OFAC gate. Allowed values: unscreened, clear,
     *  potential_match, confirmed_match, cleared_by_operator. */
    ofacStatus: text('ofac_status').notNull().default('unscreened'),
    ofacScreenedAt: timestamp('ofac_screened_at', { withTimezone: true }),
    ofacHighestScore: doublePrecision('ofac_highest_score'),
    status: recordStatusEnum('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    statusIdx: index('organizations_status_idx').on(t.status),
    domainIdx: index('organizations_domain_idx').on(t.domain),
    externalKeysGinIdx: index('organizations_external_keys_gin_idx').using(
      'gin',
      t.externalKeys,
    ),
  }),
);

export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;
