import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { rawEventStatusEnum } from './enums';

/**
 * Per docs/vex-into-procur-merge-brief.md Phase 3. Webhook + inbound
 * payload audit log. RANGE-partitioned by `received_at` in the
 * migration; the Drizzle definition describes the logical shape.
 * `(received_at, provider, provider_event_id)` uniqueness gives the
 * ingestion adapter idempotent retries.
 */
export const rawEvents = pgTable(
  'raw_events',
  {
    id: text('id').notNull(),
    provider: text('provider').notNull(),
    providerEventId: text('provider_event_id').notNull(),
    headers: jsonb('headers')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    checksum: text('checksum'),
    status: rawEventStatusEnum('status').notNull().default('pending'),
  },
  (t) => ({
    receivedAtIdx: index('raw_events_received_at_idx').on(t.receivedAt),
    providerUniq: uniqueIndex('raw_events_provider_event_uniq').on(
      t.receivedAt,
      t.provider,
      t.providerEventId,
    ),
  }),
);

export type RawEvent = typeof rawEvents.$inferSelect;
export type NewRawEvent = typeof rawEvents.$inferInsert;
