import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';
import { companies } from './companies';

/**
 * Tenant-scoped saved searches that fire as alerts when a new
 * organization matches the saved Apollo filters. Spec:
 * docs/apollo-integration-brief.md §4.3.
 *
 * Apollo credentials are global (single master key); the saved
 * queries are per-tenant because they encode commercial intent
 * specific to that tenant's deal flow.
 */
export const apolloSavedSearches = pgTable(
  'apollo_saved_searches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .references(() => companies.id)
      .notNull(),
    name: text('name').notNull(),
    description: text('description'),

    /** Apollo search filter object — same shape the service-layer
     *  search function takes. Stored as jsonb so filter shape can
     *  evolve without schema migrations. */
    searchFilters: jsonb('search_filters').notNull(),

    /** 'on-new-match' fires when an org appears in results that
     *  wasn't there last run. 'periodic' surfaces the full result
     *  set as a digest. */
    alertMode: text('alert_mode')
      .$type<'on-new-match' | 'periodic'>()
      .notNull()
      .default('on-new-match'),

    /** Cron-like shorthand: 'daily' | 'weekly' | 'hourly' or a real
     *  cron expression. The runner job interprets this. */
    schedule: text('schedule').notNull().default('daily'),

    /** Org IDs returned on the previous run. Diff against the next
     *  run's results to compute "new since last run". */
    lastSeenOrgIds: text('last_seen_org_ids').array().notNull().default([]),
    lastRunAt: timestamp('last_run_at'),

    /** 'active' | 'paused' | 'archived'. */
    status: text('status').notNull().default('active'),

    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    companyIdx: index('apollo_saved_searches_company_idx').on(table.companyId),
    statusIdx: index('apollo_saved_searches_status_idx').on(table.status),
  }),
);

export type ApolloSavedSearch = typeof apolloSavedSearches.$inferSelect;
export type NewApolloSavedSearch = typeof apolloSavedSearches.$inferInsert;

/**
 * One row per Apollo API call. Used to measure monthly credit burn
 * against the Apollo plan and to tune freshness windows. Powers the
 * admin observability page; not user-facing.
 */
export const apolloCreditLog = pgTable(
  'apollo_credit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** 'organizations.get' | 'mixed_companies.search' */
    endpoint: text('endpoint').notNull(),
    /** Hash of the call's args. Lets us spot duplicate calls during
     *  cron-runner tuning without storing potentially-large payloads. */
    argsHash: text('args_hash'),
    page: integer('page'),
    perPage: integer('per_page'),
    httpStatus: integer('http_status'),
    /** Apollo doesn't return credit cost in the response; this is
     *  inferred from plan rules. Nullable until that mapping is wired. */
    creditsSpent: integer('credits_spent'),
    durationMs: integer('duration_ms'),
    /** '401' | '403' | '422' | '429' | 'rate-limited-internally'
     *  | 'feature-flag-disabled' | 'transport' | null. */
    errorCode: text('error_code'),
    notes: text('notes'),
    calledAt: timestamp('called_at').defaultNow().notNull(),
  },
  (table) => ({
    calledAtIdx: index('apollo_credit_log_called_at_idx').on(table.calledAt),
    endpointIdx: index('apollo_credit_log_endpoint_idx').on(table.endpoint),
  }),
);

export type ApolloCreditLogEntry = typeof apolloCreditLog.$inferSelect;
export type NewApolloCreditLogEntry = typeof apolloCreditLog.$inferInsert;
