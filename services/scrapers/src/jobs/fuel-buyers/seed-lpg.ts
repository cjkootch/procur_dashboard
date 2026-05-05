/**
 * Tier-1 Caribbean LPG distributors per
 * docs/caribbean-fuel-buyer-brief.md §4.10. LPG operates as a
 * distinct sub-segment because the supply chain (truck-from-
 * terminals, cylinder delivery) is different from gasoline / diesel.
 */
import { ingestSegmentSeed, type FuelBuyerSeedEntry, type SegmentRunSummary } from './_shared';

const SEED: FuelBuyerSeedEntry[] = [
  {
    slug: 'fuel-buyer:tropigas-do',
    name: 'Tropigas Dominicana',
    country: 'DO',
    aliases: ['Tropigas'],
    notes: 'Major DR LPG distributor. Bulk + cylinder delivery network.',
    profile: {
      segments: ['lpg-distributor'],
      fuelTypesPurchased: ['lpg-propane', 'lpg-butane'],
      annualPurchaseVolumeBblMin: 1_500_000,
      annualPurchaseVolumeBblMax: 3_500_000,
      annualPurchaseVolumeConfidence: 'public-disclosure',
      typicalCargoSizeMt: { min: 8_000, max: 25_000 },
      procurementModel: 'term-contract-dominant',
      procurementAuthority: 'centralized',
      knownSuppliers: [],
      caribbeanCountriesOperated: ['DO'],
      decisionMakerCountry: 'DO',
      paymentInstrumentCapability: ['lc-sight', 'lc-deferred', 'sblc-backed'],
      knownBanks: [],
      ownershipType: 'private-domestic',
      tier: 1,
      primaryContactRole: null,
      primaryContactName: null,
      notes: '',
      confidenceScore: 0.85,
    },
  },
  {
    slug: 'fuel-buyer:propagas-do',
    name: 'Propagas (DR)',
    country: 'DO',
    notes:
      'DR LPG distributor. Already in supplier-side rolodex; flagged here as a buyer-side relationship.',
    profile: {
      segments: ['lpg-distributor'],
      fuelTypesPurchased: ['lpg-propane', 'lpg-butane'],
      annualPurchaseVolumeBblMin: 1_000_000,
      annualPurchaseVolumeBblMax: 2_500_000,
      annualPurchaseVolumeConfidence: 'estimated-from-industry-norms',
      typicalCargoSizeMt: { min: 6_000, max: 18_000 },
      procurementModel: 'term-contract-dominant',
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
    slug: 'fuel-buyer:massy-gas-products',
    name: 'Massy Gas Products',
    country: 'TT',
    aliases: ['Massy Gas Products Trinidad'],
    notes:
      'Trinidad-based LPG + industrial gases supplier. Massy Group conglomerate.',
    profile: {
      segments: ['lpg-distributor'],
      fuelTypesPurchased: ['lpg-propane', 'lpg-butane'],
      annualPurchaseVolumeBblMin: 600_000,
      annualPurchaseVolumeBblMax: 1_400_000,
      annualPurchaseVolumeConfidence: 'estimated-from-industry-norms',
      typicalCargoSizeMt: { min: 5_000, max: 15_000 },
      procurementModel: 'term-contract-dominant',
      procurementAuthority: 'centralized',
      knownSuppliers: ['NGC Trinidad'],
      caribbeanCountriesOperated: ['TT', 'GY', 'BB'],
      decisionMakerCountry: 'TT',
      paymentInstrumentCapability: ['lc-sight', 'open-account'],
      knownBanks: ['Republic Bank'],
      ownershipType: 'private-domestic',
      tier: 1,
      primaryContactRole: null,
      primaryContactName: null,
      notes: 'Subsidiary of Massy Holdings (TTSE: MASSY).',
      confidenceScore: 0.85,
    },
  },
  {
    slug: 'fuel-buyer:petrojam-lpg',
    name: 'Petrojam LPG',
    country: 'JM',
    aliases: ['Petrojam Ethanol Limited LPG arm'],
    notes:
      'Petrojam\'s LPG distribution arm; covers domestic Jamaican LPG demand alongside imports.',
    profile: {
      segments: ['lpg-distributor'],
      fuelTypesPurchased: ['lpg-propane', 'lpg-butane'],
      annualPurchaseVolumeBblMin: 800_000,
      annualPurchaseVolumeBblMax: 1_800_000,
      annualPurchaseVolumeConfidence: 'public-disclosure',
      typicalCargoSizeMt: { min: 6_000, max: 18_000 },
      procurementModel: 'term-contract-dominant',
      procurementAuthority: 'centralized',
      knownSuppliers: [],
      caribbeanCountriesOperated: ['JM'],
      decisionMakerCountry: 'JM',
      paymentInstrumentCapability: ['lc-sight', 'sblc-backed'],
      knownBanks: ['NCB Jamaica'],
      ownershipType: 'state-owned',
      tier: 1,
      primaryContactRole: null,
      primaryContactName: null,
      notes: '',
      confidenceScore: 0.82,
    },
  },
];

export type LpgSeedRunSummary = SegmentRunSummary<'lpg-seed'>;

export async function runFuelBuyerLpgSeed(): Promise<LpgSeedRunSummary> {
  return ingestSegmentSeed('lpg-seed', SEED, 'lpg');
}
