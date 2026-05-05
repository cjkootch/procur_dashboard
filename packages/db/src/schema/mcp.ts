import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  index,
} from 'drizzle-orm/pg-core';
import { companies } from './companies';
import { users } from './users';

/**
 * Per-tenant API keys for external AI clients calling procur via
 * MCP (Model Context Protocol). Spec: docs/mcp-server-brief.md §4.1.
 *
 * Keys are sha-256-hashed (with a per-deployment pepper) before
 * storage. The raw key is shown once at creation and never persisted;
 * lost keys require generating a new one. The display_suffix lets the
 * UI render "procur_mcp_…7f3c" without storing the raw value.
 *
 * Every MCP call carries the key's company_id into the tool execution
 * context, so external-client queries get the same tenant-scoped view
 * the in-app assistant sees. created_by_user_id powers audit
 * attribution on any future write tools (v1 is read-only).
 */
export const mcpApiKeys = pgTable(
  'mcp_api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** sha-256 of (raw_key + pepper). Never includes the raw key. */
    keyHash: text('key_hash').notNull().unique(),

    /** Human-readable identifier picked by the operator at creation
     *  time, e.g. "Claude Desktop", "ChatGPT custom GPT". */
    name: text('name').notNull(),

    /** Tenant scope. */
    companyId: uuid('company_id')
      .references(() => companies.id)
      .notNull(),

    /** Audit attribution. */
    createdByUserId: uuid('created_by_user_id')
      .references(() => users.id)
      .notNull(),

    /** Last 4 chars of the raw key, e.g. "7f3c". Used for the
     *  "Claude Desktop … 7f3c" UI display. */
    displaySuffix: text('display_suffix').notNull(),

    /** 'active' | 'revoked'. Revoked keys stay around for audit
     *  attribution but fail auth-check at request time. */
    status: text('status').$type<'active' | 'revoked'>().notNull().default('active'),

    /** Populated on every successful tool call. Drives the
     *  "last used" indicator in the settings UI. */
    lastUsedAt: timestamp('last_used_at'),

    /** Cumulative successful tool calls. Coarse signal of which
     *  keys are actually in use vs dormant. */
    totalCalls: integer('total_calls').notNull().default(0),

    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    companyIdx: index('mcp_api_keys_company_idx').on(table.companyId),
    statusIdx: index('mcp_api_keys_status_idx').on(table.status),
  }),
);

export type McpApiKey = typeof mcpApiKeys.$inferSelect;
export type NewMcpApiKey = typeof mcpApiKeys.$inferInsert;

/**
 * One row per MCP tool call. Mirrors apollo_credit_log for
 * observability + abuse detection. Spec: docs/mcp-server-brief.md §4.2.
 */
export const mcpToolCallLog = pgTable(
  'mcp_tool_call_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    apiKeyId: uuid('api_key_id').references(() => mcpApiKeys.id),
    companyId: uuid('company_id').references(() => companies.id),
    toolName: text('tool_name').notNull(),

    /** 'success' | 'tool_error' | 'auth_failed' | 'rate_limited'
     *  | 'tool_not_whitelisted' | 'invalid_input'. */
    outcome: text('outcome')
      .$type<
        | 'success'
        | 'tool_error'
        | 'auth_failed'
        | 'rate_limited'
        | 'tool_not_whitelisted'
        | 'invalid_input'
      >()
      .notNull(),

    durationMs: integer('duration_ms'),

    /** Hash of the call's input args. Lets us spot duplicate calls
     *  without storing potentially-sensitive criteria. */
    argsHash: text('args_hash'),

    /** Free-text on the failure case. Empty for success. */
    errorMessage: text('error_message'),

    /** MCP host identifier from the User-Agent header. */
    hostIdentifier: text('host_identifier'),

    calledAt: timestamp('called_at').defaultNow().notNull(),
  },
  (table) => ({
    calledAtIdx: index('mcp_tool_call_log_called_at_idx').on(table.calledAt),
    apiKeyIdx: index('mcp_tool_call_log_api_key_idx').on(table.apiKeyId),
    companyCalledAtIdx: index('mcp_tool_call_log_company_called_at_idx').on(
      table.companyId,
      table.calledAt,
    ),
  }),
);

export type McpToolCallLogEntry = typeof mcpToolCallLog.$inferSelect;
export type NewMcpToolCallLogEntry = typeof mcpToolCallLog.$inferInsert;
