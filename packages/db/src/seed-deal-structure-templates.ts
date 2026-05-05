/**
 * Hand-curated seed for `deal_structure_templates` — VTC's standard
 * deal-shaping playbook. Spec: docs/deal-structures-catalog-brief.md
 * §6 (the seed list).
 *
 * Templates capture the canonical *shape* a proposal instantiates:
 * Incoterm × payment instrument × region × VTC entity. Per-deal
 * specifics override individual fields at proposal time; templates
 * stay stable.
 *
 * Volumes are indicative — a CIF/LC-sight Caribbean diesel cargo
 * is typically ~1.5-2.0 % gross margin; a specialty crude SBLC
 * structure is typically $0.30-$0.80/bbl. These ranges are
 * VTC's working assumptions, not committed terms.
 *
 * `validatedByCounsel` defaults to false — operator should flip
 * the flag manually after counsel review per
 * origination-partners-brief §4.
 *
 * Idempotent on slug. Re-runs upsert in place.
 *
 * Run from repo root:
 *   pnpm --filter @procur/db seed-deal-structure-templates
 */
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { sql } from 'drizzle-orm';
import { db } from './client';

loadEnv({ path: '../../.env.local' });
loadEnv({ path: '../../.env' });

type TemplateSeed = {
  slug: string;
  name: string;
  category:
    | 'refined-product'
    | 'specialty-crude'
    | 'crude-conventional'
    | 'food-commodity'
    | 'vehicle'
    | 'lng'
    | 'lpg';
  vtcEntity:
    | 'vtc-llc'
    | 'vector-antilles'
    | 'vector-auto-exports'
    | 'vector-food-fund'
    | 'stabroek-advisory';
  applicableRegions: string[];
  incoterm:
    | 'EXW'
    | 'FCA'
    | 'FAS'
    | 'FOB'
    | 'CFR'
    | 'CIF'
    | 'CIP'
    | 'DAP'
    | 'DPU'
    | 'DDP'
    | 'DES';
  riskTransferPoint: string;
  paymentInstrument: string;
  paymentCurrency: string;
  lcConfirmationRequired?: boolean;
  cargoInsurance?: string | null;
  insuranceCoveragePct?: number | null;
  inspectionRequirement?: string | null;
  qualityStandard?: string | null;
  standardDocuments: string[];
  typicalCycleTimeDaysMin?: number | null;
  typicalCycleTimeDaysMax?: number | null;
  laycanWindow?: string | null;
  marginStructure?: string | null;
  typicalMarginMin?: number | null;
  typicalMarginMax?: number | null;
  marginUnit?: string | null;
  ofacScreeningRequired?: boolean;
  excludedJurisdictions?: string[];
  excludedCounterpartyTypes?: string[];
  generalLicenseEligible?: string[];
  status?: 'active' | 'draft' | 'deprecated' | 'archived';
  notes: string;
};

