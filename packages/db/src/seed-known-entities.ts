/**
 * Hand-curated seed for known_entities — entities we want surfaced
 * on day-zero, before the Wikidata ingest runs (or as editorial
 * overrides on top of it).
 *
 * Coverage in this seed:
 *   - Mediterranean complex refineries (top Libyan-crude candidates)
 *   - Indian state refiners (public-tender-visible, IOCL/BPCL/HPCL/MRPL)
 *   - Other Asian state refiners (Pertamina, PSO, BPC, CPC)
 *   - Major commodity trading houses with crude desks
 *   - A handful of representative private European refiners
 *
 * Facts here are restricted to publicly-known basics (refinery name,
 * operator, country, approximate capacity, where confidently known).
 * No invented contact details. The idempotent upsert on slug means
 * the Wikidata ingest can layer over this without conflict.
 *
 * Run from repo root:
 *   pnpm --filter @procur/db seed-known-entities
 */
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from './schema';

loadEnv({ path: '../../.env.local' });
loadEnv({ path: '../../.env' });

type Seed = {
  slug: string;
  name: string;
  country: string;
  role: 'refiner' | 'trader' | 'producer' | 'state-buyer';
  categories: string[];
  notes: string;
  aliases?: string[];
  tags?: string[];
  metadata?: Record<string, unknown>;
};

/**
 * Mediterranean complex refineries — the natural buyer pool for
 * Libyan light sweet crude (Es Sider, Sharara grades). Capacity
 * figures are public-knowledge approximations in barrels per day.
 */
