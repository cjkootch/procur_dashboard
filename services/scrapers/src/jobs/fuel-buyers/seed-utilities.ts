/**
 * Tier-1 Caribbean utility seed for the fuel-buyer rolodex.
 * Per docs/caribbean-fuel-buyer-brief.md §4.1, utilities are the
 * largest cargo-volume buyers in most Caribbean markets and the
 * most public-disclosure-heavy segment.
 *
 * Each entry is hand-curated from a combination of (a) the utility's
 * own annual reports / 10-Ks / disclosures, (b) IDB/CDB project
 * filings, (c) energy ministry data, (d) industry press. Volume
 * estimates carry a confidence flag — `public-disclosure` for
 * utilities that publish gen-by-fuel mix; `estimated-from-capacity`
 * when nameplate is known but fuel mix is approximate; `unknown` for
 * smaller islands without published data.
 *
 * Slug pattern: `fuel-buyer:<short-name>`. Re-runs idempotently.
 *
 * Volume calibration (rough rules of thumb):
 *   1 MW HFO baseload @ 80% CF → ~40-50 kbbl/yr
 *   1 MW ADO baseload @ 80% CF → ~38-45 kbbl/yr (lower BTU/kg)
 *   1 MW gas turbine peaker @ 20% CF → ~10-12 kbbl/yr equivalent
 */
import { sql } from 'drizzle-orm';
import { db } from '@procur/db';

type SeedEntry = {
  slug: string;
  name: string;
  country: string;
  aliases?: string[];
  notes?: string;
  profile: {
    segments: string[];
    fuelTypesPurchased: string[];
    annualPurchaseVolumeBblMin: number | null;
    annualPurchaseVolumeBblMax: number | null;
    annualPurchaseVolumeConfidence: string;
    typicalCargoSizeMt: { min: number; max: number } | null;
    procurementModel: string;
    procurementAuthority: string;
    knownSuppliers: string[];
    caribbeanCountriesOperated: string[];
    decisionMakerCountry: string | null;
    paymentInstrumentCapability: string[];
    knownBanks: string[];
    ownershipType: string;
    tier: 1 | 2 | 3 | null;
    primaryContactRole: string | null;
    primaryContactName: string | null;
    notes: string;
    confidenceScore: number;
  };
};

