import { pgTable, uuid, text, integer, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Audit log for reranker runs. See migration 0087 for rationale.
 *
 * One row per reranker call: query, candidate count, selected IDs,
 * model version, free-form caller context. Scores are deliberately
 * NOT stored here — reranker scores must not leak into operator-
 * facing copy. If offline tuning needs scores, add a sibling
 * `retrieval_run_passages` table later.
 */
export const retrievalRuns = pgTable(
  'retrieval_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    query: text('query').notNull(),

    candidateCount: integer('candidate_count').notNull(),

    /** IDs the reranker kept (top-K). Free namespace; producers
     *  choose whether these are entity_web_pages.id, message ids,
     *  web_summary section_kinds, etc. */
    selectedIds: jsonb('selected_ids')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),

    modelVersion: text('model_version').notNull(),

    /** Caller context — approval_id, source_kind, intent. Stamped
     *  per call without schema migration. */
    context: jsonb('context')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    createdIdx: index('retrieval_runs_created_idx').on(table.createdAt),
    modelIdx: index('retrieval_runs_model_idx').on(table.modelVersion),
  }),
);

export type RetrievalRun = typeof retrievalRuns.$inferSelect;
export type NewRetrievalRun = typeof retrievalRuns.$inferInsert;
