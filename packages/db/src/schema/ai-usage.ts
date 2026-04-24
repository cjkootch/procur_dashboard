import { pgTable, uuid, date, text, integer, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { companies } from './companies';

/**
 * Daily roll-up of AI spend per company per source.
 *
 * We upsert on (company_id, date, source) and accumulate counters.
 * Sources cover every origin of AI cost so the total column on a row
 * is authoritative for that slice.
 *
 *   - 'assistant'            — interactive agent turns
 *   - 'enrich'               — opportunity enrichment pipeline (classify/summarize/detect/translate)
 *   - 'extract_requirements' — tender requirement extraction
 *   - 'draft_section'        — proposal section drafting
 *   - 'review_proposal'      — AI proposal review
 *   - 'map_requirements'     — compliance matrix auto-mapping
 *   - 'extract_pricing'      — pricer structure extraction
 *   - 'extract_company_profile' — company profile autofill
 *   - 'embeddings'           — OpenAI embeddings (library + past performance)
 *   - 'other'                — fallback bucket
 */
export const aiUsage = pgTable(
  'ai_usage',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .references(() => companies.id, { onDelete: 'cascade' })
      .notNull(),
    date: date('date').notNull(),
    source: text('source').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheCreationTokens: integer('cache_creation_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    costUsdCents: integer('cost_usd_cents').notNull().default(0),
    calls: integer('calls').notNull().default(0),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    companyDateSourceIdx: uniqueIndex('ai_usage_company_date_source_idx').on(
      table.companyId,
      table.date,
      table.source,
    ),
    companyDateIdx: index('ai_usage_company_date_idx').on(table.companyId, table.date),
  }),
);

export type AiUsage = typeof aiUsage.$inferSelect;
export type NewAiUsage = typeof aiUsage.$inferInsert;
