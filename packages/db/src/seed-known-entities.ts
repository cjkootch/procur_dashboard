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
import { findOrUpsertEntity } from './lib/find-or-upsert-entity';

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
  /** WGS84 decimal degrees. For physical-asset entities (refineries,
   *  ports). Null for entities without a canonical location. */
  latitude?: number;
  longitude?: number;
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
    latitude: 45.0844,
    longitude: 8.9094,
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
    latitude: 40.4707,
    longitude: 17.2106,
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
    latitude: 37.1683,
    longitude: 15.1819,
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
    latitude: 39.0628,
    longitude: 9.0131,
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
    latitude: 37.5786,
    longitude: -1.0117,
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
    latitude: 43.3625,
    longitude: -3.1097,
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
    latitude: 40.7833,
    longitude: 29.9,
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
    latitude: 38.0628,
    longitude: 23.5972,
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
    latitude: 47.3267,
    longitude: 18.9264,
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
    latitude: 48.13,
    longitude: 16.49,
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
    latitude: 20.2667,
    longitude: 86.6889,
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
    latitude: 29.3897,
    longitude: 76.9594,
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
    latitude: 19.0269,
    longitude: 72.8964,
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
    latitude: 9.9747,
    longitude: 76.2683,
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
    latitude: 19.0269,
    longitude: 72.8964,
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
    latitude: 17.7167,
    longitude: 83.2167,
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
    latitude: 12.9667,
    longitude: 74.9,
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
    latitude: 22.425,
    longitude: 69.65,
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
    latitude: -7.7167,
    longitude: 109.0167,
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
    latitude: 24.8607,
    longitude: 67.0011,
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
    latitude: 22.2167,
    longitude: 91.7833,
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
    latitude: 6.9892,
    longitude: 79.9356,
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
    latitude: 13.15,
    longitude: 100.9833,
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
    latitude: 15.4,
    longitude: 108.7,
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
    tags: ['trader', 'libya-active', 'top-tier', 'competitor'],
    metadata: { headquarters: 'Geneva' },
    latitude: 46.2044,
    longitude: 6.1432,
  },
  {
    slug: 'curated-ch-glencore-baar',
    name: 'Glencore',
    country: 'CH',
    role: 'trader',
    categories: ['crude-oil', 'diesel', 'gasoline', 'jet-fuel'],
    notes: 'Major global oil trading + production house. Active in Libyan flows historically.',
    aliases: ['Glencore International'],
    tags: ['trader', 'libya-historic', 'top-tier', 'competitor'],
    metadata: { headquarters: 'Baar, Switzerland' },
    latitude: 47.1947,
    longitude: 8.5247,
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
    tags: ['trader', 'top-tier', 'competitor'],
    metadata: { headquarters: 'Singapore (legal); operations: Geneva' },
    latitude: 1.3521,
    longitude: 103.8198,
  },
  {
    slug: 'curated-ch-mercuria-geneva',
    name: 'Mercuria Energy Group',
    country: 'CH',
    role: 'trader',
    categories: ['crude-oil', 'diesel', 'gasoline'],
    notes: 'Geneva-based trader, mid-tier on crude volumes vs Vitol/Glencore but consistent Mediterranean activity.',
    aliases: ['Mercuria'],
    tags: ['trader', 'competitor'],
    metadata: { headquarters: 'Geneva' },
    latitude: 46.2044,
    longitude: 6.1432,
  },
  {
    slug: 'curated-ch-gunvor-geneva',
    name: 'Gunvor Group',
    country: 'CH',
    role: 'trader',
    categories: ['crude-oil', 'diesel'],
    notes: 'Geneva trader, refinery owner (Rotterdam, Antwerp). Crude desk active in sweets.',
    aliases: ['Gunvor'],
    tags: ['trader', 'competitor'],
    metadata: { headquarters: 'Geneva' },
    latitude: 46.2044,
    longitude: 6.1432,
  },
  // ── Tier 2 + state-affiliated competitors ─────────────────────────
  {
    slug: 'curated-us-cci-stamford',
    name: 'Castleton Commodities International',
    country: 'US',
    role: 'trader',
    categories: ['crude-oil', 'diesel', 'gasoline', 'lpg', 'jet-fuel'],
    notes:
      'Stamford-based merchant trader spun out of Louis Dreyfus + Highbridge. Active North American crude + product, increasingly cross-Atlantic. Mid-tier volume; known for nimble structured deals.',
    aliases: ['CCI', 'Castleton'],
    tags: ['trader', 'competitor', 'mid-tier'],
    metadata: { headquarters: 'Stamford, CT' },
    latitude: 41.0534,
    longitude: -73.5387,
  },
  {
    slug: 'curated-us-hartree-greenwich',
    name: 'Hartree Partners',
    country: 'US',
    role: 'trader',
    categories: ['crude-oil', 'diesel', 'gasoline', 'lpg'],
    notes:
      'Greenwich, CT physical commodities merchant focused on petroleum + natural gas. Owns Sprague Resources downstream footprint. Aggressive on US Gulf + Latin American flows.',
    aliases: ['Hartree'],
    tags: ['trader', 'competitor', 'mid-tier'],
    metadata: { headquarters: 'Greenwich, CT' },
    latitude: 41.0262,
    longitude: -73.6282,
  },
  {
    slug: 'curated-de-mabanaft-hamburg',
    name: 'Mabanaft',
    country: 'DE',
    role: 'trader',
    categories: ['diesel', 'gasoline', 'jet-fuel', 'marine-bunker'],
    notes:
      'Marquard & Bahls subsidiary; major European mid-distillate trader. Strong Med + Atlantic basin product flows. Distinct from the parent\'s storage business (Oiltanking).',
    aliases: ['Marquard & Bahls', 'Mabanaft GmbH'],
    tags: ['trader', 'competitor', 'mid-tier'],
    metadata: { headquarters: 'Hamburg' },
    latitude: 53.5511,
    longitude: 9.9937,
  },
  {
    slug: 'curated-us-freepoint-stamford',
    name: 'Freepoint Commodities',
    country: 'US',
    role: 'trader',
    categories: ['crude-oil', 'diesel', 'gasoline'],
    notes:
      'Stamford-based merchant trader. Active US Gulf + Latin American crude / refined product flows. Smaller than CCI but with good Latin American counterparty network.',
    aliases: ['Freepoint'],
    tags: ['trader', 'competitor', 'mid-tier'],
    metadata: { headquarters: 'Stamford, CT' },
    latitude: 41.0534,
    longitude: -73.5387,
  },
  {
    slug: 'curated-ch-litasco-geneva',
    name: 'Litasco',
    country: 'CH',
    role: 'trader',
    categories: ['crude-oil', 'diesel', 'gasoline'],
    notes:
      'Lukoil\'s international trading arm. Geneva HQ. Sanctions-era footprint reduced but still relevant for non-Russian flows + legacy term contracts.',
    aliases: ['Litasco SA', 'Lukoil International Trading'],
    tags: ['trader', 'competitor', 'state-affiliated'],
    metadata: { headquarters: 'Geneva', parentEntity: 'Lukoil' },
    latitude: 46.2044,
    longitude: 6.1432,
  },
  {
    slug: 'curated-ch-socar-trading-geneva',
    name: 'SOCAR Trading',
    country: 'CH',
    role: 'trader',
    categories: ['crude-oil', 'diesel', 'gasoline'],
    notes:
      'State Oil Company of Azerbaijan trading arm; Geneva HQ. Primary outlet for Azeri Light (BTC) crude. Active counterparty for Mediterranean + Black Sea refiners.',
    aliases: ['SOCAR', 'SOCAR Trading SA'],
    tags: ['trader', 'competitor', 'state-affiliated', 'azeri-light-active'],
    metadata: { headquarters: 'Geneva', parentEntity: 'SOCAR' },
    latitude: 46.2044,
    longitude: 6.1432,
  },
  {
    slug: 'curated-cn-unipec-beijing',
    name: 'Unipec',
    country: 'CN',
    role: 'trader',
    categories: ['crude-oil', 'diesel', 'gasoline'],
    notes:
      'Sinopec\'s trading subsidiary; world\'s largest crude buyer by volume. Routes Chinese demand for Atlantic-basin sweet crude (incl. Libyan grades historically). Hong Kong + Singapore desks.',
    aliases: ['China International United Petroleum', 'UNIPEC'],
    tags: ['trader', 'competitor', 'state-affiliated', 'top-tier'],
    metadata: { headquarters: 'Beijing', parentEntity: 'Sinopec' },
    latitude: 39.9042,
    longitude: 116.4074,
  },
  {
    slug: 'curated-ch-sonatrach-trading-geneva',
    name: 'Sonatrach Trading',
    country: 'CH',
    role: 'trader',
    categories: ['crude-oil', 'diesel', 'gasoline', 'jet-fuel', 'lng'],
    notes:
      "Sonatrach's international marketing arm — primary counterparty for Saharan Blend off-take, Algerian Condensate, and product exports out of Skikda/Arzew. Geneva HQ. When asked 'who do you sign the term contract with for Algerian crude', this is the entity, not upstream Sonatrach.",
    aliases: ['Sonatrach Trading SAS', 'STSA'],
    tags: ['trader', 'state-affiliated', 'saharan-blend-active', 'mediterranean'],
    metadata: { headquarters: 'Geneva', parentEntity: 'Sonatrach' },
    latitude: 46.2044,
    longitude: 6.1432,
  },
];

