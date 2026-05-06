import { bigint, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Per docs/vex-into-procur-merge-brief.md Phase 2. Append-only ledger
 * of every chargeable operation (LLM tokens, tool calls, third-party
 * spend). `idempotency_key` is unique so retries don't double-charge.
 * Costs stored in micros (1e-6 USD) to avoid float drift across
 * aggregations. `agent_run_id` is text without a FK because the
 * cost-ledger writer can outlive the agent run row in degenerate
 * cases (telemetry adapter retries).
 */
export const costLedger = pgTable(
  'cost_ledger',
  {
    id: text('id').primaryKey(),
    agentRunId: text('agent_run_id'),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    operation: text('operation').notNull(),
    provider: text('provider').notNull(),
    model: text('model'),
    units: bigint('units', { mode: 'number' }).notNull(),
    unitKind: text('unit_kind').notNull(),
    costUsdMicros: bigint('cost_usd_micros', { mode: 'number' }).notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    occurredAtIdx: index('cost_ledger_occurred_at_idx').on(t.occurredAt),
    agentRunIdx: index('cost_ledger_agent_run_idx').on(t.agentRunId),
  }),
);

export type CostLedgerRow = typeof costLedger.$inferSelect;
export type NewCostLedgerRow = typeof costLedger.$inferInsert;
