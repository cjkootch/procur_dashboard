import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Broker / origination partner / sub-broker fee arrangements VTC uses.
 * Spec: docs/deal-structures-catalog-brief.md §4 + §7.
 *
 * Distinct from `contracts.commission_terms` (which captures the fee
 * structure on a specific signed contract). This table captures the
 * STANDARD structures from which specific contracts may deviate —
 * canonical playbook entries that signed agreements reference by slug.
 *
 * Hand-curated. ~8-12 entries at steady state. Each new partner
 * agreement either references an existing structure or creates a new
 * entry if the terms are novel.
 */
export const commissionStructures = pgTable(
  'commission_structures',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),

    /** 'origination-partner' | 'intermediary-broker' | 'sub-broker'
     *  | 'finder-fee' | 'introducer' | 'consultant'
     *  | 'sole-and-exclusive-broker'. */
    category: text('category').notNull(),

    /** 'vtc-pays-third-party' | 'vtc-receives-from-third-party'
     *  | 'split-with-third-party'. */
    partyRelationship: text('party_relationship').notNull(),

    /** Which VTC entity is party. Drives signature, ledger, currency. */
    vtcEntity: text('vtc_entity').notNull(),

    // ─── Fee mechanics ──────────────────────────────────────────

    /** 'pct-of-net-margin' | 'pct-of-gross-revenue' | 'usd-per-unit'
     *  | 'flat-fee-per-deal' | 'flat-fee-per-lifting' | 'tiered-by-volume'
     *  | 'tiered-by-margin' | 'success-fee-only'. */
    basisType: text('basis_type').notNull(),

    /** Polymorphic fee data. Validation in TypeScript layer.
     *  Examples by basisType:
     *    pct-of-net-margin: { partyShare: 0.5 }
     *    usd-per-unit: { amountUsd: 0.25, unit: 'bbl' }
     *    flat-fee-per-deal: { amountUsd: 50000 }
     *    tiered-by-volume: { tiers: [{ minVolume, maxVolume, ratePerUnit, unit }] }
     */
    feeStructure: jsonb('fee_structure').notNull(),

    // ─── Triggering + timing ────────────────────────────────────

    triggerEvent: text('trigger_event').notNull(),
    paymentTiming: text('payment_timing').notNull(),

    // ─── Coverage ───────────────────────────────────────────────

    /** Empty array = applies to all categories. */
    appliesToCategories: text('applies_to_categories').array().notNull(),
    /** Empty array = applies to all templates within the categories.
     *  Slugs reference deal_structure_templates.slug. */
    appliesToTemplateSlugs: text('applies_to_template_slugs').array().notNull(),

    /** Whether this commission can stack with others on the same deal,
     *  or whether it's exclusive. Critical for fee-burden analysis. */
    exclusivePerDeal: boolean('exclusive_per_deal').notNull().default(false),

    /** Whether the third party cannot offer the same opportunity to
     *  other principals during the agreement term. */
    soleAndExclusive: boolean('sole_and_exclusive').notNull().default(false),

    // ─── Term + renewal ─────────────────────────────────────────

    termMonths: integer('term_months'),
    autoRenewal: boolean('auto_renewal').notNull().default(false),
    terminationNoticeDays: integer('termination_notice_days'),

    // ─── Documentation ──────────────────────────────────────────

    standardAgreementClause: text('standard_agreement_clause'),
    taxTreatmentNotes: text('tax_treatment_notes'),

    notes: text('notes'),
    /** 'active' | 'draft' | 'deprecated' | 'archived'. */
    status: text('status').notNull().default('draft'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    categoryIdx: index('commission_structures_category_idx').on(t.category),
    entityIdx: index('commission_structures_entity_idx').on(t.vtcEntity),
    statusIdx: index('commission_structures_status_idx').on(t.status),
  }),
);

export type CommissionStructure = typeof commissionStructures.$inferSelect;
export type NewCommissionStructure = typeof commissionStructures.$inferInsert;
