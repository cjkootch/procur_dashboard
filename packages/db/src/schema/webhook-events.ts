import { pgTable, uuid, text, timestamp, integer, boolean, jsonb, index } from 'drizzle-orm/pg-core';
import { companies } from './companies';

/**
 * Inbound webhook receipts. Every Stripe / Clerk webhook hit records
 * one row, even when the signature fails or the handler throws —
 * so ops can see "we got the event but rejected it" vs "we never got
 * the event" when a customer reports a billing or auth issue.
 *
 * Companion to audit_log: audit_log captures user-driven events,
 * webhook_events captures provider-driven events. They never overlap.
 */

export type WebhookProvider = 'stripe' | 'clerk' | 'other';

export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    provider: text('provider').$type<WebhookProvider>().notNull(),
    /** Provider's event id (e.g. Stripe `evt_…`, Clerk svix-id). Used for
        dedup queries; not enforced as unique because retries on signature
        failure should still leave a paper trail. */
    eventId: text('event_id'),
    /** Provider event type, e.g. `customer.subscription.updated`. */
    eventType: text('event_type'),

    /** Tenant inferred from the payload, when we can. NULL for events that
        don't (yet) map to a company (e.g. Clerk `user.created` before the
        clerk-org sync). */
    companyId: uuid('company_id').references(() => companies.id, { onDelete: 'set null' }),

    signatureValid: boolean('signature_valid').notNull().default(true),
    /** HTTP status we returned to the provider. 2xx = handled, 4xx = rejected
        (signature/headers), 5xx = handler crashed (provider will retry). */
    responseStatus: integer('response_status').notNull(),

    /** Set when we finished applying the event without error. */
    processedAt: timestamp('processed_at'),
    /** Stack-trace-ish string when the handler threw. */
    errorMessage: text('error_message'),

    /** Raw decoded payload. Capped client-side at 100k chars before insert. */
    payload: jsonb('payload'),

    receivedAt: timestamp('received_at').defaultNow().notNull(),
  },
  (table) => ({
    providerReceivedIdx: index('webhook_events_provider_received_idx').on(
      table.provider,
      table.receivedAt,
    ),
    eventIdIdx: index('webhook_events_event_id_idx').on(table.eventId),
    companyIdx: index('webhook_events_company_idx').on(table.companyId),
  }),
);

export type WebhookEvent = typeof webhookEvents.$inferSelect;
export type NewWebhookEvent = typeof webhookEvents.$inferInsert;
