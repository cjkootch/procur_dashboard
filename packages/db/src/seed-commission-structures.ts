/**
 * Hand-curated seed for `commission_structures` — VTC's standard
 * broker / origination partner / sub-broker fee arrangements. Spec:
 * docs/deal-structures-catalog-brief.md §7.
 *
 * Each entry captures a STANDARD arrangement from which specific
 * partner agreements may deviate. Bespoke deals reference an
 * existing structure or create a new entry if the terms are novel.
 *
 * Idempotent on slug. Re-runs upsert in place.
 *
 * Run from repo root:
 *   pnpm --filter @procur/db seed-commission-structures
 */
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { sql } from 'drizzle-orm';
import { db } from './client';

loadEnv({ path: '../../.env.local' });
loadEnv({ path: '../../.env' });

type CommissionSeed = {
  slug: string;
  name: string;
  category:
    | 'origination-partner'
    | 'intermediary-broker'
    | 'sub-broker'
    | 'finder-fee'
    | 'introducer'
    | 'consultant'
    | 'sole-and-exclusive-broker';
  partyRelationship:
    | 'vtc-pays-third-party'
    | 'vtc-receives-from-third-party'
    | 'split-with-third-party';
  vtcEntity: string;
  basisType: string;
  feeStructure: Record<string, unknown>;
  triggerEvent: string;
  paymentTiming: string;
  appliesToCategories?: string[];
  appliesToTemplateSlugs?: string[];
  exclusivePerDeal?: boolean;
  soleAndExclusive?: boolean;
  termMonths?: number | null;
  autoRenewal?: boolean;
  terminationNoticeDays?: number | null;
  standardAgreementClause?: string | null;
  taxTreatmentNotes?: string | null;
  status?: 'active' | 'draft' | 'deprecated' | 'archived';
  notes: string;
};

