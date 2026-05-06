import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';

/**
 * Directed edges between organizations. Primary use-case is
 * broker ↔ supplier: "Broker A brokers rice for Supplier B" becomes
 * a `brokers_for` row from_org_id=A → to_org_id=B with product='rice'.
 * `relationship_type`: brokers_for | sources_from | partners_with |
 * subsidiary_of (text — vocab can evolve). `product` nullable —
 * null = relationship covers all common products.
 */
export const organizationRelationships = pgTable(
  'organization_relationships',
  {
    id: text('id').primaryKey(),
    fromOrgId: text('from_org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    toOrgId: text('to_org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    relationshipType: text('relationship_type').notNull(),
    product: text('product'),
    notes: text('notes'),
    addedBy: text('added_by'),
    addedAt: timestamp('added_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    fromIdx: index('organization_relationships_from_idx').on(
      t.fromOrgId,
      t.relationshipType,
    ),
    toIdx: index('organization_relationships_to_idx').on(
      t.toOrgId,
      t.relationshipType,
    ),
  }),
);

export type OrganizationRelationship =
  typeof organizationRelationships.$inferSelect;
export type NewOrganizationRelationship =
  typeof organizationRelationships.$inferInsert;
