import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { organizations } from './organizations';

/**
 * Per docs/vex-into-procur-merge-brief.md Phase 4. Cached procur tool
 * responses keyed off (org_id, procur_tool, query_hash). Refreshed on
 * a TTL or on operator request. Idempotent on the unique index — re-
 * fetches upsert in place. Distinct from procur's own caches because
 * the agent runtime needs its own canonicalised slice of procur data
 * keyed to specific organizations.
 */
export const procurIntelligenceSnapshots = pgTable(
  'procur_intelligence_snapshots',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** analyze_supplier, analyze_supplier_pricing, find_recent_cargoes,
     *  analyze_buyer_pricing, entity_news, etc. */
    procurTool: text('procur_tool').notNull(),
    /** Canonical hash of the input args. */
    queryHash: text('query_hash').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => ({
    orgToolIdx: index('procur_snapshots_org_tool_idx').on(
      t.orgId,
      t.procurTool,
    ),
    expiresIdx: index('procur_snapshots_expires_idx').on(t.expiresAt),
    uniqueKey: uniqueIndex('procur_snapshots_unique_idx').on(
      t.orgId,
      t.procurTool,
      t.queryHash,
    ),
  }),
);

export type ProcurIntelligenceSnapshot =
  typeof procurIntelligenceSnapshots.$inferSelect;
export type NewProcurIntelligenceSnapshot =
  typeof procurIntelligenceSnapshots.$inferInsert;
