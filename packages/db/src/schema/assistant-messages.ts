import { pgTable, uuid, text, timestamp, integer, jsonb, index } from 'drizzle-orm/pg-core';
import { assistantThreads } from './assistant-threads';

/**
 * Role convention:
 *   - 'user'      — human message, content is a plain text block
 *   - 'assistant' — model turn, content is the array of output blocks
 *                   (text | tool_use) returned by Claude
 *   - 'tool'      — result of a tool_use, content is an array of tool_result blocks
 *                   Stored as its own row (not nested on the assistant turn) so the
 *                   chat can be replayed incrementally and tool_result rendering
 *                   can be streamed separately.
 *   - 'system'    — reserved for future per-thread pinned context; not used in v1
 */
export const assistantMessages = pgTable(
  'assistant_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    threadId: uuid('thread_id')
      .references(() => assistantThreads.id, { onDelete: 'cascade' })
      .notNull(),
    role: text('role').notNull(), // user | assistant | tool | system
    // Claude content block array (TextBlockParam | ToolUseBlockParam | ToolResultBlockParam | ...)
    content: jsonb('content').notNull(),
    // Usage attributed to this turn. Present on assistant turns; null otherwise.
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    cacheCreationTokens: integer('cache_creation_tokens'),
    cacheReadTokens: integer('cache_read_tokens'),
    costUsdCents: integer('cost_usd_cents'), // rounded integer cents for fast aggregation
    // Anthropic stop_reason for assistant turns. Null otherwise.
    stopReason: text('stop_reason'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    threadIdx: index('assistant_messages_thread_idx').on(table.threadId, table.createdAt),
  }),
);

export type AssistantMessage = typeof assistantMessages.$inferSelect;
export type NewAssistantMessage = typeof assistantMessages.$inferInsert;