const MEDITERRANEAN_REFINERS: Seed[] = [
  {
    slug: 'curated-it-eni-sannazzaro',
    name: 'Eni Sannazzaro Refinery',
    country: 'IT',
    role: 'refiner',
    categories: ['crude-oil', 'diesel', 'gasoline', 'jet-fuel'],
    notes:
      'Eni-operated, Lombardy. Complex refinery with cracking + hydrocracking. Historical Libyan crude buyer; Eni has long-running upstream presence in Libya. Approx 200 kbd CDU.',
    aliases: ['Eni Sannazzaro', 'Sannazzaro de Burgondi'],
    tags: ['refinery', 'region:mediterranean', 'private', 'sweet-crude-runner', 'libya-historic'],
    metadata: { capacity_bpd: 200_000, operator: 'Eni' },
  },
  {
    slug: 'curated-it-eni-taranto',
    name: 'Eni Taranto Refinery',
    country: 'IT',
    role: 'refiner',
    categories: ['crude-oil', 'diesel', 'gasoline'],
    notes:
      'Eni Apulia complex. Historical Libyan crude runner; Eni Libya partnership (NOC + Mellitah Oil & Gas) means preferential access. Approx 105 kbd.',
    aliases: ['Eni Taranto'],
    tags: ['refinery', 'region:mediterranean', 'private', 'libya-historic'],
    metadata: { capacity_bpd: 105_000, operator: 'Eni' },
  },
  {
    slug: 'curated-it-isab-priolo',
    name: 'ISAB / Priolo Refinery',
    country: 'IT',
    role: 'refiner',
    categories: ['crude-oil', 'diesel', 'gasoline', 'jet-fuel'],
    notes:
      'Sicily. Two-train complex, ~360 kbd combined CDU. Sold by Lukoil to G.O.I. (Goi Energy) in 2023; ownership/sanctions situation worth verifying before outreach. Major sweet-crude runner.',
    aliases: ['ISAB Priolo', 'Priolo refinery', 'Goi Energy Priolo'],
    tags: ['refinery', 'region:mediterranean', 'private', 'sweet-crude-runner', 'sanctions-watch'],
    metadata: { capacity_bpd: 360_000, operator: 'GOI Energy' },
  },
  {
    slug: 'curated-it-saras-sarroch',
    name: 'Saras Sarroch Refinery',
    country: 'IT',
    role: 'refiner',
    categories: ['crude-oil', 'diesel', 'gasoline', 'jet-fuel'],
    notes:
      'Sardinia. Independent (Saras family + Vitol JV from 2024). 300 kbd, one of the most complex refineries in the Mediterranean. Spot-cargo buyer; relationships heavily mediated by trading houses.',
    aliases: ['Saras', 'Sarroch refinery'],
    tags: ['refinery', 'region:mediterranean', 'private', 'sweet-crude-runner', 'high-complexity'],
    metadata: { capacity_bpd: 300_000, operator: 'Saras' },
  },
  {
    slug: 'curated-es-repsol-cartagena',
    name: 'Repsol Cartagena Refinery',
    country: 'ES',
    role: 'refiner',
    categories: ['crude-oil', 'diesel', 'gasoline', 'jet-fuel'],
    notes:
      'Spain — largest in Iberia at ~220 kbd. Repsol is a known Libyan crude historical importer; Repsol Exploration has Libyan upstream concessions (Sharara block partnership).',
    aliases: ['Repsol Cartagena'],
    tags: ['refinery', 'region:mediterranean', 'private', 'sweet-crude-runner', 'libya-historic'],
    metadata: { capacity_bpd: 220_000, operator: 'Repsol' },
  },
  {
    slug: 'curated-es-repsol-bilbao',
    name: 'Repsol Bilbao (Petronor) Refinery',
    country: 'ES',
    role: 'refiner',
    categories: ['crude-oil', 'diesel', 'gasoline', 'jet-fuel'],
    notes:
      'Northern Spain, ~220 kbd. Operated by Petronor (Repsol majority). Atlantic coast — receives a mix of West African + Mediterranean crudes.',
    aliases: ['Petronor', 'Repsol Bilbao', 'Petronor Bilbao'],
    tags: ['refinery', 'region:mediterranean', 'private'],
    metadata: { capacity_bpd: 220_000, operator: 'Petronor / Repsol' },
  },
  {
    slug: 'curated-tr-tupras-izmit',
    name: 'TÜPRAŞ İzmit Refinery',
    country: 'TR',
    role: 'refiner',
    categories: ['crude-oil', 'diesel', 'gasoline', 'jet-fuel'],
    notes:
      'Largest Turkish refinery, ~227 kbd. Heavy Russian crude diet historically; pivot opportunity if discount on Mediterranean sweet narrows. Tenders not consistently public.',
    aliases: ['Tupras Izmit', 'Tupras Kocaeli'],
    tags: ['refinery', 'region:mediterranean', 'private', 'urals-substitute-watch'],
    metadata: { capacity_bpd: 227_000, operator: 'Tüpraş (Koç Holding)' },
  },
  {
    slug: 'curated-gr-helleniq-aspropyrgos',
    name: 'HelleniQ Energy Aspropyrgos Refinery',
    country: 'GR',
    role: 'refiner',
    categories: ['crude-oil', 'diesel', 'gasoline', 'jet-fuel'],
    notes:
      'Greek refiner (formerly Hellenic Petroleum), ~150 kbd. Has bought Libyan grades historically.',
    aliases: ['Hellenic Petroleum Aspropyrgos', 'HELPE Aspropyrgos'],
    tags: ['refinery', 'region:mediterranean', 'private', 'libya-historic'],
    metadata: { capacity_bpd: 150_000, operator: 'HelleniQ Energy' },
  },
  {
    slug: 'curated-hu-mol-szazhalombatta',
    name: 'MOL Százhalombatta (Danube) Refinery',
    country: 'HU',
    role: 'refiner',
    categories: ['crude-oil', 'diesel', 'gasoline', 'jet-fuel'],
    notes:
      'Hungary, ~160 kbd. Pipeline-fed (Druzhba) historically; diversification post-Ukraine has them sourcing seaborne via Croatian Adria pipeline. Mediterranean sweets are a real candidate stream.',
    aliases: ['MOL Danube', 'Danube refinery'],
    tags: ['refinery', 'region:mediterranean', 'private', 'urals-substitute-watch'],
    metadata: { capacity_bpd: 160_000, operator: 'MOL' },
  },
  {
    slug: 'curated-at-omv-schwechat',
    name: 'OMV Schwechat Refinery',
    country: 'AT',
    role: 'refiner',
    categories: ['crude-oil', 'diesel', 'gasoline', 'jet-fuel'],
    notes:
      'Austria, ~200 kbd. Inland; fed via Trans-Alpine Pipeline from Trieste. Sweet-crude runner.',
    aliases: ['OMV Schwechat'],
    tags: ['refinery', 'region:mediterranean', 'private'],
    metadata: { capacity_bpd: 200_000, operator: 'OMV' },
  },
];