/**
 * African refiners — West / East / North / Southern Africa refineries
 * relevant to the lane VTC trades. Capacity figures are public-knowledge
 * approximations in barrels per day. Coordinates are the operating-unit
 * centroid; geofence overlap with the corresponding seed-ports.ts entry
 * is intentional so vessel activity attributes correctly.
 *
 * Without this curated set, lookup_known_entities for African refining
 * returns OSM noise (mis-tagged power plants, etc) instead of the
 * actual export-capable refineries operators care about.
 */
const AFRICAN_REFINERS: Seed[] = [
  // ── West Africa ────────────────────────────────────────────
  {
    slug: 'curated-ng-dangote-lekki',
    name: 'Dangote Refinery',
    country: 'NG',
    role: 'refiner',
    categories: ['crude-oil', 'diesel', 'gasoline', 'jet-fuel'],
    notes:
      "World's largest single-train refinery. ~650 kbd at Lekki Free Trade Zone, commissioned 2024. Privately owned by Aliko Dangote. Game-changer for West African product flows — was historically a refined-product importer; Dangote inverts that. Now exports diesel/jet to Europe + Americas, displacing some EU/USGC barrels into West Africa.",
    aliases: ['Dangote Petroleum Refinery', 'Dangote Oil Refining Company'],
    tags: ['refinery', 'private', 'west-africa', 'sweet-crude-runner', 'top-tier'],
    metadata: { capacity_bpd: 650000, operator: 'Dangote Group', city: 'Lekki' },
    latitude: 6.45,
    longitude: 3.7,
  },
  {
    slug: 'curated-ng-port-harcourt-nnpc',
    name: 'Port Harcourt Refinery (NNPC)',
    country: 'NG',
    role: 'refiner',
    categories: ['crude-oil', 'diesel', 'gasoline', 'jet-fuel'],
    notes:
      'NNPC-owned, 210 kbd nameplate (two trains, 60 + 150 kbd). Decades-long underperformer; partial rehab brought one train back online late 2024. Historically a notional capacity that didn\'t produce — Nigeria imported gasoline despite owning this asset.',
    aliases: ['PHRC', 'Port Harcourt Refining Company'],
    tags: ['refinery', 'state', 'west-africa', 'underutilized'],
    metadata: { capacity_bpd: 210000, operator: 'NNPC' },
    latitude: 4.7,
    longitude: 7.0,
  },
  {
    slug: 'curated-ng-warri-nnpc',
    name: 'Warri Refinery (NNPC)',
    country: 'NG',
    role: 'refiner',
    categories: ['crude-oil', 'diesel', 'gasoline', 'jet-fuel'],
    notes:
      'NNPC-owned, ~125 kbd. Mostly idle for years; rehab completion announced multiple times. Treat as not-running until verified.',
    aliases: ['WRPC', 'Warri Refining and Petrochemical Company'],
    tags: ['refinery', 'state', 'west-africa', 'underutilized'],
    metadata: { capacity_bpd: 125000, operator: 'NNPC' },
    latitude: 5.5,
    longitude: 5.7,
  },
  {
    slug: 'curated-ng-indorama-eleme',
    name: 'Indorama Eleme Petrochemicals',
    country: 'NG',
    role: 'refiner',
    categories: ['diesel', 'gasoline', 'lpg'],
    notes:
      'Private petrochemicals + refining complex near Port Harcourt. ~210 kbd capacity claimed; primarily fertilizer + olefins, with some refined-product output. Indorama Group (Singapore parent).',
    tags: ['refinery', 'private', 'west-africa', 'petrochem'],
    metadata: { operator: 'Indorama Corporation' },
    latitude: 4.83,
    longitude: 7.13,
  },
  {
    slug: 'curated-gh-tema-tor',
    name: 'Tema Oil Refinery',
    country: 'GH',
    role: 'refiner',
    categories: ['crude-oil', 'diesel', 'gasoline', 'jet-fuel'],
    notes:
      "TOR — Ghana's only refinery, ~45 kbd. State-owned. Frequently offline for maintenance / cash-flow reasons; Ghana imports most refined products through Tema port.",
    aliases: ['TOR'],
    tags: ['refinery', 'state', 'west-africa', 'underutilized'],
    metadata: { capacity_bpd: 45000, operator: 'Tema Oil Refinery Ltd' },
    latitude: 5.6386,
    longitude: -0.0181,
  },
  {
    slug: 'curated-sn-sar-dakar',
    name: 'Société Africaine de Raffinage (SAR)',
    country: 'SN',
    role: 'refiner',
    categories: ['crude-oil', 'diesel', 'gasoline', 'jet-fuel'],
    notes:
      "Senegal's sole refinery, ~27 kbd at Mbao (Dakar). State + private mix (Petrosen, Total, Saudi Binladin). Senegal's GTA gas project may shift dynamics; refinery itself remains small and product-import-supplemented.",
    aliases: ['SAR', 'Refinery of Mbao'],
    tags: ['refinery', 'mixed-ownership', 'west-africa'],
    metadata: { capacity_bpd: 27000, operator: 'SAR' },
    latitude: 14.7589,
    longitude: -17.32,
  },
  {
    slug: 'curated-ao-sonangol-luanda',
    name: 'Sonangol Luanda Refinery',
    country: 'AO',
    role: 'refiner',
    categories: ['crude-oil', 'diesel', 'gasoline', 'jet-fuel'],
    notes:
      "Sonangol-operated, ~65 kbd at Luanda. Angola's only operating refinery; Lobito refinery is announced but not commissioned. Domestic-market biased.",
    aliases: ['Refinaria de Luanda'],
    tags: ['refinery', 'state', 'west-africa'],
    metadata: { capacity_bpd: 65000, operator: 'Sonangol' },
    latitude: -8.78,
    longitude: 13.38,
  },

  // ── Southern Africa ────────────────────────────────────────
  {
    slug: 'curated-za-sapref',
    name: 'SAPREF Refinery',
    country: 'ZA',
    role: 'refiner',
    categories: ['crude-oil', 'diesel', 'gasoline', 'jet-fuel'],
    notes:
      "Largest refinery in southern Africa — 180 kbd at Durban. Originally Shell/BP 50/50 JV; idle since 2022 force majeure, sold to state-affiliated CEF in 2024 with restart pending. Was the main South African import-substitution buffer.",
    aliases: ['South African Petroleum Refineries'],
    tags: ['refinery', 'southern-africa', 'idle', 'restart-watch'],
    metadata: { capacity_bpd: 180000, operator: 'CEF (state)', former_operators: 'Shell, BP' },
    latitude: -29.94,
    longitude: 30.99,
  },
  {
    slug: 'curated-za-engen-durban',
    name: 'Engen Durban Refinery',
    country: 'ZA',
    role: 'refiner',
    categories: ['crude-oil', 'diesel', 'gasoline', 'jet-fuel'],
    notes:
      'Engen-operated, ~135 kbd at Durban. Idle since 2020 fire; restart uncertain. Engen majority-owned by Vivo Energy / Vitol.',
    tags: ['refinery', 'southern-africa', 'idle'],
    metadata: { capacity_bpd: 135000, operator: 'Engen', parent: 'Vivo Energy / Vitol' },
    latitude: -29.92,
    longitude: 31.02,
  },
  {
    slug: 'curated-za-natref',
    name: 'Natref Refinery',
    country: 'ZA',
    role: 'refiner',
    categories: ['crude-oil', 'diesel', 'gasoline'],
    notes:
      'National Petroleum Refiners — 108 kbd at Sasolburg, inland. Sasol/TotalEnergies JV. South Africa\'s only inland crude refinery, fed by Durban-Johannesburg pipeline.',
    aliases: ['National Petroleum Refiners of South Africa'],
    tags: ['refinery', 'southern-africa', 'inland'],
    metadata: { capacity_bpd: 108000, operator: 'Sasol / TotalEnergies' },
    latitude: -26.83,
    longitude: 27.83,
  },
  {
    slug: 'curated-za-petrosa-mossel-bay',
    name: 'PetroSA Mossel Bay GTL',
    country: 'ZA',
    role: 'refiner',
    categories: ['diesel', 'gasoline', 'jet-fuel'],
    notes:
      "PetroSA-operated 45 kbd GTL (gas-to-liquids) facility at Mossel Bay, Western Cape. Fed by offshore Mossgas; gas reserves declining and unit running below nameplate. Strategic but small.",
    tags: ['refinery', 'southern-africa', 'gtl', 'state'],
    metadata: { capacity_bpd: 45000, operator: 'PetroSA' },
    latitude: -34.18,
    longitude: 22.15,
  },

  // ── North Africa ───────────────────────────────────────────
  {
    slug: 'curated-dz-sonatrach-skikda',
    name: 'Sonatrach Skikda Refinery',
    country: 'DZ',
    role: 'refiner',
    categories: ['crude-oil', 'diesel', 'gasoline', 'jet-fuel'],
    notes:
      "Sonatrach-operated, 350 kbd at Skikda — Africa's largest refinery export complex. Configured for Mediterranean gasoline/diesel export to Europe. Algeria's primary downstream asset.",
    aliases: ['Skikda Refinery'],
    tags: ['refinery', 'state', 'north-africa', 'mediterranean', 'export-oriented', 'top-tier'],
    metadata: { capacity_bpd: 350000, operator: 'Sonatrach' },
    latitude: 36.88,
    longitude: 6.90,
  },
  {
    slug: 'curated-dz-sonatrach-arzew',
    name: 'Sonatrach Arzew Refinery',
    country: 'DZ',
    role: 'refiner',
    categories: ['crude-oil', 'diesel', 'gasoline'],
    notes:
      'Sonatrach-operated ~60 kbd refinery at Arzew, Mediterranean coast. Adjacent to large LNG complex; product-export oriented but smaller than Skikda.',
    tags: ['refinery', 'state', 'north-africa', 'mediterranean'],
    metadata: { capacity_bpd: 60000, operator: 'Sonatrach' },
    latitude: 35.85,
    longitude: -0.32,
  },
  {
    slug: 'curated-ma-samir-mohammedia',
    name: 'Samir Mohammedia Refinery',
    country: 'MA',
    role: 'refiner',
    categories: ['crude-oil', 'diesel', 'gasoline', 'jet-fuel'],
    notes:
      "Samir — Morocco's only refinery, ~200 kbd at Mohammedia. Idle since 2015 bankruptcy; assets in liquidation but restart bids periodically surface. Morocco currently imports all refined products.",
    aliases: ['Société Anonyme Marocaine de l\'Industrie de Raffinage'],
    tags: ['refinery', 'north-africa', 'idle', 'restart-watch'],
    metadata: { capacity_bpd: 200000, operator: 'Samir (in liquidation)' },
    latitude: 33.69,
    longitude: -7.39,
  },
];

const ALL_SEEDS: Seed[] = [
  ...MEDITERRANEAN_REFINERS,
  ...AFRICAN_REFINERS,
  ...INDIAN_STATE_REFINERS,
  ...OTHER_ASIAN_STATE_REFINERS,
  ...TRADING_HOUSES,
];

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');

  const client = neon(url);
  const db = drizzle(client, { schema, casing: 'snake_case' });

  console.log(`Seeding ${ALL_SEEDS.length} known entities (curated source — highest priority)...`);
  let inserted = 0;
  let merged = 0;
  for (const s of ALL_SEEDS) {
    const result = await findOrUpsertEntity(db, {
      slug: s.slug,
      source: 'curated',
      name: s.name,
      country: s.country,
      role: s.role,
      categories: s.categories,
      notes: s.notes,
      aliases: s.aliases ?? [s.name],
      tags: s.tags ?? [],
      latitude: s.latitude ?? null,
      longitude: s.longitude ?? null,
      metadata: s.metadata ?? {},
    });
    if (result.outcome === 'inserted') inserted += 1;
    else merged += 1;
  }
  console.log(`Done. inserted=${inserted}, merged=${merged} (collapsed onto existing rows from prior ingests).`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
