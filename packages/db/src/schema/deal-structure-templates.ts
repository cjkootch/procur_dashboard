import {
  boolean,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * VTC's standard deal-shaping templates — Incoterm × payment instrument
 * × region × VTC entity bundles VTC actually offers in the market. Spec:
 * docs/deal-structures-catalog-brief.md.
 *
 * Distinct from `proposals` (instantiated deals) and `pricing_models`
 * (priced offers). Templates are the canonical *shape* a proposal /
 * pricing model instantiates. Proposals reference a template by slug
 * and override individual fields when a deal warrants it; templates
 * themselves capture the standard parameters.
 *
 * Hand-curated. ~25-40 entries total at steady state, organized by
 * category (refined-product / specialty-crude / crude-conventional /
 * food-commodity / vehicle / lng / lpg). Population is per the brief
 * §6 seed list.
 *
 * Public-domain: shared across tenants. Per the brief §10 integration,
 * proposals and contracts reference these templates by slug; the slugs
 * are the stable keys.
 */
export const dealStructureTemplates = pgTable(
  'deal_structure_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** Stable kebab-case identifier referenced from proposals,
     *  pricing models, and contracts. */
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),

    /** 'refined-product' | 'specialty-crude' | 'crude-conventional'
     *  | 'food-commodity' | 'vehicle' | 'lng' | 'lpg'. */
    category: text('category').notNull(),

    /** Which VTC entity executes this structure. Driven by the
     *  entity-separation discipline from specialty-crude-strategy.md
     *  §6.1. No template can be ambiguous about which entity uses it.
     *  Values: 'vtc-llc' | 'vector-antilles' | 'vector-auto-exports'
     *        | 'vector-food-fund' | 'stabroek-advisory'. */
    vtcEntity: text('vtc_entity').notNull(),

    /** Where this template is operationally valid. Multiple regions
     *  allowed. */
    applicableRegions: text('applicable_regions').array().notNull(),

    // ─── Commercial mechanics ────────────────────────────────────

    /** Incoterms 2020 designation (DES retained for crude-trade use). */
    incoterm: text('incoterm').notNull(),
    /** Free-text — edge cases like "ship's manifold" vs "loading flange"
     *  matter in commodity trade. */
    riskTransferPoint: text('risk_transfer_point').notNull(),

    paymentInstrument: text('payment_instrument').notNull(),
    paymentCurrency: text('payment_currency').notNull(),
    /** Confirmed LC requirement for high-risk origin / destination. */
    lcConfirmationRequired: boolean('lc_confirmation_required').notNull().default(false),

    // ─── Insurance + inspection ─────────────────────────────────

    cargoInsurance: text('cargo_insurance'),
    /** Typical 110% of CIF value per Incoterms convention. */
    insuranceCoveragePct: numeric('insurance_coverage_pct', { precision: 5, scale: 2 }),
    inspectionRequirement: text('inspection_requirement'),
    qualityStandard: text('quality_standard'),

    // ─── Documentation (ordered) ────────────────────────────────

    /** Standard document set delivered by seller. Order matters —
     *  represents typical bank presentation sequence. */
    standardDocuments: text('standard_documents').array().notNull(),

    // ─── Timing ─────────────────────────────────────────────────

    typicalCycleTimeDaysMin: integer('typical_cycle_time_days_min'),
    typicalCycleTimeDaysMax: integer('typical_cycle_time_days_max'),
    laycanWindow: text('laycan_window'),

    // ─── Margin + commercial expectations ───────────────────────

    marginStructure: text('margin_structure'),
    typicalMarginMin: numeric('typical_margin_min', { precision: 10, scale: 4 }),
    typicalMarginMax: numeric('typical_margin_max', { precision: 10, scale: 4 }),
    /** 'pct' | 'usd-per-mt' | 'usd-per-bbl' | 'usd-per-shipment'. */
    marginUnit: text('margin_unit'),

    // ─── Risk perimeter ─────────────────────────────────────────

    ofacScreeningRequired: boolean('ofac_screening_required').notNull().default(true),
    /** ISO-2 country codes excluded independent of license framework. */
    excludedJurisdictions: text('excluded_jurisdictions').array().notNull(),
    excludedCounterpartyTypes: text('excluded_counterparty_types').array().notNull(),
    /** Specific OFAC GLs that authorize use against otherwise-excluded
     *  jurisdictions. e.g. ['VEN-GL-48', 'RUS-GL-8-ENERGY']. */
    generalLicenseEligible: text('general_license_eligible').array(),

    // ─── Counsel validation ─────────────────────────────────────

    /** Per origination-partners-brief.md §4 — counsel-validated
     *  transaction templates are a core discipline rule. */
    validatedByCounsel: boolean('validated_by_counsel').notNull().default(false),
    validatedAt: timestamp('validated_at', { withTimezone: true }),
    validatedByFirm: text('validated_by_firm'),
    validationNotes: text('validation_notes'),

    // ─── Lifecycle ──────────────────────────────────────────────

    /** 'active' | 'draft' | 'deprecated' | 'archived'. */
    status: text('status').notNull().default('draft'),
    notes: text('notes'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    categoryIdx: index('deal_structure_templates_category_idx').on(t.category),
    entityIdx: index('deal_structure_templates_entity_idx').on(t.vtcEntity),
    statusIdx: index('deal_structure_templates_status_idx').on(t.status),
  }),
);

export type DealStructureTemplate = typeof dealStructureTemplates.$inferSelect;
export type NewDealStructureTemplate = typeof dealStructureTemplates.$inferInsert;