/**
 * Indian state refiners — the public-tender-visible buyer pool.
 * IOCL / BPCL / HPCL / MRPL all publish spot crude tenders that
 * Mediterranean grades (including Libyan sweets) regularly compete in.
 */
const INDIAN_STATE_REFINERS: Seed[] = [
  {
    slug: 'curated-in-iocl-paradip',
    name: 'IOCL Paradip Refinery',
    country: 'IN',
    role: 'refiner',
    categories: ['crude-oil', 'diesel', 'gasoline', 'jet-fuel'],
    notes:
      'IOCL east-coast complex, 300 kbd. India\'s most complex single train. Buys via IOCL crude tenders (eproc.iocl.com); Mediterranean sweets compete with Russian Urals + West African grades. PUBLIC TENDER VISIBLE.',
    aliases: ['IOCL Paradip', 'Indian Oil Paradip'],
    tags: ['refinery', 'region:asia-state', 'public-tender-visible', 'sweet-crude-runner'],
    metadata: { capacity_bpd: 300_000, operator: 'Indian Oil Corporation' },
  },
  {
    slug: 'curated-in-iocl-panipat',
    name: 'IOCL Panipat Refinery',
    country: 'IN',
    role: 'refiner',
    categories: ['crude-oil', 'diesel', 'gasoline'],
    notes:
      'IOCL inland complex, ~300 kbd. Pipeline-fed from Mundra/Vadinar terminals. Public tender buyer.',
    aliases: ['IOCL Panipat'],
    tags: ['refinery', 'region:asia-state', 'public-tender-visible'],
    metadata: { capacity_bpd: 300_000, operator: 'Indian Oil Corporation' },
  },
  {
    slug: 'curated-in-bpcl-mumbai',
    name: 'BPCL Mumbai Refinery',
    country: 'IN',
    role: 'refiner',
    categories: ['crude-oil', 'diesel', 'gasoline', 'jet-fuel'],
    notes:
      'BPCL flagship, ~240 kbd. Active spot crude buyer. Tenders via BPCL e-procurement.',
    aliases: ['BPCL Mumbai', 'Bharat Petroleum Mumbai'],
    tags: ['refinery', 'region:asia-state', 'public-tender-visible'],
    metadata: { capacity_bpd: 240_000, operator: 'Bharat Petroleum' },
  },
  {
    slug: 'curated-in-bpcl-kochi',
    name: 'BPCL Kochi Refinery',
    country: 'IN',
    role: 'refiner',
    categories: ['crude-oil', 'diesel', 'gasoline', 'jet-fuel'],
    notes:
      'BPCL south-India, 310 kbd. Coastal, easy access for spot Mediterranean cargoes. Public tender buyer.',
    aliases: ['BPCL Kochi', 'Kochi Refinery'],
    tags: ['refinery', 'region:asia-state', 'public-tender-visible', 'sweet-crude-runner'],
    metadata: { capacity_bpd: 310_000, operator: 'Bharat Petroleum' },
  },
  {
    slug: 'curated-in-hpcl-mumbai',
    name: 'HPCL Mumbai Refinery',
    country: 'IN',
    role: 'refiner',
    categories: ['crude-oil', 'diesel', 'gasoline'],
    notes:
      'HPCL Mahul, ~190 kbd. Spot crude tenders public.',
    aliases: ['HPCL Mahul', 'HPCL Mumbai'],
    tags: ['refinery', 'region:asia-state', 'public-tender-visible'],
    metadata: { capacity_bpd: 190_000, operator: 'Hindustan Petroleum' },
  },
  {
    slug: 'curated-in-hpcl-visakh',
    name: 'HPCL Visakhapatnam Refinery',
    country: 'IN',
    role: 'refiner',
    categories: ['crude-oil', 'diesel', 'gasoline', 'jet-fuel'],
    notes:
      'HPCL east coast, 165 kbd (expanding). Public tender buyer.',
    aliases: ['HPCL Visakh', 'HPCL Vizag'],
    tags: ['refinery', 'region:asia-state', 'public-tender-visible'],
    metadata: { capacity_bpd: 165_000, operator: 'Hindustan Petroleum' },
  },
  {
    slug: 'curated-in-mrpl-mangalore',
    name: 'MRPL Mangalore Refinery',
    country: 'IN',
    role: 'refiner',
    categories: ['crude-oil', 'diesel', 'gasoline', 'jet-fuel'],
    notes:
      'Mangalore Refinery & Petrochemicals, ONGC subsidiary, 300 kbd. Coastal, designed for sour crude but flexible. Spot tenders public.',
    aliases: ['MRPL'],
    tags: ['refinery', 'region:asia-state', 'public-tender-visible'],
    metadata: { capacity_bpd: 300_000, operator: 'MRPL (ONGC)' },
  },
  {
    slug: 'curated-in-reliance-jamnagar',
    name: 'Reliance Jamnagar Refinery',
    country: 'IN',
    role: 'refiner',
    categories: ['crude-oil', 'diesel', 'gasoline', 'jet-fuel'],
    notes:
      'World\'s largest single-site refining complex, ~1.36 mbd combined. PRIVATE — Reliance Industries. Does NOT tender publicly. Crude sourcing managed via Reliance trading + relationships. Reach via direct corporate contact only.',
    aliases: ['Reliance Jamnagar', 'RIL Jamnagar'],
    tags: ['refinery', 'region:asia-state', 'private', 'mega-complex'],
    metadata: { capacity_bpd: 1_360_000, operator: 'Reliance Industries' },
  },
];