const COMMISSIONS: CommissionSeed[] = [
  {
    slug: 'origination-partner-50-50-net-profit',
    name: 'Origination Partner — 50/50 Net Profit Split',
    category: 'origination-partner',
    partyRelationship: 'split-with-third-party',
    vtcEntity: 'vtc-llc',
    basisType: 'pct-of-net-margin',
    feeStructure: { partyShare: 0.5 },
    triggerEvent: 'pari-passu-with-margin',
    paymentTiming: 'pari-passu-with-margin',
    appliesToCategories: [],
    appliesToTemplateSlugs: [],
    exclusivePerDeal: true,
    soleAndExclusive: false,
    termMonths: 24,
    autoRenewal: true,
    terminationNoticeDays: 90,
    notes:
      'Kenny Chavez / Kenge structure pattern. Equal split of net margin (revenue net of all direct costs including freight, insurance, financing fees). Pari-passu payment so partner is paid as VTC is paid. Term + auto-renew so the relationship is stable but reviewable.',
  },
  {
    slug: 'origination-partner-60-40-net-profit-vtc-favored',
    name: 'Origination Partner — 60/40 Net Profit (VTC Favored)',
    category: 'origination-partner',
    partyRelationship: 'split-with-third-party',
    vtcEntity: 'vtc-llc',
    basisType: 'pct-of-net-margin',
    feeStructure: { partyShare: 0.4 },
    triggerEvent: 'pari-passu-with-margin',
    paymentTiming: 'pari-passu-with-margin',
    appliesToCategories: [],
    appliesToTemplateSlugs: [],
    exclusivePerDeal: true,
    soleAndExclusive: false,
    termMonths: 24,
    autoRenewal: true,
    terminationNoticeDays: 90,
    notes:
      'Variant where VTC takes the larger share to compensate for capital deployment. Use when partner brings origination but VTC is materially financing the deal cycle (LC issuance, freight prepay, etc.). Partner share is 40% of net margin.',
  },
  {
    slug: 'intermediary-broker-half-pct-revenue',
    name: 'Intermediary Broker — 0.5% of Gross Revenue',
    category: 'intermediary-broker',
    partyRelationship: 'vtc-pays-third-party',
    vtcEntity: 'vtc-llc',
    basisType: 'pct-of-gross-revenue',
    feeStructure: { partyShare: 0.005 },
    triggerEvent: 'on-payment-received',
    paymentTiming: 'within-14-days',
    appliesToCategories: [],
    appliesToTemplateSlugs: [],
    exclusivePerDeal: false,
    soleAndExclusive: false,
    termMonths: null,
    autoRenewal: false,
    terminationNoticeDays: 30,
    notes:
      'Standard intermediary broker on closed cargo. Half of one percent of GROSS revenue (not net margin) — broker gets paid before VTC realizes margin, so structure incentivizes broker volume rather than deal selectivity.',
  },
  {
    slug: 'intermediary-broker-quarter-pct-revenue',
    name: 'Intermediary Broker — 0.25% of Gross Revenue (High Volume)',
    category: 'intermediary-broker',
    partyRelationship: 'vtc-pays-third-party',
    vtcEntity: 'vtc-llc',
    basisType: 'pct-of-gross-revenue',
    feeStructure: { partyShare: 0.0025 },
    triggerEvent: 'on-payment-received',
    paymentTiming: 'within-14-days',
    appliesToCategories: [],
    appliesToTemplateSlugs: [],
    exclusivePerDeal: false,
    soleAndExclusive: false,
    termMonths: null,
    autoRenewal: false,
    terminationNoticeDays: 30,
    notes:
      'Reduced rate for high-volume relationships — quarter of one percent of GROSS revenue. Use when cumulative annual volume with the intermediary justifies the discount. Track per-broker volume to validate the rate annually.',
  },
  {
    slug: 'specialty-crude-broker-bbl-fee',
    name: 'Specialty Crude Broker — Per-bbl Fee',
    category: 'sub-broker',
    partyRelationship: 'vtc-pays-third-party',
    vtcEntity: 'vector-antilles',
    basisType: 'usd-per-unit',
    feeStructure: { amountUsd: 0.25, unit: 'bbl' },
    triggerEvent: 'on-each-lifting',
    paymentTiming: 'within-30-days',
    appliesToCategories: ['specialty-crude'],
    appliesToTemplateSlugs: [],
    exclusivePerDeal: false,
    soleAndExclusive: false,
    termMonths: 12,
    autoRenewal: false,
    terminationNoticeDays: 60,
    notes:
      '$0.10–$0.50/bbl on closed specialty crude cargoes — $0.25/bbl is the typical mid. Per-lifting trigger means broker is paid on each cargo lifted, not on contract signature. Use for specialty crude origination through Vector Antilles.',
  },
  {
    slug: 'caribbean-fuel-flat-per-cargo',
    name: 'Caribbean Refined Cargo — Flat Fee per Cargo',
    category: 'sub-broker',
    partyRelationship: 'vtc-pays-third-party',
    vtcEntity: 'vtc-llc',
    basisType: 'flat-fee-per-deal',
    feeStructure: { amountUsd: 25000 },
    triggerEvent: 'on-first-lifting',
    paymentTiming: 'within-30-days',
    appliesToCategories: ['refined-product'],
    appliesToTemplateSlugs: [
      'caribbean-refined-cif-lc-sight',
      'caribbean-refined-cif-lc-deferred-30',
      'caribbean-refined-cif-cad',
      'caribbean-refined-fob-tt-prepayment',
    ],
    exclusivePerDeal: false,
    soleAndExclusive: false,
    termMonths: 12,
    autoRenewal: false,
    terminationNoticeDays: 30,
    notes:
      "$10K–$50K per Caribbean refined cargo — $25K is the typical. Flat fee simplifies broker accounting on small-cargo flows where pct calculations are noise. Trigger on first lifting (not contract signature) so broker has skin in completion.",
  },
  {
    slug: 'vehicle-introducer-flat-1k',
    name: 'Vehicle Introducer — Flat $1K per Buyer',
    category: 'introducer',
    partyRelationship: 'vtc-pays-third-party',
    vtcEntity: 'vector-auto-exports',
    basisType: 'flat-fee-per-deal',
    feeStructure: { amountUsd: 1000 },
    triggerEvent: 'on-first-lifting',
    paymentTiming: 'within-7-days',
    appliesToCategories: ['vehicle'],
    appliesToTemplateSlugs: [],
    exclusivePerDeal: false,
    soleAndExclusive: false,
    termMonths: 12,
    autoRenewal: false,
    terminationNoticeDays: 14,
    notes:
      'Flat $1,000 per introduced vehicle buyer (paid once, on first cargo of the buyer relationship). Lightweight structure suitable for casual introducers without an ongoing relationship.',
  },
  {
    slug: 'food-commodity-success-fee-pct-margin',
    name: 'Food Commodity Finder — Success Fee on First Deal',
    category: 'finder-fee',
    partyRelationship: 'vtc-pays-third-party',
    vtcEntity: 'vector-food-fund',
    basisType: 'success-fee-only',
    feeStructure: {
      triggerCondition: 'first-closed-cargo-with-buyer',
      partyShare: 0.1,
    },
    triggerEvent: 'on-deal-completion',
    paymentTiming: 'within-30-days',
    appliesToCategories: ['food-commodity'],
    appliesToTemplateSlugs: [],
    exclusivePerDeal: true,
    soleAndExclusive: false,
    termMonths: null,
    autoRenewal: false,
    terminationNoticeDays: null,
    notes:
      'Success fee on first deal only with new food buyer — 10% of net margin. One-time payment; relationship is not ongoing. Useful when finder is providing introduction without becoming a recurring intermediary.',
  },
  {
    slug: 'consultant-monthly-retainer-plus-bonus',
    name: 'Consultant — Monthly Retainer + Per-Deal Bonus',
    category: 'consultant',
    partyRelationship: 'vtc-pays-third-party',
    vtcEntity: 'vtc-llc',
    basisType: 'tiered-by-margin',
    feeStructure: {
      tiers: [
        { minMarginPct: 0, maxMarginPct: 1.5, partyShare: 0.0 },
        { minMarginPct: 1.5, maxMarginPct: 3.0, partyShare: 0.05 },
        { minMarginPct: 3.0, maxMarginPct: null, partyShare: 0.1 },
      ],
    },
    triggerEvent: 'on-payment-received',
    paymentTiming: 'within-30-days',
    appliesToCategories: [],
    appliesToTemplateSlugs: [],
    exclusivePerDeal: false,
    soleAndExclusive: false,
    termMonths: 12,
    autoRenewal: true,
    terminationNoticeDays: 30,
    notes:
      "Monthly retainer (specified in standard agreement clause) + per-deal bonus tied to margin tiers. Bonus only kicks in above 1.5% margin (the floor for a 'good deal' on Caribbean refined). Aligns consultant with margin quality, not just volume. Retainer amount is bespoke per consultant; the tier structure is the standard.",
  },
];

