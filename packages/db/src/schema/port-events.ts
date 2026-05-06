import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { ports } from './ports';

/**
 * Per docs/vex-into-procur-merge-brief.md Phase 5. Closures,
 * congestion, strikes, tariff changes, regulatory updates. Append-only,
 * cascades on the parent port. `ends_at IS NULL` means the event is
 * ongoing — the port-intelligence agent queries this table to fire
 * signals against every live deal touching an affected port. FKs to
 * procur's existing `ports.slug` (not vex's port.id).
 */
export const portEvents = pgTable(
  'port_events',
  {
    id: text('id').primaryKey(),
    portSlug: text('port_slug')
      .notNull()
      .references(() => ports.slug, { onDelete: 'cascade' }),
    /** "closure" | "congestion" | "strike" | "tariff_change" | "regulatory" */
    eventType: text('event_type').notNull(),
    /** "info" | "warn" | "critical" */
    severity: text('severity').notNull().default('info'),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    title: text('title').notNull(),
    body: text('body'),
    sourceUrl: text('source_url'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    portIdx: index('port_events_port_idx').on(t.portSlug, t.startsAt),
    activeIdx: index('port_events_active_idx').on(t.startsAt, t.endsAt),
  }),
);

export type PortEvent = typeof portEvents.$inferSelect;
export type NewPortEvent = typeof portEvents.$inferInsert;
