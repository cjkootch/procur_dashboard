import {
  doublePrecision,
  index,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { fuelDeals } from './fuel-deals';
import { organizations } from './organizations';
import { contacts } from './contacts';

/**
 * Per docs/vex-into-procur-merge-brief.md Phase 5. Per-deal
 * participants with heterogeneous commission structures. A deal often
 * involves more parties than the buyer/seller pair on `fuel_deals` —
 * supplier-side brokers, buyer-side brokers, intermediaries — each
 * paid differently (% of deal, ¢/L, $/MT, flat). `display_name` is
 * always set because operators routinely build deals before the
 * broker's company is added to the CRM.
 */
export const fuelDealParticipants = pgTable(
  'fuel_deal_participants',
  {
    id: text('id').primaryKey(),
    dealId: text('deal_id')
      .notNull()
      .references(() => fuelDeals.id, { onDelete: 'cascade' }),

    /** Role: supplier | supplier_broker | buyer | buyer_broker |
     *  intermediary. Text — vocab can evolve. */
    partyType: text('party_type').notNull(),

    orgId: text('org_id').references(() => organizations.id, {
      onDelete: 'set null',
    }),
    contactId: text('contact_id').references(() => contacts.id, {
      onDelete: 'set null',
    }),
    displayName: text('display_name').notNull(),

    /** Commission pricing model: percentage | cents_per_liter |
     *  usd_per_mt | flat_usd | none. */
    commissionType: text('commission_type').notNull().default('none'),
    commissionValue: doublePrecision('commission_value'),
    commissionNotes: text('commission_notes'),

    notes: text('notes'),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    dealIdx: index('fuel_deal_participants_deal_idx').on(t.dealId),
    orgIdx: index('fuel_deal_participants_org_idx').on(t.orgId),
  }),
);

export type FuelDealParticipant = typeof fuelDealParticipants.$inferSelect;
export type NewFuelDealParticipant = typeof fuelDealParticipants.$inferInsert;