async function main() {
  console.log(`Seeding ${COMMISSIONS.length} commission structures…`);
  let upserted = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const c of COMMISSIONS) {
    try {
      await db.execute(sql`
        INSERT INTO commission_structures (
          slug, name, category, party_relationship, vtc_entity,
          basis_type, fee_structure,
          trigger_event, payment_timing,
          applies_to_categories, applies_to_template_slugs,
          exclusive_per_deal, sole_and_exclusive,
          term_months, auto_renewal, termination_notice_days,
          standard_agreement_clause, tax_treatment_notes,
          status, notes
        ) VALUES (
          ${c.slug},
          ${c.name},
          ${c.category},
          ${c.partyRelationship},
          ${c.vtcEntity},
          ${c.basisType},
          ${JSON.stringify(c.feeStructure)}::jsonb,
          ${c.triggerEvent},
          ${c.paymentTiming},
          ARRAY[${
            (c.appliesToCategories ?? []).length > 0
              ? sql.join(
                  (c.appliesToCategories ?? []).map((x) => sql`${x}`),
                  sql`, `,
                )
              : sql``
          }]::text[],
          ARRAY[${
            (c.appliesToTemplateSlugs ?? []).length > 0
              ? sql.join(
                  (c.appliesToTemplateSlugs ?? []).map((x) => sql`${x}`),
                  sql`, `,
                )
              : sql``
          }]::text[],
          ${c.exclusivePerDeal ?? false},
          ${c.soleAndExclusive ?? false},
          ${c.termMonths ?? null},
          ${c.autoRenewal ?? false},
          ${c.terminationNoticeDays ?? null},
          ${c.standardAgreementClause ?? null},
          ${c.taxTreatmentNotes ?? null},
          ${c.status ?? 'active'},
          ${c.notes}
        )
        ON CONFLICT (slug) DO UPDATE SET
          name                       = EXCLUDED.name,
          category                   = EXCLUDED.category,
          party_relationship         = EXCLUDED.party_relationship,
          vtc_entity                 = EXCLUDED.vtc_entity,
          basis_type                 = EXCLUDED.basis_type,
          fee_structure              = EXCLUDED.fee_structure,
          trigger_event              = EXCLUDED.trigger_event,
          payment_timing             = EXCLUDED.payment_timing,
          applies_to_categories      = EXCLUDED.applies_to_categories,
          applies_to_template_slugs  = EXCLUDED.applies_to_template_slugs,
          exclusive_per_deal         = EXCLUDED.exclusive_per_deal,
          sole_and_exclusive         = EXCLUDED.sole_and_exclusive,
          term_months                = EXCLUDED.term_months,
          auto_renewal               = EXCLUDED.auto_renewal,
          termination_notice_days    = EXCLUDED.termination_notice_days,
          standard_agreement_clause  = EXCLUDED.standard_agreement_clause,
          tax_treatment_notes        = EXCLUDED.tax_treatment_notes,
          status                     = EXCLUDED.status,
          notes                      = EXCLUDED.notes,
          updated_at                 = NOW();
      `);
      upserted += 1;
    } catch (err) {
      errors.push(`${c.slug}: ${(err as Error).message}`);
      skipped += 1;
    }
  }

  console.log(`Upserted: ${upserted}, skipped: ${skipped}`);
  if (errors.length > 0) {
    console.error('Errors:');
    for (const e of errors) console.error('  ' + e);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