const TEMPLATES: TemplateSeed[] = [
  // ─── 6.1 Refined product (VTC LLC) ─────────────────────────────
  {
    slug: 'caribbean-refined-cif-lc-sight',
    name: 'Caribbean Refined Product — CIF / LC Sight',
    category: 'refined-product',
    vtcEntity: 'vtc-llc',
    applicableRegions: ['caribbean'],
    incoterm: 'CIF',
    riskTransferPoint: "Ship's flange at the loadport — risk + title transfer when product crosses the loading manifold; freight + insurance arranged by VTC to discharge port.",
    paymentInstrument: 'lc-sight',
    paymentCurrency: 'USD',
    cargoInsurance: 'institute-cargo-clauses-a',
    insuranceCoveragePct: 110,
    inspectionRequirement: 'sgs-loadport',
    qualityStandard: 'ASTM D975 / D4814 (per product)',
    standardDocuments: [
      'commercial-invoice',
      'bill-of-lading-3-of-3-originals',
      'sgs-quality-certificate',
      'sgs-quantity-certificate',
      'certificate-of-origin',
      'insurance-policy',
      'cargo-manifest',
      'beneficiary-certificate',
    ],
    typicalCycleTimeDaysMin: 21,
    typicalCycleTimeDaysMax: 35,
    laycanWindow: 'standard-5-day',
    marginStructure: 'fixed-spread-per-unit',
    typicalMarginMin: 1.5,
    typicalMarginMax: 3.0,
    marginUnit: 'pct',
    excludedJurisdictions: ['IR', 'KP', 'CU', 'SY'],
    excludedCounterpartyTypes: ['sanctioned-state-owned', 'designated-individual'],
    notes:
      "Standard Caribbean diesel/gasoline cargo. Default for Tier 2-3 buyers without LC-deferred relationships. Margin is gross (pre-freight residual, pre-fees). Confirm SGS appointment + Q&Q tolerances at loadport BEFORE laycan opens.",
  },
  {
    slug: 'caribbean-refined-cif-lc-deferred-30',
    name: 'Caribbean Refined Product — CIF / LC Deferred 30',
    category: 'refined-product',
    vtcEntity: 'vtc-llc',
    applicableRegions: ['caribbean'],
    incoterm: 'CIF',
    riskTransferPoint: "Ship's flange at the loadport.",
    paymentInstrument: 'lc-deferred-30',
    paymentCurrency: 'USD',
    cargoInsurance: 'institute-cargo-clauses-a',
    insuranceCoveragePct: 110,
    inspectionRequirement: 'sgs-loadport',
    qualityStandard: 'ASTM D975 / D4814 (per product)',
    standardDocuments: [
      'commercial-invoice',
      'bill-of-lading-3-of-3-originals',
      'sgs-quality-certificate',
      'sgs-quantity-certificate',
      'certificate-of-origin',
      'insurance-policy',
      'cargo-manifest',
      'beneficiary-certificate',
    ],
    typicalCycleTimeDaysMin: 21,
    typicalCycleTimeDaysMax: 35,
    laycanWindow: 'standard-5-day',
    marginStructure: 'fixed-spread-per-unit',
    typicalMarginMin: 1.8,
    typicalMarginMax: 3.5,
    marginUnit: 'pct',
    excludedJurisdictions: ['IR', 'KP', 'CU', 'SY'],
    excludedCounterpartyTypes: ['sanctioned-state-owned', 'designated-individual'],
    notes:
      'Tier 1 Caribbean refiners (REFIDOMSA, JPS, etc.) with established payment relief. 30-day deferral compresses VTC working capital cycle vs sight; price up by 0.3-0.5pct vs sight to compensate.',
  },
  {
    slug: 'caribbean-refined-cif-cad',
    name: 'Caribbean Refined Product — CIF / CAD',
    category: 'refined-product',
    vtcEntity: 'vtc-llc',
    applicableRegions: ['caribbean'],
    incoterm: 'CIF',
    riskTransferPoint: "Ship's flange at the loadport.",
    paymentInstrument: 'cad',
    paymentCurrency: 'USD',
    cargoInsurance: 'institute-cargo-clauses-a',
    insuranceCoveragePct: 110,
    inspectionRequirement: 'sgs-loadport',
    qualityStandard: 'ASTM D975 / D4814 (per product)',
    standardDocuments: [
      'commercial-invoice',
      'bill-of-lading-3-of-3-originals',
      'sgs-quality-certificate',
      'sgs-quantity-certificate',
      'certificate-of-origin',
      'insurance-policy',
    ],
    typicalCycleTimeDaysMin: 18,
    typicalCycleTimeDaysMax: 30,
    laycanWindow: 'standard-5-day',
    marginStructure: 'fixed-spread-per-unit',
    typicalMarginMin: 2.0,
    typicalMarginMax: 4.0,
    marginUnit: 'pct',
    excludedJurisdictions: ['IR', 'KP', 'CU', 'SY'],
    excludedCounterpartyTypes: ['sanctioned-state-owned', 'designated-individual'],
    notes:
      'Smaller Caribbean distributors without LC infrastructure. Higher margin compensates for elevated counterparty risk vs LC-backed structures. Document control + escrow agent often added for first-cargo CAD relationships.',
  },
  {
    slug: 'caribbean-refined-fob-tt-prepayment',
    name: 'Caribbean Refined Product — FOB / TT Prepayment',
    category: 'refined-product',
    vtcEntity: 'vtc-llc',
    applicableRegions: ['caribbean'],
    incoterm: 'FOB',
    riskTransferPoint: "Ship's flange at loadport — risk transfers when product crosses loading manifold; buyer arranges freight + insurance from there.",
    paymentInstrument: 'tt-prepayment',
    paymentCurrency: 'USD',
    cargoInsurance: 'buyer-arranged',
    inspectionRequirement: 'sgs-loadport',
    qualityStandard: 'ASTM D975 / D4814 (per product)',
    standardDocuments: [
      'commercial-invoice',
      'bill-of-lading-3-of-3-originals',
      'sgs-quality-certificate',
      'sgs-quantity-certificate',
      'certificate-of-origin',
      'mate-receipt',
    ],
    typicalCycleTimeDaysMin: 14,
    typicalCycleTimeDaysMax: 25,
    laycanWindow: 'narrow-3-day',
    marginStructure: 'fixed-spread-per-unit',
    typicalMarginMin: 1.0,
    typicalMarginMax: 2.5,
    marginUnit: 'pct',
    excludedJurisdictions: ['IR', 'KP', 'CU', 'SY'],
    excludedCounterpartyTypes: ['sanctioned-state-owned', 'designated-individual'],
    notes:
      'Buyer-arranged freight, typical for distributor self-lift. TT prepayment trades buyer financing risk for tighter margin — typically 50-100bps below LC structures. Loadport demurrage exposure is buyer side.',
  },
  {
    slug: 'latam-refined-cfr-lc-sight',
    name: 'LatAm Mainland Refined Product — CFR / LC Sight',
    category: 'refined-product',
    vtcEntity: 'vtc-llc',
    applicableRegions: ['latam-mainland'],
    incoterm: 'CFR',
    riskTransferPoint: "Ship's flange at the loadport — risk transfers at loadport; seller pays freight to CFR-named discharge port; buyer arranges insurance.",
    paymentInstrument: 'lc-sight',
    paymentCurrency: 'USD',
    cargoInsurance: 'buyer-arranged',
    inspectionRequirement: 'sgs-loadport',
    qualityStandard: 'ASTM D975 / D4814 (per product)',
    standardDocuments: [
      'commercial-invoice',
      'bill-of-lading-3-of-3-originals',
      'sgs-quality-certificate',
      'sgs-quantity-certificate',
      'certificate-of-origin',
      'cargo-manifest',
    ],
    typicalCycleTimeDaysMin: 21,
    typicalCycleTimeDaysMax: 35,
    laycanWindow: 'standard-5-day',
    marginStructure: 'fixed-spread-per-unit',
    typicalMarginMin: 1.5,
    typicalMarginMax: 3.0,
    marginUnit: 'pct',
    excludedJurisdictions: ['IR', 'KP', 'CU', 'SY', 'VE'],
    excludedCounterpartyTypes: ['sanctioned-state-owned', 'designated-individual'],
    notes:
      'Colombia, Ecuador, Peru refined product. CFR vs CIF when buyer prefers self-arranged insurance (often the case for Tier 1 LatAm distributors with internal insurance programs).',
  },
  {
    slug: 'west-africa-refined-cif-lc-confirmed',
    name: 'West Africa Refined Product — CIF / LC Deferred 30 (Confirmed)',
    category: 'refined-product',
    vtcEntity: 'vtc-llc',
    applicableRegions: ['west-africa'],
    incoterm: 'CIF',
    riskTransferPoint: "Ship's flange at the loadport.",
    paymentInstrument: 'lc-deferred-30',
    paymentCurrency: 'USD',
    lcConfirmationRequired: true,
    cargoInsurance: 'institute-cargo-clauses-a',
    insuranceCoveragePct: 110,
    inspectionRequirement: 'sgs-both',
    qualityStandard: 'ASTM D975 / D4814 + AGOI / DPK specs (per product)',
    standardDocuments: [
      'commercial-invoice',
      'bill-of-lading-3-of-3-originals',
      'sgs-quality-certificate',
      'sgs-quantity-certificate',
      'certificate-of-origin',
      'insurance-policy',
      'cargo-manifest',
      'beneficiary-certificate',
    ],
    typicalCycleTimeDaysMin: 25,
    typicalCycleTimeDaysMax: 45,
    laycanWindow: 'wide-7-day',
    marginStructure: 'fixed-spread-per-unit',
    typicalMarginMin: 2.5,
    typicalMarginMax: 5.0,
    marginUnit: 'pct',
    excludedJurisdictions: ['IR', 'KP', 'CU', 'SY'],
    excludedCounterpartyTypes: ['sanctioned-state-owned', 'designated-individual'],
    notes:
      'Confirmed LC standard for West African refined product — local LC must be confirmed by Tier 1 EU/US bank. Wider laycan + both-end SGS to manage discharge-port disputes. Margin range higher than Caribbean to reflect demurrage / payment-friction reality.',
  },
  {
    slug: 'us-gulf-refined-fob-pipeline',
    name: 'US Gulf Coast Refined Product — FOB Pipeline / TT Against Docs',
    category: 'refined-product',
    vtcEntity: 'vtc-llc',
    applicableRegions: ['us-gulf-coast', 'us-domestic'],
    incoterm: 'FOB',
    riskTransferPoint: 'Pipeline custody transfer — risk passes when product enters buyer-nominated pipeline at the named US Gulf terminal (Colonial / Plantation / Explorer / etc.).',
    paymentInstrument: 'tt-against-docs',
    paymentCurrency: 'USD',
    cargoInsurance: 'buyer-arranged',
    inspectionRequirement: 'cargo-inspection-by-buyer',
    qualityStandard: 'ASTM D975 / D4814 + Colonial spec',
    standardDocuments: [
      'commercial-invoice',
      'pipeline-ticket',
      'sgs-quality-certificate',
      'mate-receipt',
    ],
    typicalCycleTimeDaysMin: 7,
    typicalCycleTimeDaysMax: 14,
    laycanWindow: 'narrow-3-day',
    marginStructure: 'fixed-spread-per-unit',
    typicalMarginMin: 0.5,
    typicalMarginMax: 1.5,
    marginUnit: 'pct',
    excludedJurisdictions: ['IR', 'KP', 'CU', 'SY'],
    excludedCounterpartyTypes: ['sanctioned-state-owned'],
    notes:
      "US Gulf Coast pipeline-FOB, USD domestic. Tighter margin reflects domestic-US execution risk profile. Pipeline-ticket is the BoL equivalent. 'pipeline-ticket' isn't in the canonical document taxonomy yet — replace once added.",
  },

  // ─── 6.2 Specialty crude (Vector Antilles) ─────────────────────
  {
    slug: 'specialty-crude-fob-origin-sblc',
    name: 'Specialty Crude — FOB Origin / SBLC-Backed',
    category: 'specialty-crude',
    vtcEntity: 'vector-antilles',
    applicableRegions: ['mediterranean', 'middle-east-gulf', 'west-africa'],
    incoterm: 'FOB',
    riskTransferPoint: "Ship's flange at the loadport (origin terminal). Buyer arranges and pays freight to discharge.",
    paymentInstrument: 'sblc-backed',
    paymentCurrency: 'USD',
    cargoInsurance: 'buyer-arranged',
    inspectionRequirement: 'sgs-loadport',
    qualityStandard: 'Per crude assay — origin-specific (Es Sider, Bonny Light, Arab Light, etc.)',
    standardDocuments: [
      'commercial-invoice',
      'bill-of-lading-3-of-3-originals',
      'sgs-quality-certificate',
      'sgs-quantity-certificate',
      'certificate-of-origin',
      'mate-receipt',
      'cargo-manifest',
    ],
    typicalCycleTimeDaysMin: 30,
    typicalCycleTimeDaysMax: 60,
    laycanWindow: 'wide-7-day',
    marginStructure: 'fixed-spread-per-unit',
    typicalMarginMin: 0.3,
    typicalMarginMax: 0.8,
    marginUnit: 'usd-per-bbl',
    excludedJurisdictions: ['KP', 'SY'],
    excludedCounterpartyTypes: ['sanctioned-state-owned', 'designated-individual'],
    generalLicenseEligible: ['VEN-GL-48', 'RUS-GL-8-ENERGY'],
    notes:
      'Origin-loading specialty crude with SBLC performance guarantee. Vector Antilles structure for non-conventional crude flows where the SBLC backs payment obligation while underlying mechanics may be open-account. Counsel-validation required per origin × destination pair.',
  },
  {
    slug: 'specialty-crude-cif-destination-lc-deferred',
    name: 'Specialty Crude — CIF Destination / LC Deferred 60',
    category: 'specialty-crude',
    vtcEntity: 'vector-antilles',
    applicableRegions: ['south-asia', 'east-asia', 'mediterranean'],
    incoterm: 'CIF',
    riskTransferPoint: "Ship's flange at the loadport. Seller pays freight + insurance to CIF-named discharge port.",
    paymentInstrument: 'lc-deferred-60',
    paymentCurrency: 'USD',
    cargoInsurance: 'institute-cargo-clauses-a',
    insuranceCoveragePct: 110,
    inspectionRequirement: 'sgs-both',
    qualityStandard: 'Per crude assay — origin-specific',
    standardDocuments: [
      'commercial-invoice',
      'bill-of-lading-3-of-3-originals',
      'sgs-quality-certificate',
      'sgs-quantity-certificate',
      'certificate-of-origin',
      'insurance-policy',
      'cargo-manifest',
      'beneficiary-certificate',
    ],
    typicalCycleTimeDaysMin: 35,
    typicalCycleTimeDaysMax: 70,
    laycanWindow: 'wide-7-day',
    marginStructure: 'fixed-spread-per-unit',
    typicalMarginMin: 0.5,
    typicalMarginMax: 1.5,
    marginUnit: 'usd-per-bbl',
    excludedJurisdictions: ['KP', 'SY'],
    excludedCounterpartyTypes: ['sanctioned-state-owned', 'designated-individual'],
    generalLicenseEligible: ['VEN-GL-48', 'RUS-GL-8-ENERGY'],
    notes:
      'Delivered specialty crude to refining destinations. Higher margin than FOB to compensate for freight + insurance risk. Counsel-validation required per origin × destination.',
  },
  {
    slug: 'specialty-crude-des-direct-discharge',
    name: 'Specialty Crude — DES / LC Deferred 30 (Direct Ex-Ship)',
    category: 'specialty-crude',
    vtcEntity: 'vector-antilles',
    applicableRegions: ['mediterranean', 'west-africa'],
    incoterm: 'DES',
    riskTransferPoint: 'Ex-ship at the discharge port — title + risk transfer when product is made available to buyer at the discharge-port manifold (technically deprecated in Incoterms 2020 but customary in crude trade).',
    paymentInstrument: 'lc-deferred-30',
    paymentCurrency: 'USD',
    cargoInsurance: 'institute-cargo-clauses-a',
    insuranceCoveragePct: 110,
    inspectionRequirement: 'sgs-discharge',
    qualityStandard: 'Per crude assay — origin-specific',
    standardDocuments: [
      'commercial-invoice',
      'bill-of-lading-3-of-3-originals',
      'sgs-quality-certificate',
      'sgs-quantity-certificate',
      'certificate-of-origin',
      'insurance-policy',
      'cargo-manifest',
    ],
    typicalCycleTimeDaysMin: 30,
    typicalCycleTimeDaysMax: 50,
    laycanWindow: 'standard-5-day',
    marginStructure: 'fixed-spread-per-unit',
    typicalMarginMin: 0.7,
    typicalMarginMax: 2.0,
    marginUnit: 'usd-per-bbl',
    excludedJurisdictions: ['KP', 'SY'],
    excludedCounterpartyTypes: ['sanctioned-state-owned', 'designated-individual'],
    notes:
      'Direct ex-ship discharge — common for crude historically when buyer wants delivery confirmed at their discharge terminal. DES is technically deprecated but still used. Counsel-validation required.',
  },
  {
    slug: 'wa-crude-fob-cape-lopez',
    name: 'West African Crude — FOB Cape Lopez / LC Deferred 30',
    category: 'specialty-crude',
    vtcEntity: 'vector-antilles',
    applicableRegions: ['west-africa'],
    incoterm: 'FOB',
    riskTransferPoint: 'Cape Lopez SBM (Single Buoy Mooring) — risk transfers at loading manifold, FOB Cape Lopez convention.',
    paymentInstrument: 'lc-deferred-30',
    paymentCurrency: 'USD',
    cargoInsurance: 'buyer-arranged',
    inspectionRequirement: 'sgs-loadport',
    qualityStandard: 'Gabonese Mandji / Equatorial Guinean crude assay (origin-specific)',
    standardDocuments: [
      'commercial-invoice',
      'bill-of-lading-3-of-3-originals',
      'sgs-quality-certificate',
      'sgs-quantity-certificate',
      'certificate-of-origin',
      'mate-receipt',
      'cargo-manifest',
    ],
    typicalCycleTimeDaysMin: 28,
    typicalCycleTimeDaysMax: 50,
    laycanWindow: 'wide-7-day',
    marginStructure: 'fixed-spread-per-unit',
    typicalMarginMin: 0.3,
    typicalMarginMax: 0.7,
    marginUnit: 'usd-per-bbl',
    excludedJurisdictions: ['KP', 'SY'],
    excludedCounterpartyTypes: ['sanctioned-state-owned', 'designated-individual'],
    notes:
      'West African sweet crude FOB, Gabonese / Equatorial Guinean origin. Cape Lopez is the canonical FOB point for Mandji + EG light sweet grades.',
  },
  {
    slug: 'eastern-mediterranean-crude-cif-cypriot-discharge',
    name: 'Eastern Mediterranean Crude — CIF / LC Deferred 60',
    category: 'specialty-crude',
    vtcEntity: 'vector-antilles',
    applicableRegions: ['mediterranean'],
    incoterm: 'CIF',
    riskTransferPoint: "Ship's flange at the loadport.",
    paymentInstrument: 'lc-deferred-60',
    paymentCurrency: 'USD',
    cargoInsurance: 'institute-cargo-clauses-a',
    insuranceCoveragePct: 110,
    inspectionRequirement: 'sgs-both',
    qualityStandard: 'Eastern Mediterranean origin assay — Kirkuk Blend, Azeri-BTC, Suez Blend (origin-specific)',
    standardDocuments: [
      'commercial-invoice',
      'bill-of-lading-3-of-3-originals',
      'sgs-quality-certificate',
      'sgs-quantity-certificate',
      'certificate-of-origin',
      'insurance-policy',
      'cargo-manifest',
      'beneficiary-certificate',
    ],
    typicalCycleTimeDaysMin: 25,
    typicalCycleTimeDaysMax: 45,
    laycanWindow: 'standard-5-day',
    marginStructure: 'fixed-spread-per-unit',
    typicalMarginMin: 0.4,
    typicalMarginMax: 1.0,
    marginUnit: 'usd-per-bbl',
    excludedJurisdictions: ['KP', 'SY'],
    excludedCounterpartyTypes: ['sanctioned-state-owned', 'designated-individual'],
    notes:
      'Eastern Mediterranean specialty crude into Cypriot or Turkish refining. War risks insurance overlay typically required given route exposure.',
  },

  // ─── 6.3 Crude conventional ────────────────────────────────────
  {
    slug: 'conventional-crude-fob-loadport',
    name: 'Conventional Crude — FOB Loadport / LC Sight',
    category: 'crude-conventional',
    vtcEntity: 'vtc-llc',
    applicableRegions: ['global'],
    incoterm: 'FOB',
    riskTransferPoint: "Ship's flange at the loadport (origin terminal). Buyer arranges freight to discharge.",
    paymentInstrument: 'lc-sight',
    paymentCurrency: 'USD',
    cargoInsurance: 'buyer-arranged',
    inspectionRequirement: 'sgs-loadport',
    qualityStandard: 'Per crude grade assay',
    standardDocuments: [
      'commercial-invoice',
      'bill-of-lading-3-of-3-originals',
      'sgs-quality-certificate',
      'sgs-quantity-certificate',
      'certificate-of-origin',
      'mate-receipt',
      'cargo-manifest',
    ],
    typicalCycleTimeDaysMin: 25,
    typicalCycleTimeDaysMax: 45,
    laycanWindow: 'standard-5-day',
    marginStructure: 'fixed-spread-per-unit',
    typicalMarginMin: 0.2,
    typicalMarginMax: 0.6,
    marginUnit: 'usd-per-bbl',
    excludedJurisdictions: ['IR', 'KP', 'CU', 'SY'],
    excludedCounterpartyTypes: ['sanctioned-state-owned', 'designated-individual'],
    notes:
      'Standard FOB crude, buyer-arranged freight. Default conventional-crude shape when buyer has integrated freight desk.',
  },
  {
    slug: 'conventional-crude-cif-tier-1-buyer',
    name: 'Conventional Crude — CIF / LC Sight (Tier 1 Buyer)',
    category: 'crude-conventional',
    vtcEntity: 'vtc-llc',
    applicableRegions: ['global'],
    incoterm: 'CIF',
    riskTransferPoint: "Ship's flange at the loadport. Seller pays freight + insurance to discharge port.",
    paymentInstrument: 'lc-sight',
    paymentCurrency: 'USD',
    cargoInsurance: 'institute-cargo-clauses-a',
    insuranceCoveragePct: 110,
    inspectionRequirement: 'sgs-both',
    qualityStandard: 'Per crude grade assay',
    standardDocuments: [
      'commercial-invoice',
      'bill-of-lading-3-of-3-originals',
      'sgs-quality-certificate',
      'sgs-quantity-certificate',
      'certificate-of-origin',
      'insurance-policy',
      'cargo-manifest',
      'beneficiary-certificate',
    ],
    typicalCycleTimeDaysMin: 28,
    typicalCycleTimeDaysMax: 50,
    laycanWindow: 'standard-5-day',
    marginStructure: 'fixed-spread-per-unit',
    typicalMarginMin: 0.3,
    typicalMarginMax: 0.8,
    marginUnit: 'usd-per-bbl',
    excludedJurisdictions: ['IR', 'KP', 'CU', 'SY'],
    excludedCounterpartyTypes: ['sanctioned-state-owned', 'designated-individual'],
    notes:
      'Standard CIF crude for Tier 1 refiner buyer. Margin compressed vs FOB to reflect freight + insurance pass-through nature.',
  },
  {
    slug: 'conventional-crude-cif-with-laytime',
    name: 'Conventional Crude — CIF / LC Sight (with Laytime Provisions)',
    category: 'crude-conventional',
    vtcEntity: 'vtc-llc',
    applicableRegions: ['global'],
    incoterm: 'CIF',
    riskTransferPoint: "Ship's flange at loadport, with explicit laytime provisions for discharge.",
    paymentInstrument: 'lc-sight',
    paymentCurrency: 'USD',
    cargoInsurance: 'institute-cargo-clauses-a',
    insuranceCoveragePct: 110,
    inspectionRequirement: 'sgs-both',
    qualityStandard: 'Per crude grade assay',
    standardDocuments: [
      'commercial-invoice',
      'bill-of-lading-3-of-3-originals',
      'sgs-quality-certificate',
      'sgs-quantity-certificate',
      'certificate-of-origin',
      'insurance-policy',
      'cargo-manifest',
      'beneficiary-certificate',
      'load-port-survey',
      'discharge-port-survey',
    ],
    typicalCycleTimeDaysMin: 30,
    typicalCycleTimeDaysMax: 55,
    laycanWindow: 'standard-5-day',
    marginStructure: 'fixed-spread-per-unit',
    typicalMarginMin: 0.4,
    typicalMarginMax: 1.0,
    marginUnit: 'usd-per-bbl',
    excludedJurisdictions: ['IR', 'KP', 'CU', 'SY'],
    excludedCounterpartyTypes: ['sanctioned-state-owned', 'designated-individual'],
    notes:
      'CIF crude with explicit laytime provisions for discharge. Demurrage / despatch language critical. Use when discharge-port congestion is meaningful (West African discharge into Indian / Chinese ports).',
  },

  // ─── 6.4 Food commodity (Vector Food Fund I) ───────────────────
  {
    slug: 'food-commodity-cif-lc-sight-gafta',
    name: 'Food Commodity — CIF / LC Sight (GAFTA Form)',
    category: 'food-commodity',
    vtcEntity: 'vector-food-fund',
    applicableRegions: ['caribbean', 'latam-mainland'],
    incoterm: 'CIF',
    riskTransferPoint: "Ship's rail at the loadport (GAFTA Form 49 standard).",
    paymentInstrument: 'lc-sight',
    paymentCurrency: 'USD',
    cargoInsurance: 'institute-cargo-clauses-a',
    insuranceCoveragePct: 110,
    inspectionRequirement: 'sgs-loadport',
    qualityStandard: 'GAFTA contract spec (Form 49 — wheat / corn / soybean meal as appropriate)',
    standardDocuments: [
      'commercial-invoice',
      'bill-of-lading-3-of-3-originals',
      'sgs-quality-certificate',
      'sgs-quantity-certificate',
      'certificate-of-origin',
      'insurance-policy',
      'phytosanitary-certificate',
      'fumigation-certificate',
      'cargo-manifest',
    ],
    typicalCycleTimeDaysMin: 30,
    typicalCycleTimeDaysMax: 50,
    laycanWindow: 'standard-5-day',
    marginStructure: 'fixed-spread-per-unit',
    typicalMarginMin: 1.5,
    typicalMarginMax: 4.0,
    marginUnit: 'pct',
    excludedJurisdictions: ['IR', 'KP', 'CU', 'SY'],
    excludedCounterpartyTypes: ['sanctioned-state-owned'],
    notes:
      "GAFTA Form 49 dry-bulk grain shape. Phytosanitary + fumigation certs are NOT optional — buyer-side ag-ministry rejection risk if missing.",
  },
  {
    slug: 'food-commodity-cif-cad-smaller-buyers',
    name: 'Food Commodity — CIF / CAD (Smaller Caribbean Buyers)',
    category: 'food-commodity',
    vtcEntity: 'vector-food-fund',
    applicableRegions: ['caribbean'],
    incoterm: 'CIF',
    riskTransferPoint: "Ship's rail at the loadport.",
    paymentInstrument: 'cad',
    paymentCurrency: 'USD',
    cargoInsurance: 'institute-cargo-clauses-a',
    insuranceCoveragePct: 110,
    inspectionRequirement: 'sgs-loadport',
    qualityStandard: 'GAFTA contract spec or buyer-specified',
    standardDocuments: [
      'commercial-invoice',
      'bill-of-lading-3-of-3-originals',
      'sgs-quality-certificate',
      'sgs-quantity-certificate',
      'phytosanitary-certificate',
      'fumigation-certificate',
      'insurance-policy',
    ],
    typicalCycleTimeDaysMin: 25,
    typicalCycleTimeDaysMax: 45,
    laycanWindow: 'standard-5-day',
    marginStructure: 'fixed-spread-per-unit',
    typicalMarginMin: 2.0,
    typicalMarginMax: 5.0,
    marginUnit: 'pct',
    excludedJurisdictions: ['IR', 'KP', 'CU', 'SY'],
    excludedCounterpartyTypes: ['sanctioned-state-owned'],
    notes:
      'Smaller Caribbean food distributors without LC infrastructure. Higher margin compensates for elevated counterparty risk. Document control critical.',
  },
  {
    slug: 'food-commodity-fas-origin-tt-prepayment',
    name: 'Food Commodity — FAS Origin / TT Prepayment',
    category: 'food-commodity',
    vtcEntity: 'vector-food-fund',
    applicableRegions: ['global'],
    incoterm: 'FAS',
    riskTransferPoint: 'Goods placed alongside the buyer-nominated vessel at the loadport. Buyer arranges loading + onward freight.',
    paymentInstrument: 'tt-prepayment',
    paymentCurrency: 'USD',
    cargoInsurance: 'buyer-arranged',
    inspectionRequirement: 'sgs-loadport',
    qualityStandard: 'GAFTA spec or buyer-specified',
    standardDocuments: [
      'commercial-invoice',
      'sgs-quality-certificate',
      'sgs-quantity-certificate',
      'certificate-of-origin',
      'phytosanitary-certificate',
      'fumigation-certificate',
    ],
    typicalCycleTimeDaysMin: 14,
    typicalCycleTimeDaysMax: 30,
    laycanWindow: 'standard-5-day',
    marginStructure: 'fixed-spread-per-unit',
    typicalMarginMin: 1.0,
    typicalMarginMax: 3.0,
    marginUnit: 'pct',
    excludedJurisdictions: ['IR', 'KP', 'CU', 'SY'],
    excludedCounterpartyTypes: ['sanctioned-state-owned'],
    notes:
      'Buyer-arranged loading, prepayment for security. FAS shifts loading risk to buyer; common for charterers with own-fleet vessels.',
  },
  {
    slug: 'food-commodity-cfr-narrow-laycan',
    name: 'Food Commodity — CFR / LC Sight (Narrow Laycan)',
    category: 'food-commodity',
    vtcEntity: 'vector-food-fund',
    applicableRegions: ['global'],
    incoterm: 'CFR',
    riskTransferPoint: "Ship's rail at the loadport — buyer arranges insurance from there.",
    paymentInstrument: 'lc-sight',
    paymentCurrency: 'USD',
    cargoInsurance: 'buyer-arranged',
    inspectionRequirement: 'sgs-loadport',
    qualityStandard: 'GAFTA spec or buyer-specified',
    standardDocuments: [
      'commercial-invoice',
      'bill-of-lading-3-of-3-originals',
      'sgs-quality-certificate',
      'sgs-quantity-certificate',
      'certificate-of-origin',
      'phytosanitary-certificate',
      'fumigation-certificate',
    ],
    typicalCycleTimeDaysMin: 21,
    typicalCycleTimeDaysMax: 40,
    laycanWindow: 'narrow-3-day',
    marginStructure: 'fixed-spread-per-unit',
    typicalMarginMin: 1.5,
    typicalMarginMax: 4.0,
    marginUnit: 'pct',
    excludedJurisdictions: ['IR', 'KP', 'CU', 'SY'],
    excludedCounterpartyTypes: ['sanctioned-state-owned'],
    notes:
      "Time-sensitive food shipments with narrow laycan — buyer typically humanitarian / urgent demand. Premium pricing reflects scheduling tightness.",
  },

  // ─── 6.5 Vehicle export (Vector Auto Exports) ──────────────────
  {
    slug: 'vehicle-roro-cif-tt-prepayment',
    name: 'Vehicle Export — RoRo CIF / TT Prepayment',
    category: 'vehicle',
    vtcEntity: 'vector-auto-exports',
    applicableRegions: ['caribbean'],
    incoterm: 'CIF',
    riskTransferPoint: 'On board the RoRo vessel at loadport — VTC arranges shipping + cargo insurance to discharge port.',
    paymentInstrument: 'tt-prepayment',
    paymentCurrency: 'USD',
    cargoInsurance: 'all-risks-marine',
    insuranceCoveragePct: 110,
    inspectionRequirement: 'cargo-inspection-by-buyer',
    qualityStandard: 'Per VIN-specific specification',
    standardDocuments: [
      'commercial-invoice',
      'bill-of-lading-3-of-3-originals',
      'vehicle-vin-list',
      'vehicle-export-permit',
      'certificate-of-origin',
      'insurance-policy',
    ],
    typicalCycleTimeDaysMin: 14,
    typicalCycleTimeDaysMax: 28,
    laycanWindow: 'standard-5-day',
    marginStructure: 'fixed-spread-per-unit',
    typicalMarginMin: 500,
    typicalMarginMax: 2000,
    marginUnit: 'usd-per-shipment',
    excludedJurisdictions: ['IR', 'KP', 'CU', 'SY'],
    excludedCounterpartyTypes: ['sanctioned-state-owned'],
    notes:
      'Standard RoRo vehicle export, prepayment, CIF discharge. Margin per shipment because vehicle counts vary; per-vehicle gross spread is in the contract layer.',
  },
  {
    slug: 'vehicle-roro-fob-tt-against-docs',
    name: 'Vehicle Export — RoRo FOB / TT Against Docs',
    category: 'vehicle',
    vtcEntity: 'vector-auto-exports',
    applicableRegions: ['global'],
    incoterm: 'FOB',
    riskTransferPoint: 'On board the RoRo vessel at loadport. Buyer arranges shipping + insurance from there.',
    paymentInstrument: 'tt-against-docs',
    paymentCurrency: 'USD',
    cargoInsurance: 'buyer-arranged',
    inspectionRequirement: 'cargo-inspection-by-buyer',
    qualityStandard: 'Per VIN-specific specification',
    standardDocuments: [
      'commercial-invoice',
      'bill-of-lading-3-of-3-originals',
      'vehicle-vin-list',
      'vehicle-export-permit',
      'certificate-of-origin',
    ],
    typicalCycleTimeDaysMin: 10,
    typicalCycleTimeDaysMax: 21,
    laycanWindow: 'standard-5-day',
    marginStructure: 'fixed-spread-per-unit',
    typicalMarginMin: 300,
    typicalMarginMax: 1500,
    marginUnit: 'usd-per-shipment',
    excludedJurisdictions: ['IR', 'KP', 'CU', 'SY'],
    excludedCounterpartyTypes: ['sanctioned-state-owned'],
    notes:
      'Buyer-arranged shipping, TT on doc presentation. Tighter cycle vs CIF/prepayment — buyer commits later but financing risk shifts to buyer.',
  },
  {
    slug: 'vehicle-container-cif-escrow',
    name: 'Vehicle Export — Container CIF / Escrow',
    category: 'vehicle',
    vtcEntity: 'vector-auto-exports',
    applicableRegions: ['caribbean'],
    incoterm: 'CIF',
    riskTransferPoint: 'On board container vessel at loadport — VTC arranges shipping + cargo insurance to discharge port.',
    paymentInstrument: 'escrow',
    paymentCurrency: 'USD',
    cargoInsurance: 'all-risks-marine',
    insuranceCoveragePct: 110,
    inspectionRequirement: 'cargo-inspection-by-buyer',
    qualityStandard: 'Per VIN-specific specification',
    standardDocuments: [
      'commercial-invoice',
      'bill-of-lading-3-of-3-originals',
      'vehicle-vin-list',
      'vehicle-export-permit',
      'certificate-of-origin',
      'insurance-policy',
    ],
    typicalCycleTimeDaysMin: 21,
    typicalCycleTimeDaysMax: 42,
    laycanWindow: 'standard-5-day',
    marginStructure: 'fixed-spread-per-unit',
    typicalMarginMin: 700,
    typicalMarginMax: 2500,
    marginUnit: 'usd-per-shipment',
    excludedJurisdictions: ['IR', 'KP', 'CU', 'SY'],
    excludedCounterpartyTypes: ['sanctioned-state-owned'],
    notes:
      'Containerized vehicle export with escrow protection — preferred for first deals with new buyers. Escrow agent specified in contract.',
  },

  // ─── 6.6 LNG / LPG (future-state, draft) ──────────────────────
  {
    slug: 'lpg-cargo-cfr-lc-sight',
    name: 'LPG Cargo — CFR / LC Sight (Draft)',
    category: 'lpg',
    vtcEntity: 'vtc-llc',
    applicableRegions: ['caribbean', 'west-africa'],
    incoterm: 'CFR',
    riskTransferPoint: "Ship's flange at the loadport (refrigerated LPG carrier).",
    paymentInstrument: 'lc-sight',
    paymentCurrency: 'USD',
    cargoInsurance: 'buyer-arranged',
    inspectionRequirement: 'sgs-loadport',
    qualityStandard: 'GPA HD-5 (propane) or commercial-butane spec',
    standardDocuments: [
      'commercial-invoice',
      'bill-of-lading-3-of-3-originals',
      'sgs-quality-certificate',
      'sgs-quantity-certificate',
      'certificate-of-origin',
      'cargo-manifest',
      'sds-msds',
    ],
    typicalCycleTimeDaysMin: 28,
    typicalCycleTimeDaysMax: 50,
    laycanWindow: 'standard-5-day',
    marginStructure: 'fixed-spread-per-unit',
    typicalMarginMin: 5,
    typicalMarginMax: 15,
    marginUnit: 'usd-per-mt',
    status: 'draft',
    excludedJurisdictions: ['IR', 'KP', 'CU', 'SY'],
    excludedCounterpartyTypes: ['sanctioned-state-owned'],
    notes:
      "Future-state. Refrigerated LPG cargo. SDS / MSDS required for hazmat compliance. Counsel-validation pending — flag remains 'draft' until VTC ships first LPG cargo.",
  },
];

