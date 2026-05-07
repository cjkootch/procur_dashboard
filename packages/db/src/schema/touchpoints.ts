import { index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { campaigns } from './campaigns';
import { leads } from './leads';
import { contacts } from './contacts';
import { organizations } from './organizations';

/**
 * Per docs/vex-into-procur-merge-brief.md Phase 4. Per-event
 * interaction record across the campaign / lead / contact / org
 * graph. `actor` is free-form (agent name, user id, system component).
 * Polymorphic FKs — at most one of (campaign_id, lead_id) usually
 * set, plus the contact and org the touchpoint targeted.
 */
export const touchpoints = pgTable(
  'touchpoints',
  {
    id: text('id').primaryKey(),
    channel: text('channel').notNull(),
    actor: text('actor'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    campaignId: text('campaign_id').references(() => campaigns.id, {
      onDelete: 'set null',
    }),
    leadId: text('lead_id').references(() => leads.id, {
      onDelete: 'set null',
    }),
    contactId: text('contact_id').references(() => contacts.id, {
      onDelete: 'set null',
    }),
    orgId: text('org_id').references(() => organizations.id, {
      onDelete: 'set null',
    }),
    /** Optional pin to a fuel_deal (text ULID, no FK declared — matches
     *  the polymorphic-via-metadata convention; keeping it as a plain
     *  text + partial index avoids cascade complications when a deal is
     *  reassigned). Powers the /deals/[id] room's Communications tab. */
    dealId: text('deal_id'),
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    occurredAtIdx: index('touchpoints_occurred_at_idx').on(t.occurredAt),
    campaignIdx: index('touchpoints_campaign_idx').on(t.campaignId),
    leadIdx: index('touchpoints_lead_idx').on(t.leadId),
    contactIdx: index('touchpoints_contact_idx').on(t.contactId),
    orgIdx: index('touchpoints_org_idx').on(t.orgId),
    dealIdx: index('touchpoints_deal_idx').on(t.dealId),
  }),
);

export type Touchpoint = typeof touchpoints.$inferSelect;
export type NewTouchpoint = typeof touchpoints.$inferInsert;