const OTHER_ASIAN_STATE_REFINERS: Seed[] = [
  {
    slug: 'curated-id-pertamina-cilacap',
    name: 'Pertamina Cilacap Refinery',
    country: 'ID',
    role: 'refiner',
    categories: ['crude-oil', 'diesel', 'gasoline', 'jet-fuel'],
    notes: 'Indonesia\'s largest, 348 kbd. Pertamina holds public crude tenders.',
    aliases: ['Pertamina Cilacap', 'Cilacap refinery'],
    tags: ['refinery', 'region:asia-state', 'public-tender-visible'],
    metadata: { capacity_bpd: 348_000, operator: 'Pertamina' },
  },
  {
    slug: 'curated-pk-pso-karachi',
    name: 'Pakistan State Oil (importing entity)',
    country: 'PK',
    role: 'state-buyer',
    categories: ['crude-oil', 'diesel', 'gasoline', 'jet-fuel'],
    notes: 'State oil marketing company. Imports via tender; not a refinery itself but a major procurement entity.',
    aliases: ['PSO', 'Pakistan State Oil'],
    tags: ['state-buyer', 'region:asia-state', 'public-tender-visible'],
    metadata: { operator: 'PSO' },
  },
  {
    slug: 'curated-bd-bpc-chittagong',
    name: 'Eastern Refinery (BPC)',
    country: 'BD',
    role: 'refiner',
    categories: ['crude-oil', 'diesel', 'gasoline'],
    notes:
      'Bangladesh Petroleum Corporation subsidiary, ~33 kbd. Small but consistent tender buyer.',
    aliases: ['Eastern Refinery Chittagong', 'BPC Eastern Refinery'],
    tags: ['refinery', 'region:asia-state', 'public-tender-visible'],
    metadata: { capacity_bpd: 33_000, operator: 'Eastern Refinery (BPC)' },
  },
  {
    slug: 'curated-lk-cpc-sapugaskanda',
    name: 'CPC Sapugaskanda Refinery',
    country: 'LK',
    role: 'refiner',
    categories: ['crude-oil', 'diesel', 'gasoline'],
    notes: 'Ceylon Petroleum Corporation, ~50 kbd. Public tender buyer.',
    aliases: ['Sapugaskanda', 'CPC Sri Lanka'],
    tags: ['refinery', 'region:asia-state', 'public-tender-visible'],
    metadata: { capacity_bpd: 50_000, operator: 'Ceylon Petroleum Corp.' },
  },
  {
    slug: 'curated-th-ptt-rayong',
    name: 'PTT Sriracha Refinery (Thai Oil)',
    country: 'TH',
    role: 'refiner',
    categories: ['crude-oil', 'diesel', 'gasoline', 'jet-fuel'],
    notes: 'Thai Oil, PTT-owned, ~275 kbd. Public-listed; some tender visibility.',
    aliases: ['Thai Oil Sriracha', 'Thaioil'],
    tags: ['refinery', 'region:asia-state'],
    metadata: { capacity_bpd: 275_000, operator: 'Thai Oil (PTT)' },
  },
  {
    slug: 'curated-vn-bsr-dung-quat',
    name: 'BSR Dung Quat Refinery',
    country: 'VN',
    role: 'refiner',
    categories: ['crude-oil', 'diesel', 'gasoline'],
    notes: 'Binh Son Refining, Vietnam, ~145 kbd. Petrovietnam subsidiary; tenders visible via PetroVietnam.',
    aliases: ['BSR Dung Quat', 'Binh Son'],
    tags: ['refinery', 'region:asia-state'],
    metadata: { capacity_bpd: 145_000, operator: 'BSR (PetroVietnam)' },
  },
];