async function main() {
  console.log(`Seeding ${TEMPLATES.length} deal-structure templates…`);
  let upserted = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const t of TEMPLATES) {
    try {
      await db.execute(sql`
        INSERT INTO deal_structure_templates (
          slug, name, category, vtc_entity, applicable_regions,
          incoterm, risk_transfer_point, payment_instrument, payment_currency,
          lc_confirmation_required, cargo_insurance, insurance_coverage_pct,
          inspection_requirement, quality_standard, standard_documents,
          typical_cycle_time_days_min, typical_cycle_time_days_max, laycan_window,
          margin_structure, typical_margin_min, typical_margin_max, margin_unit,
          ofac_screening_required, excluded_jurisdictions, excluded_counterparty_types,
          general_license_eligible, status, notes
        ) VALUES (
          ${t.slug},
          ${t.name},
          ${t.category},
          ${t.vtcEntity},
          ARRAY[${sql.join(
            t.applicableRegions.map((r) => sql`${r}`),
            sql`, `,
          )}]::text[],
          ${t.incoterm},
          ${t.riskTransferPoint},
          ${t.paymentInstrument},
          ${t.paymentCurrency},
          ${t.lcConfirmationRequired ?? false},
          ${t.cargoInsurance ?? null},
          ${t.insuranceCoveragePct ?? null},
          ${t.inspectionRequirement ?? null},
          ${t.qualityStandard ?? null},
          ARRAY[${sql.join(
            t.standardDocuments.map((d) => sql`${d}`),
            sql`, `,
          )}]::text[],
          ${t.typicalCycleTimeDaysMin ?? null},
          ${t.typicalCycleTimeDaysMax ?? null},
          ${t.laycanWindow ?? null},
          ${t.marginStructure ?? null},
          ${t.typicalMarginMin ?? null},
          ${t.typicalMarginMax ?? null},
          ${t.marginUnit ?? null},
          ${t.ofacScreeningRequired ?? true},
          ARRAY[${
            (t.excludedJurisdictions ?? []).length > 0
              ? sql.join(
                  (t.excludedJurisdictions ?? []).map((j) => sql`${j}`),
                  sql`, `,
                )
              : sql``
          }]::text[],
          ARRAY[${
            (t.excludedCounterpartyTypes ?? []).length > 0
              ? sql.join(
                  (t.excludedCounterpartyTypes ?? []).map((c) => sql`${c}`),
                  sql`, `,
                )
              : sql``
          }]::text[],
          ${
            t.generalLicenseEligible && t.generalLicenseEligible.length > 0
              ? sql`ARRAY[${sql.join(
                  t.generalLicenseEligible.map((g) => sql`${g}`),
                  sql`, `,
                )}]::text[]`
              : sql`NULL`
          },
          ${t.status ?? 'active'},
          ${t.notes}
        )
        ON CONFLICT (slug) DO UPDATE SET
          name                       = EXCLUDED.name,
          category                   = EXCLUDED.category,
          vtc_entity                 = EXCLUDED.vtc_entity,
          applicable_regions         = EXCLUDED.applicable_regions,
          incoterm                   = EXCLUDED.incoterm,
          risk_transfer_point        = EXCLUDED.risk_transfer_point,
          payment_instrument         = EXCLUDED.payment_instrument,
          payment_currency           = EXCLUDED.payment_currency,
          lc_confirmation_required   = EXCLUDED.lc_confirmation_required,
          cargo_insurance            = EXCLUDED.cargo_insurance,
          insurance_coverage_pct     = EXCLUDED.insurance_coverage_pct,
          inspection_requirement     = EXCLUDED.inspection_requirement,
          quality_standard           = EXCLUDED.quality_standard,
          standard_documents         = EXCLUDED.standard_documents,
          typical_cycle_time_days_min = EXCLUDED.typical_cycle_time_days_min,
          typical_cycle_time_days_max = EXCLUDED.typical_cycle_time_days_max,
          laycan_window              = EXCLUDED.laycan_window,
          margin_structure           = EXCLUDED.margin_structure,
          typical_margin_min         = EXCLUDED.typical_margin_min,
          typical_margin_max         = EXCLUDED.typical_margin_max,
          margin_unit                = EXCLUDED.margin_unit,
          ofac_screening_required    = EXCLUDED.ofac_screening_required,
          excluded_jurisdictions     = EXCLUDED.excluded_jurisdictions,
          excluded_counterparty_types = EXCLUDED.excluded_counterparty_types,
          general_license_eligible   = EXCLUDED.general_license_eligible,
          status                     = EXCLUDED.status,
          notes                      = EXCLUDED.notes,
          updated_at                 = NOW();
      `);
      upserted += 1;
    } catch (err) {
      errors.push(`${t.slug}: ${(err as Error).message}`);
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
