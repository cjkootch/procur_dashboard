import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';
import { companies } from './companies';
import { users } from './users';
import { assistantThreads } from './assistant-threads';

/**
 * Structured per-tool-call telemetry. Distinct from `assistant_messages`
 * (which stores the raw conversation as Claude content blocks) — this
 * table captures one row per tool invocation with the args + result
 * shape pre-extracted so analytics queries don't have to deserialize
 * JSONB content arrays.
 *
 * Filled by tool handlers via logToolCall() in @procur/ai. Direct
 * API-call invocations (e.g. /api/suppliers/reverse-search) can also
 * call logToolCall() with threadId=null.
 *
 * Use cases this enables:
 *   - "How often does find_buyers_for_offer fire?" (adoption signal)
 *   - "How often does it return zero results?" (coverage gap signal)
 *   - "Which categoryTag values get hit most?" (data-prioritization signal)
 *   - p50/p99 latency per tool
 *
 * Multi-tenant: companyId-scoped. Cross-tenant analytics require an
 * explicit aggregate view (not built in v1).
 */
export const toolCallLogs = pgTable(
  'tool_call_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .references(() => companies.id, { onDelete: 'cascade' })
      .notNull(),
    userId: uuid('user_id')
      .references(() => users.id, { onDelete: 'set null' }),
    /** Null for direct API-call invocations outside an assistant thread. */
    threadId: uuid('thread_id').references(() => assistantThreads.id, {
      onDelete: 'set null',
    }),

    toolName: text('tool_name').notNull(),
    /** Tool input as the LLM called it. Schema varies per tool. */
    args: jsonb('args'),
    /** Number of items in the response (length of buyers/suppliers/awards array). */
    resultCount: integer('result_count'),
    /** Free-form summary kv used for cheap downstream filters
     *  (e.g. {categoryTag: 'diesel', kind: 'profile'}). */
    resultSummary: jsonb('result_summary'),

    success: boolean('success').notNull(),
    errorMessage: text('error_message'),
    latencyMs: integer('latency_ms').notNull(),

    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    companyToolIdx: index('tool_call_logs_company_tool_idx').on(
      table.companyId,
      table.toolName,
      table.createdAt,
    ),
    toolTimeIdx: index('tool_call_logs_tool_time_idx').on(table.toolName, table.createdAt),
  }),
);

export type ToolCallLog = typeof toolCallLogs.$inferSelect;
export type NewToolCallLog = typeof toolCallLogs.$inferInsert;