const SEED: SeedEntry[] = [
  // ─── Jamaica ────────────────────────────────────────────────────
  {
    slug: 'fuel-buyer:jps-jamaica',
    name: 'Jamaica Public Service Company (JPS)',
    country: 'JM',
    aliases: ['JPS', 'Jamaica Public Service'],
    notes:
      'Jamaica\'s monopoly electric utility. ~600+ MW thermal capacity (HFO + ADO + LNG). Procures via Petrojam primarily, with some direct imports.',
    profile: {
      segments: ['utility-power-generation'],
      fuelTypesPurchased: ['hfo-380cst', 'diesel-ulsd', 'diesel-lsd'],
      annualPurchaseVolumeBblMin: 2_500_000,
      annualPurchaseVolumeBblMax: 4_000_000,
      annualPurchaseVolumeConfidence: 'public-disclosure',
      typicalCargoSizeMt: { min: 25_000, max: 50_000 },
      procurementModel: 'term-contract-dominant',
      procurementAuthority: 'centralized',
      knownSuppliers: ['Petrojam', 'Marubeni'],
      caribbeanCountriesOperated: ['JM'],
      decisionMakerCountry: 'JM',
      paymentInstrumentCapability: ['lc-sight', 'lc-deferred', 'sblc-backed'],
      knownBanks: ['NCB Jamaica', 'Scotiabank Jamaica'],
      ownershipType: 'multinational-subsidiary',
      tier: 1,
      primaryContactRole: 'Vice President, Generation & Supply',
      primaryContactName: null,
      notes:
        'Ownership: 40% Marubeni Corp, 40% Korea East-West Power (KEPCO/EWP), 19.9% Govt of Jamaica.',
      confidenceScore: 0.92,
    },
  },
  {
    slug: 'fuel-buyer:jep-jamaica',
    name: 'Jamaica Energy Partners (JEP)',
    country: 'JM',
    notes:
      'Independent power producer, HFO consumer. Multiple barge-mounted generation units.',
    profile: {
      segments: ['utility-power-generation'],
      fuelTypesPurchased: ['hfo-380cst'],
      annualPurchaseVolumeBblMin: 800_000,
      annualPurchaseVolumeBblMax: 1_500_000,
      annualPurchaseVolumeConfidence: 'estimated-from-capacity',
      typicalCargoSizeMt: { min: 15_000, max: 30_000 },
      procurementModel: 'term-contract-dominant',
      procurementAuthority: 'centralized',
      knownSuppliers: [],
      caribbeanCountriesOperated: ['JM'],
      decisionMakerCountry: 'JM',
      paymentInstrumentCapability: ['lc-sight', 'lc-deferred'],
      knownBanks: [],
      ownershipType: 'private-domestic',
      tier: 1,
      primaryContactRole: null,
      primaryContactName: null,
      notes: 'IPP supplying JPS grid.',
      confidenceScore: 0.78,
    },
  },

  // ─── Bahamas ────────────────────────────────────────────────────
  {
    slug: 'fuel-buyer:bpl-bahamas',
    name: 'Bahamas Power and Light (BPL)',
    country: 'BS',
    aliases: ['BPL', 'BEC'],
    notes:
      'State-owned electric utility serving New Providence + Family Islands. Significant HFO and ADO consumer; Bahamas imports almost all fuel.',
    profile: {
      segments: ['utility-power-generation'],
      fuelTypesPurchased: ['hfo-380cst', 'diesel-ulsd', 'diesel-lsd'],
      annualPurchaseVolumeBblMin: 1_800_000,
      annualPurchaseVolumeBblMax: 2_800_000,
      annualPurchaseVolumeConfidence: 'public-disclosure',
      typicalCargoSizeMt: { min: 20_000, max: 40_000 },
      procurementModel: 'tender-only',
      procurementAuthority: 'centralized',
      knownSuppliers: ['Shell', 'World Fuel Services'],
      caribbeanCountriesOperated: ['BS'],
      decisionMakerCountry: 'BS',
      paymentInstrumentCapability: ['lc-sight', 'sblc-backed'],
      knownBanks: ['Royal Bank of Canada', 'Scotiabank Bahamas'],
      ownershipType: 'state-owned',
      tier: 1,
      primaryContactRole: 'CEO',
      primaryContactName: null,
      notes: 'Shaw Steel Resources Investment took control via concession; ownership has been complicated.',
      confidenceScore: 0.85,
    },
  },

  // ─── Dominican Republic ─────────────────────────────────────────
  {
    slug: 'fuel-buyer:ege-haina',
    name: 'EGE Haina',
    country: 'DO',
    aliases: ['Empresa Generadora de Electricidad Haina'],
    notes:
      'Major Dominican IPP. Multiple thermal plants (Sultana del Este, Quisqueya, Barahona, Pedernales). HFO + diesel consumer.',
    profile: {
      segments: ['utility-power-generation'],
      fuelTypesPurchased: ['hfo-380cst', 'diesel-ulsd'],
      annualPurchaseVolumeBblMin: 3_000_000,
      annualPurchaseVolumeBblMax: 5_000_000,
      annualPurchaseVolumeConfidence: 'public-disclosure',
      typicalCargoSizeMt: { min: 30_000, max: 60_000 },
      procurementModel: 'hybrid',
      procurementAuthority: 'centralized',
      knownSuppliers: [],
      caribbeanCountriesOperated: ['DO'],
      decisionMakerCountry: 'DO',
      paymentInstrumentCapability: ['lc-sight', 'lc-deferred', 'sblc-backed'],
      knownBanks: ['Banco Popular Dominicano', 'BHD León'],
      ownershipType: 'private-domestic',
      tier: 1,
      primaryContactRole: 'VP Procurement',
      primaryContactName: null,
      notes: 'One of the largest IPPs in the Caribbean.',
      confidenceScore: 0.92,
    },
  },
  {
    slug: 'fuel-buyer:aes-andres',
    name: 'AES Andrés',
    country: 'DO',
    aliases: ['AES Dominicana'],
    notes:
      'AES Corp subsidiary. LNG terminal + 319 MW combined-cycle plant. Some HFO backup capacity.',
    profile: {
      segments: ['utility-power-generation'],
      fuelTypesPurchased: ['hfo-380cst', 'diesel-ulsd'],
      annualPurchaseVolumeBblMin: 500_000,
      annualPurchaseVolumeBblMax: 1_200_000,
      annualPurchaseVolumeConfidence: 'estimated-from-capacity',
      typicalCargoSizeMt: { min: 15_000, max: 35_000 },
      procurementModel: 'term-contract-dominant',
      procurementAuthority: 'centralized',
      knownSuppliers: [],
      caribbeanCountriesOperated: ['DO'],
      decisionMakerCountry: 'US',
      paymentInstrumentCapability: ['lc-sight', 'lc-deferred', 'open-account'],
      knownBanks: [],
      ownershipType: 'multinational-subsidiary',
      tier: 1,
      primaryContactRole: null,
      primaryContactName: null,
      notes: 'Procurement decision-maker country is US (AES corporate, Arlington VA).',
      confidenceScore: 0.85,
    },
  },
  {
    slug: 'fuel-buyer:cespm',
    name: 'CESPM',
    country: 'DO',
    aliases: ['Compañía de Electricidad de San Pedro de Macorís'],
    notes: 'Dominican IPP with 300 MW HFO/diesel-fired generation in San Pedro de Macorís.',
    profile: {
      segments: ['utility-power-generation'],
      fuelTypesPurchased: ['hfo-380cst', 'diesel-ulsd'],
      annualPurchaseVolumeBblMin: 700_000,
      annualPurchaseVolumeBblMax: 1_400_000,
      annualPurchaseVolumeConfidence: 'estimated-from-capacity',
      typicalCargoSizeMt: { min: 15_000, max: 30_000 },
      procurementModel: 'hybrid',
      procurementAuthority: 'centralized',
      knownSuppliers: [],
      caribbeanCountriesOperated: ['DO'],
      decisionMakerCountry: 'DO',
      paymentInstrumentCapability: ['lc-sight', 'lc-deferred'],
      knownBanks: [],
      ownershipType: 'private-domestic',
      tier: 1,
      primaryContactRole: null,
      primaryContactName: null,
      notes: '',
      confidenceScore: 0.78,
    },
  },
  {
    slug: 'fuel-buyer:ege-itabo',
    name: 'EGE Itabo',
    country: 'DO',
    aliases: ['Empresa de Generación Eléctrica Itabo'],
    notes: 'Coal + HFO IPP near Santo Domingo. ~280 MW capacity.',
    profile: {
      segments: ['utility-power-generation'],
      fuelTypesPurchased: ['hfo-380cst'],
      annualPurchaseVolumeBblMin: 600_000,
      annualPurchaseVolumeBblMax: 1_100_000,
      annualPurchaseVolumeConfidence: 'estimated-from-capacity',
      typicalCargoSizeMt: { min: 15_000, max: 30_000 },
      procurementModel: 'hybrid',
      procurementAuthority: 'centralized',
      knownSuppliers: [],
      caribbeanCountriesOperated: ['DO'],
      decisionMakerCountry: 'DO',
      paymentInstrumentCapability: ['lc-sight', 'lc-deferred'],
      knownBanks: [],
      ownershipType: 'private-domestic',
      tier: 1,
      primaryContactRole: null,
      primaryContactName: null,
      notes: '',
      confidenceScore: 0.78,
    },
  },

  // ─── Puerto Rico ────────────────────────────────────────────────
  {
    slug: 'fuel-buyer:prepa',
    name: 'PREPA',
    country: 'PR',
    aliases: ['Puerto Rico Electric Power Authority', 'Autoridad de Energía Eléctrica'],
    notes:
      'Largest US-territory power utility. Significant HFO + diesel consumption despite ongoing restructuring under federal oversight (PROMESA).',
    profile: {
      segments: ['utility-power-generation'],
      fuelTypesPurchased: ['hfo-380cst', 'diesel-ulsd'],
      annualPurchaseVolumeBblMin: 5_000_000,
      annualPurchaseVolumeBblMax: 9_000_000,
      annualPurchaseVolumeConfidence: 'public-disclosure',
      typicalCargoSizeMt: { min: 30_000, max: 70_000 },
      procurementModel: 'tender-only',
      procurementAuthority: 'centralized',
      knownSuppliers: ['ExxonMobil', 'Shell'],
      caribbeanCountriesOperated: ['PR'],
      decisionMakerCountry: 'PR',
      paymentInstrumentCapability: ['lc-sight', 'sblc-backed', 'open-account'],
      knownBanks: [],
      ownershipType: 'state-owned',
      tier: 1,
      primaryContactRole: 'Director of Fuels Procurement',
      primaryContactName: null,
      notes: 'Under PROMESA federal oversight; LUMA Energy operates transmission/distribution but PREPA owns generation.',
      confidenceScore: 0.9,
    },
  },

  // ─── US Virgin Islands ──────────────────────────────────────────
  {
    slug: 'fuel-buyer:wapa-usvi',
    name: 'WAPA US Virgin Islands',
    country: 'VI',
    aliases: ['Virgin Islands Water and Power Authority'],
    notes:
      'St. Thomas + St. Croix + St. John generation. ADO and HFO. Aging fleet under transition.',
    profile: {
      segments: ['utility-power-generation', 'utility-water-desalination'],
      fuelTypesPurchased: ['diesel-ulsd', 'hfo-380cst'],
      annualPurchaseVolumeBblMin: 800_000,
      annualPurchaseVolumeBblMax: 1_400_000,
      annualPurchaseVolumeConfidence: 'public-disclosure',
      typicalCargoSizeMt: { min: 15_000, max: 30_000 },
      procurementModel: 'tender-only',
      procurementAuthority: 'centralized',
      knownSuppliers: ['Glencore', 'Vitol'],
      caribbeanCountriesOperated: ['VI'],
      decisionMakerCountry: 'VI',
      paymentInstrumentCapability: ['lc-sight'],
      knownBanks: [],
      ownershipType: 'state-owned',
      tier: 1,
      primaryContactRole: null,
      primaryContactName: null,
      notes: 'Combines water + power — desal capability.',
      confidenceScore: 0.85,
    },
  },

  // ─── Trinidad & Tobago ──────────────────────────────────────────
  {
    slug: 'fuel-buyer:ttec',
    name: 'Trinidad and Tobago Electricity Commission (T&TEC)',
    country: 'TT',
    aliases: ['T&TEC'],
    notes:
      'State-owned utility. Primarily natural gas-fueled (Trinidad has abundant domestic gas) but maintains HFO backup capacity.',
    profile: {
      segments: ['utility-power-generation'],
      fuelTypesPurchased: ['hfo-380cst', 'diesel-ulsd'],
      annualPurchaseVolumeBblMin: 200_000,
      annualPurchaseVolumeBblMax: 600_000,
      annualPurchaseVolumeConfidence: 'estimated-from-industry-norms',
      typicalCargoSizeMt: { min: 10_000, max: 25_000 },
      procurementModel: 'tender-only',
      procurementAuthority: 'centralized',
      knownSuppliers: ['Heritage Petroleum', 'Paria Fuel Trading'],
      caribbeanCountriesOperated: ['TT'],
      decisionMakerCountry: 'TT',
      paymentInstrumentCapability: ['lc-sight', 'sblc-backed', 'open-account'],
      knownBanks: ['Republic Bank', 'First Citizens Bank'],
      ownershipType: 'state-owned',
      tier: 2,
      primaryContactRole: null,
      primaryContactName: null,
      notes: 'Lower tier because gas-dominated; HFO/diesel are backup-only.',
      confidenceScore: 0.82,
    },
  },

  // ─── Barbados ───────────────────────────────────────────────────
  {
    slug: 'fuel-buyer:blpc-barbados',
    name: 'Barbados Light & Power (BLPC)',
    country: 'BB',
    aliases: ['BLPC'],
    notes:
      'Single utility for Barbados. ADO + HFO; transitioning to renewables but baseload still oil-fired.',
    profile: {
      segments: ['utility-power-generation'],
      fuelTypesPurchased: ['hfo-380cst', 'diesel-ulsd'],
      annualPurchaseVolumeBblMin: 600_000,
      annualPurchaseVolumeBblMax: 1_100_000,
      annualPurchaseVolumeConfidence: 'public-disclosure',
      typicalCargoSizeMt: { min: 12_000, max: 25_000 },
      procurementModel: 'term-contract-dominant',
      procurementAuthority: 'centralized',
      knownSuppliers: ['Sol Petroleum'],
      caribbeanCountriesOperated: ['BB'],
      decisionMakerCountry: 'BB',
      paymentInstrumentCapability: ['lc-sight', 'sblc-backed'],
      knownBanks: ['Republic Bank Barbados'],
      ownershipType: 'multinational-subsidiary',
      tier: 1,
      primaryContactRole: null,
      primaryContactName: null,
      notes: 'Owned by Emera (Canada).',
      confidenceScore: 0.88,
    },
  },

  // ─── Curaçao ────────────────────────────────────────────────────
  {
    slug: 'fuel-buyer:aqualectra',
    name: 'Aqualectra',
    country: 'CW',
    notes:
      'Curaçao\'s combined power + water utility. HFO, ADO, and water desalination.',
    profile: {
      segments: ['utility-power-generation', 'utility-water-desalination'],
      fuelTypesPurchased: ['hfo-380cst', 'diesel-ulsd'],
      annualPurchaseVolumeBblMin: 600_000,
      annualPurchaseVolumeBblMax: 1_100_000,
      annualPurchaseVolumeConfidence: 'estimated-from-capacity',
      typicalCargoSizeMt: { min: 15_000, max: 30_000 },
      procurementModel: 'term-contract-dominant',
      procurementAuthority: 'centralized',
      knownSuppliers: [],
      caribbeanCountriesOperated: ['CW'],
      decisionMakerCountry: 'CW',
      paymentInstrumentCapability: ['lc-sight'],
      knownBanks: [],
      ownershipType: 'state-owned',
      tier: 1,
      primaryContactRole: null,
      primaryContactName: null,
      notes: '',
      confidenceScore: 0.8,
    },
  },

  // ─── Eastern Caribbean (smaller islands) ────────────────────────
  {
    slug: 'fuel-buyer:lucelec-st-lucia',
    name: 'LUCELEC',
    country: 'LC',
    aliases: ['St. Lucia Electricity Services'],
    notes: 'St. Lucia\'s utility. ADO + HFO; transitioning generation mix.',
    profile: {
      segments: ['utility-power-generation'],
      fuelTypesPurchased: ['hfo-380cst', 'diesel-ulsd'],
      annualPurchaseVolumeBblMin: 250_000,
      annualPurchaseVolumeBblMax: 450_000,
      annualPurchaseVolumeConfidence: 'public-disclosure',
      typicalCargoSizeMt: { min: 8_000, max: 18_000 },
      procurementModel: 'term-contract-dominant',
      procurementAuthority: 'centralized',
      knownSuppliers: ['Sol Petroleum'],
      caribbeanCountriesOperated: ['LC'],
      decisionMakerCountry: 'LC',
      paymentInstrumentCapability: ['lc-sight'],
      knownBanks: [],
      ownershipType: 'private-domestic',
      tier: 2,
      primaryContactRole: null,
      primaryContactName: null,
      notes: '',
      confidenceScore: 0.85,
    },
  },
  {
    slug: 'fuel-buyer:grenlec-grenada',
    name: 'GRENLEC',
    country: 'GD',
    aliases: ['Grenada Electricity Services'],
    notes: 'Grenada\'s utility. ADO + HFO.',
    profile: {
      segments: ['utility-power-generation'],
      fuelTypesPurchased: ['hfo-380cst', 'diesel-ulsd'],
      annualPurchaseVolumeBblMin: 180_000,
      annualPurchaseVolumeBblMax: 320_000,
      annualPurchaseVolumeConfidence: 'public-disclosure',
      typicalCargoSizeMt: { min: 6_000, max: 14_000 },
      procurementModel: 'term-contract-dominant',
      procurementAuthority: 'centralized',
      knownSuppliers: ['Sol Petroleum'],
      caribbeanCountriesOperated: ['GD'],
      decisionMakerCountry: 'GD',
      paymentInstrumentCapability: ['lc-sight'],
      knownBanks: [],
      ownershipType: 'state-owned',
      tier: 2,
      primaryContactRole: null,
      primaryContactName: null,
      notes: '',
      confidenceScore: 0.82,
    },
  },
  {
    slug: 'fuel-buyer:vinlec-st-vincent',
    name: 'VINLEC',
    country: 'VC',
    aliases: ['St. Vincent Electricity Services'],
    notes: 'St. Vincent & the Grenadines utility.',
    profile: {
      segments: ['utility-power-generation'],
      fuelTypesPurchased: ['hfo-380cst', 'diesel-ulsd'],
      annualPurchaseVolumeBblMin: 100_000,
      annualPurchaseVolumeBblMax: 220_000,
      annualPurchaseVolumeConfidence: 'estimated-from-industry-norms',
      typicalCargoSizeMt: { min: 5_000, max: 12_000 },
      procurementModel: 'term-contract-dominant',
      procurementAuthority: 'centralized',
      knownSuppliers: [],
      caribbeanCountriesOperated: ['VC'],
      decisionMakerCountry: 'VC',
      paymentInstrumentCapability: ['lc-sight'],
      knownBanks: [],
      ownershipType: 'state-owned',
      tier: 2,
      primaryContactRole: null,
      primaryContactName: null,
      notes: '',
      confidenceScore: 0.75,
    },
  },
  {
    slug: 'fuel-buyer:domlec-dominica',
    name: 'DOMLEC',
    country: 'DM',
    aliases: ['Dominica Electricity Services'],
    notes: 'Dominica\'s utility. Small island grid.',
    profile: {
      segments: ['utility-power-generation'],
      fuelTypesPurchased: ['diesel-ulsd', 'hfo-380cst'],
      annualPurchaseVolumeBblMin: 60_000,
      annualPurchaseVolumeBblMax: 130_000,
      annualPurchaseVolumeConfidence: 'estimated-from-industry-norms',
      typicalCargoSizeMt: { min: 3_000, max: 8_000 },
      procurementModel: 'term-contract-dominant',
      procurementAuthority: 'centralized',
      knownSuppliers: [],
      caribbeanCountriesOperated: ['DM'],
      decisionMakerCountry: 'DM',
      paymentInstrumentCapability: ['lc-sight'],
      knownBanks: [],
      ownershipType: 'state-owned',
      tier: 3,
      primaryContactRole: null,
      primaryContactName: null,
      notes: 'Small parcels only; below typical cargo-import scale.',
      confidenceScore: 0.7,
    },
  },
  {
    slug: 'fuel-buyer:anglec-anguilla',
    name: 'Anguilla Electricity Company (ANGLEC)',
    country: 'AI',
    aliases: ['ANGLEC'],
    notes: 'Anguilla\'s utility. Small ADO consumer.',
    profile: {
      segments: ['utility-power-generation'],
      fuelTypesPurchased: ['diesel-ulsd'],
      annualPurchaseVolumeBblMin: 40_000,
      annualPurchaseVolumeBblMax: 90_000,
      annualPurchaseVolumeConfidence: 'estimated-from-industry-norms',
      typicalCargoSizeMt: { min: 2_000, max: 6_000 },
      procurementModel: 'term-contract-dominant',
      procurementAuthority: 'centralized',
      knownSuppliers: [],
      caribbeanCountriesOperated: ['AI'],
      decisionMakerCountry: 'AI',
      paymentInstrumentCapability: ['lc-sight'],
      knownBanks: [],
      ownershipType: 'state-owned',
      tier: 3,
      primaryContactRole: null,
      primaryContactName: null,
      notes: 'Small parcels only.',
      confidenceScore: 0.7,
    },
  },

  // ─── Belize ─────────────────────────────────────────────────────
  {
    slug: 'fuel-buyer:bel-belize',
    name: 'Belize Electricity Limited (BEL)',
    country: 'BZ',
    aliases: ['BEL'],
    notes:
      'Belize\'s utility. Diesel-fired generation; partial Mexican grid imports complicate the demand picture.',
    profile: {
      segments: ['utility-power-generation'],
      fuelTypesPurchased: ['diesel-ulsd', 'hfo-380cst'],
      annualPurchaseVolumeBblMin: 200_000,
      annualPurchaseVolumeBblMax: 400_000,
      annualPurchaseVolumeConfidence: 'estimated-from-capacity',
      typicalCargoSizeMt: { min: 8_000, max: 18_000 },
      procurementModel: 'hybrid',
      procurementAuthority: 'centralized',
      knownSuppliers: [],
      caribbeanCountriesOperated: ['BZ'],
      decisionMakerCountry: 'BZ',
      paymentInstrumentCapability: ['lc-sight'],
      knownBanks: [],
      ownershipType: 'state-adjacent',
      tier: 2,
      primaryContactRole: null,
      primaryContactName: null,
      notes: '',
      confidenceScore: 0.78,
    },
  },

  // ─── Haiti ──────────────────────────────────────────────────────
  {
    slug: 'fuel-buyer:edh-haiti',
    name: 'Électricité d\'Haïti (EdH)',
    country: 'HT',
    aliases: ['EdH'],
    notes:
      'Haiti\'s state utility. ADO + HFO when supply is available; chronically constrained on fuel procurement, with ongoing political and security overlay.',
    profile: {
      segments: ['utility-power-generation'],
      fuelTypesPurchased: ['hfo-380cst', 'diesel-ulsd'],
      annualPurchaseVolumeBblMin: 400_000,
      annualPurchaseVolumeBblMax: 1_000_000,
      annualPurchaseVolumeConfidence: 'estimated-from-industry-norms',
      typicalCargoSizeMt: { min: 10_000, max: 25_000 },
      procurementModel: 'tender-only',
      procurementAuthority: 'centralized',
      knownSuppliers: [],
      caribbeanCountriesOperated: ['HT'],
      decisionMakerCountry: 'HT',
      paymentInstrumentCapability: ['lc-sight', 'sblc-backed'],
      knownBanks: [],
      ownershipType: 'state-owned',
      tier: 2,
      primaryContactRole: null,
      primaryContactName: null,
      notes: 'Per-deal context heavily depends on Haiti\'s current security + political situation.',
      confidenceScore: 0.7,
    },
  },

  // ─── Suriname ───────────────────────────────────────────────────
  {
    slug: 'fuel-buyer:ebs-suriname',
    name: 'EBS (NV Energiebedrijven Suriname)',
    country: 'SR',
    aliases: ['EBS'],
    notes:
      'Suriname\'s state utility. Diesel-dominant generation with significant fuel-import dependency.',
    profile: {
      segments: ['utility-power-generation'],
      fuelTypesPurchased: ['diesel-ulsd', 'hfo-380cst'],
      annualPurchaseVolumeBblMin: 800_000,
      annualPurchaseVolumeBblMax: 1_400_000,
      annualPurchaseVolumeConfidence: 'public-disclosure',
      typicalCargoSizeMt: { min: 12_000, max: 30_000 },
      procurementModel: 'tender-only',
      procurementAuthority: 'centralized',
      knownSuppliers: ['Staatsolie'],
      caribbeanCountriesOperated: ['SR'],
      decisionMakerCountry: 'SR',
      paymentInstrumentCapability: ['lc-sight', 'sblc-backed'],
      knownBanks: [],
      ownershipType: 'state-owned',
      tier: 1,
      primaryContactRole: null,
      primaryContactName: null,
      notes: '',
      confidenceScore: 0.85,
    },
  },

  // ─── Guyana ─────────────────────────────────────────────────────
  {
    slug: 'fuel-buyer:gpl-guyana',
    name: 'Guyana Power and Light (GPL)',
    country: 'GY',
    aliases: ['GPL'],
    notes:
      'Guyana\'s utility. ADO + HFO; demand structure is rapidly evolving with the offshore oil ramp-up and gas-to-shore project.',
    profile: {
      segments: ['utility-power-generation'],
      fuelTypesPurchased: ['hfo-380cst', 'diesel-ulsd'],
      annualPurchaseVolumeBblMin: 800_000,
      annualPurchaseVolumeBblMax: 1_500_000,
      annualPurchaseVolumeConfidence: 'public-disclosure',
      typicalCargoSizeMt: { min: 12_000, max: 30_000 },
      procurementModel: 'tender-only',
      procurementAuthority: 'centralized',
      knownSuppliers: [],
      caribbeanCountriesOperated: ['GY'],
      decisionMakerCountry: 'GY',
      paymentInstrumentCapability: ['lc-sight', 'sblc-backed'],
      knownBanks: ['Republic Bank Guyana'],
      ownershipType: 'state-owned',
      tier: 1,
      primaryContactRole: null,
      primaryContactName: null,
      notes: 'Demand to drop substantially when GTE gas-to-shore comes online.',
      confidenceScore: 0.85,
    },
  },
];

