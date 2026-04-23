import { pgTable, uuid, text, timestamp, integer, jsonb, index } from 'drizzle-orm/pg-core';
import { scraperRunStatusEnum } from './enums';
import { jurisdictions } from './jurisdictions';

export const scraperRuns = pgTable(
  'scraper_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jurisdictionId: uuid('jurisdiction_id')
      .references(() => jurisdictions.id)
      .notNull(),

    startedAt: timestamp('started_at').notNull(),
    completedAt: timestamp('completed_at'),
    durationMs: integer('duration_ms'),

    status: scraperRunStatusEnum('status').notNull(),
    recordsFound: integer('records_found').default(0),
    recordsNew: integer('records_new').default(0),
    recordsUpdated: integer('records_updated').default(0),
    recordsSkipped: integer('records_skipped').default(0),

    errors: jsonb('errors').$type<
      Array<{
        message: string;
        stack?: string;
        context?: Record<string, unknown>;
      }>
    >(),

    logOutput: text('log_output'),
    triggerRunId: text('trigger_run_id'),

    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    jurisdictionIdx: index('scraper_run_jur_idx').on(table.jurisdictionId),
    startedIdx: index('scraper_run_started_idx').on(table.startedAt),
  }),
);

export type ScraperRun = typeof scraperRuns.$inferSelect;
export type NewScraperRun = typeof scraperRuns.$inferInsert;