const TRADING_HOUSES: Seed[] = [
  {
    slug: 'curated-ch-vitol-geneva',
    name: 'Vitol',
    country: 'CH',
    role: 'trader',
    categories: ['crude-oil', 'diesel', 'gasoline', 'jet-fuel', 'marine-bunker'],
    notes:
      'World\'s largest independent oil trader. Active Libyan crude desk. Outreach via crude trading desk in Geneva or London. Vitol Saras JV (2024) gives them Italian refining footprint.',
    aliases: ['Vitol Group', 'Vitol SA'],
    tags: ['trader', 'libya-active', 'top-tier'],
    metadata: { headquarters: 'Geneva' },
  },
  {
    slug: 'curated-ch-glencore-baar',
    name: 'Glencore',
    country: 'CH',
    role: 'trader',
    categories: ['crude-oil', 'diesel', 'gasoline', 'jet-fuel'],
    notes: 'Major global oil trading + production house. Active in Libyan flows historically.',
    aliases: ['Glencore International'],
    tags: ['trader', 'libya-historic', 'top-tier'],
    metadata: { headquarters: 'Baar, Switzerland' },
  },
  {
    slug: 'curated-sg-trafigura',
    name: 'Trafigura',
    country: 'SG',
    role: 'trader',
    categories: ['crude-oil', 'diesel', 'gasoline', 'jet-fuel'],
    notes:
      'Global commodities house. Crude trading desk in Geneva + Singapore. Often counterparty on Mediterranean spot.',
    aliases: ['Trafigura Group', 'Trafigura Pte Ltd'],
    tags: ['trader', 'top-tier'],
    metadata: { headquarters: 'Singapore (legal); operations: Geneva' },
  },
  {
    slug: 'curated-ch-mercuria-geneva',
    name: 'Mercuria Energy Group',
    country: 'CH',
    role: 'trader',
    categories: ['crude-oil', 'diesel', 'gasoline'],
    notes: 'Geneva-based trader, mid-tier on crude volumes vs Vitol/Glencore but consistent Mediterranean activity.',
    aliases: ['Mercuria'],
    tags: ['trader'],
    metadata: { headquarters: 'Geneva' },
  },
  {
    slug: 'curated-ch-gunvor-geneva',
    name: 'Gunvor Group',
    country: 'CH',
    role: 'trader',
    categories: ['crude-oil', 'diesel'],
    notes: 'Geneva trader, refinery owner (Rotterdam, Antwerp). Crude desk active in sweets.',
    aliases: ['Gunvor'],
    tags: ['trader'],
    metadata: { headquarters: 'Geneva' },
  },
];

const ALL_SEEDS: Seed[] = [
  ...MEDITERRANEAN_REFINERS,
  ...INDIAN_STATE_REFINERS,
  ...OTHER_ASIAN_STATE_REFINERS,
  ...TRADING_HOUSES,
];

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');

  const client = neon(url);
  const db = drizzle(client, { schema, casing: 'snake_case' });

  console.log(`Seeding ${ALL_SEEDS.length} known entities...`);
  for (const s of ALL_SEEDS) {
    await db
      .insert(schema.knownEntities)
      .values({
        slug: s.slug,
        name: s.name,
        country: s.country,
        role: s.role,
        categories: s.categories,
        notes: s.notes,
        aliases: s.aliases ?? [s.name],
        tags: s.tags ?? [],
        metadata: { source: 'curated', ...(s.metadata ?? {}) },
      })
      .onConflictDoUpdate({
        target: schema.knownEntities.slug,
        set: {
          name: s.name,
          country: s.country,
          role: s.role,
          categories: s.categories,
          notes: s.notes,
          aliases: s.aliases ?? [s.name],
          tags: s.tags ?? [],
          metadata: { source: 'curated', ...(s.metadata ?? {}) },
          updatedAt: new Date(),
        },
      });
  }
  console.log('Done.');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