export type FuelBuyerSeedRunSummary = {
  source: 'fuel-buyer-utilities-seed';
  status: 'ok' | 'error';
  upserted: number;
  skipped: number;
  errors: string[];
  startedAt: string;
  finishedAt: string;
};

export async function runFuelBuyerUtilitiesSeed(): Promise<FuelBuyerSeedRunSummary> {
  const startedAt = new Date().toISOString();
  let upserted = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const e of SEED) {
    try {
      const tags = ['fuel-buyer', 'source:curated-seed', 'segment:utility'];
      tags.push(`region:caribbean`);
      const aliases = e.aliases ?? [];
      await db.execute(sql`
        INSERT INTO known_entities (
          slug, name, country, role, categories, aliases, tags, notes, metadata
        ) VALUES (
          ${e.slug},
          ${e.name},
          ${e.country},
          ${'fuel-buyer-industrial'},
          ARRAY['fuel-buyer','utility']::text[],
          ${aliases.length > 0 ? sql`ARRAY[${sql.join(aliases.map((a) => sql`${a}`), sql`, `)}]::text[]` : sql`NULL`},
          ARRAY[${sql.join(tags.map((t) => sql`${t}`), sql`, `)}]::text[],
          ${e.notes ?? null},
          ${JSON.stringify({ fuelBuyerProfile: e.profile })}::jsonb
        )
        ON CONFLICT (slug) DO UPDATE SET
          name       = EXCLUDED.name,
          aliases    = EXCLUDED.aliases,
          categories = EXCLUDED.categories,
          tags       = EXCLUDED.tags,
          notes      = EXCLUDED.notes,
          metadata   = EXCLUDED.metadata,
          updated_at = NOW();
      `);
      upserted += 1;
    } catch (err) {
      errors.push(`seed ${e.slug}: ${(err as Error).message}`);
      skipped += 1;
    }
  }

  return {
    source: 'fuel-buyer-utilities-seed',
    status: errors.length > 0 && upserted === 0 ? 'error' : 'ok',
    upserted,
    skipped,
    errors,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}
