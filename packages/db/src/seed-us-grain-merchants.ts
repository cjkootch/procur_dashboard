/**
 * Seed: top US grain merchants, millers, processors, and co-ops.
 *
 * USDA does not publish a single "grain merchants" directory — FGIS's
 * OSP Directory lists third-party inspection agencies, not the grain
 * owners themselves. This hand-curated seed fills that gap with the
 * structural US grain industry: the ABCD merchants (ADM / Bunge /
 * Cargill / Louis Dreyfus), the major flour millers (Ardent / Bay
 * State / Grain Craft), the soybean / rice processors (AGP / Riceland),
 * the integrators with massive feed grain demand (Tyson / ConAgra /
 * General Mills), the regional co-ops (CHS / GROWMARK / MFA / Mercer
 * Landmark), and the specialized commercial traders (Scoular / CGB /
 * Lansing).
 *
 * Idempotent on slug — re-running is a no-op for existing entries.
 *
 * After this seeds, the existing crawl pipeline can be pointed at
 * these entities (each has primary_domain set):
 *
 *   pnpm --filter @procur/ai crawl-entity-website --country=US --limit=30
 *
 * Run from repo root:
 *   pnpm --filter @procur/db seed-us-grain-merchants
 *
 * Env:
 *   DATABASE_URL                # required
 */
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from './schema';

loadEnv({ path: '../../.env.local' });
loadEnv({ path: '../../.env' });

interface SeedEntity {
  slug: string;
  name: string;
  /** trader | producer | cooperative | integrator | miller */
  role: string;
  /** Headquarters city, state. Stored in notes; lat/lng intentionally
   *  null (the map fallback uses country centroid). */
  hq: string;
  primaryDomain: string;
  aliases: string[];
  /** From KNOWN_ENTITY_CATEGORIES. Always include 'food-commodities'
   *  as the umbrella so category-list queries hit every seed. */
  categories: string[];
  /** Free-form additional tags beyond the standard provenance set. */
  extraTags: string[];
  notes: string;
}

const SEED: SeedEntity[] = [
  // ── ABCD (the four global grain majors) ─────────────────────────
  {
    slug: 'us-grain-archer-daniels-midland',
    name: 'Archer Daniels Midland Company',
    role: 'trader',
    hq: 'Chicago, IL',
    primaryDomain: 'adm.com',
    aliases: ['ADM', 'Archer Daniels Midland'],
    categories: ['food-commodities', 'corn', 'soybean', 'wheat', 'oilseeds'],
    extraTags: ['grain-major-abcd', 'oilseed-processor'],
    notes:
      'One of the "ABCD" global grain majors. Operations span origination, processing, transportation, and trading of corn, soybeans, wheat, and oilseeds across 200+ countries. HQ Chicago, IL.',
  },
  {
    slug: 'us-grain-bunge',
    name: 'Bunge Global SA',
    role: 'trader',
    hq: 'St. Louis, MO (US ops); Geneva, CH (global HQ)',
    primaryDomain: 'bunge.com',
    aliases: ['Bunge', 'Bunge Limited'],
    categories: ['food-commodities', 'soybean', 'wheat', 'corn', 'oilseeds'],
    extraTags: ['grain-major-abcd', 'oilseed-processor'],
    notes:
      'ABCD global grain major. Leading oilseed processor and grain trader. Merged with Viterra in 2024–2025 forming the largest agribusiness by some metrics. US operations HQ St. Louis.',
  },
  {
    slug: 'us-grain-cargill',
    name: 'Cargill, Incorporated',
    role: 'trader',
    hq: 'Wayzata, MN',
    primaryDomain: 'cargill.com',
    aliases: ['Cargill'],
    categories: ['food-commodities', 'corn', 'soybean', 'wheat', 'beef', 'poultry'],
    extraTags: ['grain-major-abcd', 'integrator', 'private'],
    notes:
      'ABCD global grain major and largest privately held company in the US. Operations in grain origination, processing, animal nutrition, meat, and trading. HQ Wayzata, MN.',
  },
  {
    slug: 'us-grain-louis-dreyfus',
    name: 'Louis Dreyfus Company',
    role: 'trader',
    hq: 'Wilton, CT (US ops); Rotterdam, NL (global HQ)',
    primaryDomain: 'ldc.com',
    aliases: ['LDC', 'Louis Dreyfus'],
    categories: ['food-commodities', 'corn', 'soybean', 'wheat', 'rice', 'cotton'],
    extraTags: ['grain-major-abcd'],
    notes:
      'ABCD global grain major. Founded 1851. Major positions in grains, oilseeds, rice, cotton, coffee, sugar, juice. US HQ Wilton, CT.',
  },

  // ── Major US-based merchants / co-ops ───────────────────────────
  {
    slug: 'us-grain-chs',
    name: 'CHS Inc.',
    role: 'cooperative',
    hq: 'Inver Grove Heights, MN',
    primaryDomain: 'chsinc.com',
    aliases: ['CHS'],
    categories: ['food-commodities', 'corn', 'soybean', 'wheat'],
    extraTags: ['grain-cooperative', 'farmer-owned'],
    notes:
      'Largest US agricultural cooperative — farmer-owned. Grain marketing, oilseed processing, energy / refined fuels, and crop nutrients. ~75 country elevators across the Midwest plus PNW export terminals.',
  },
  {
    slug: 'us-grain-andersons',
    name: 'The Andersons, Inc.',
    role: 'trader',
    hq: 'Maumee, OH',
    primaryDomain: 'andersonsinc.com',
    aliases: ['Andersons'],
    categories: ['food-commodities', 'corn', 'soybean', 'wheat'],
    extraTags: ['publicly-traded'],
    notes:
      'Diversified agribusiness in grain trading, ethanol production, plant nutrients, and rail leasing. NASDAQ:ANDE. HQ Maumee, OH.',
  },
  {
    slug: 'us-grain-cofco-international',
    name: 'COFCO International',
    role: 'trader',
    hq: 'Geneva, CH (US ops in Chicago and Houston)',
    primaryDomain: 'cofcointernational.com',
    aliases: ['COFCO', 'COFCO Agri'],
    categories: ['food-commodities', 'soybean', 'corn', 'wheat'],
    extraTags: ['state-owned-china'],
    notes:
      'Trading arm of China’s state-owned COFCO Group — the largest food company in China. Major US footprint in soybean and corn origination, especially via former Nidera and Noble Agri operations.',
  },
  {
    slug: 'us-grain-continental-grain',
    name: 'Continental Grain Company',
    role: 'trader',
    hq: 'New York, NY',
    primaryDomain: 'contigroup.com',
    aliases: ['Continental Grain', 'ContiGroup'],
    categories: ['food-commodities', 'corn', 'soybean', 'wheat', 'poultry'],
    extraTags: ['private', 'family-owned'],
    notes:
      'Privately held diversified agribusiness; one of the oldest grain trading firms (founded 1813). Major positions in poultry (Wayne-Sanderson) and aquaculture. HQ New York.',
  },
  {
    slug: 'us-grain-scoular',
    name: 'The Scoular Company',
    role: 'trader',
    hq: 'Omaha, NE',
    primaryDomain: 'scoular.com',
    aliases: ['Scoular'],
    categories: ['food-commodities', 'corn', 'soybean', 'wheat'],
    extraTags: ['private', 'employee-owned'],
    notes:
      'Privately held employee-owned commercial grain merchandiser. Footprint in pet food / feed ingredients, food ingredients, and grain trading. ~100 facilities across North America. HQ Omaha, NE.',
  },
  {
    slug: 'us-grain-cgb-enterprises',
    name: 'Consolidated Grain and Barge (CGB Enterprises)',
    role: 'trader',
    hq: 'Mandeville, LA',
    primaryDomain: 'cgb.com',
    aliases: ['CGB', 'Consolidated Grain and Barge'],
    categories: ['food-commodities', 'corn', 'soybean', 'wheat'],
    extraTags: ['mississippi-river-system', 'joint-venture'],
    notes:
      'Joint venture between Zen-Noh (Japan) and Itochu. Major Mississippi / Ohio / Illinois river-system grain originator and barge transporter. HQ Mandeville, LA.',
  },
  {
    slug: 'us-grain-lansing-trade-group',
    name: 'Lansing Trade Group',
    role: 'trader',
    hq: 'Overland Park, KS',
    primaryDomain: 'lansingtradegroup.com',
    aliases: ['Lansing', 'LTG'],
    categories: ['food-commodities', 'corn', 'soybean', 'wheat'],
    extraTags: ['merged'],
    notes:
      'Commercial grain merchandiser; merged with The Andersons’ trade group in 2019. Specialty in physical grain trading + risk management. HQ Overland Park, KS.',
  },

  // ── Major flour millers (structural wheat buyers) ───────────────
  {
    slug: 'us-grain-ardent-mills',
    name: 'Ardent Mills',
    role: 'miller',
    hq: 'Denver, CO',
    primaryDomain: 'ardentmills.com',
    aliases: ['Ardent Mills LLC'],
    categories: ['food-commodities', 'wheat'],
    extraTags: ['joint-venture', 'flour-miller', 'largest-us-flour-miller'],
    notes:
      'Largest flour miller in North America. Joint venture between ConAgra Brands, Cargill, and CHS. ~40 mills + bakery-mix facilities across the US and Canada. HQ Denver, CO.',
  },
  {
    slug: 'us-grain-bay-state-milling',
    name: 'Bay State Milling Company',
    role: 'miller',
    hq: 'Quincy, MA',
    primaryDomain: 'baystatemilling.com',
    aliases: ['Bay State Milling'],
    categories: ['food-commodities', 'wheat'],
    extraTags: ['flour-miller', 'family-owned'],
    notes:
      'Family-owned flour miller since 1899. Specialty in flour, ancient grains, and plant-based ingredients. ~7 mills across the US. HQ Quincy, MA.',
  },
  {
    slug: 'us-grain-grain-craft',
    name: 'Grain Craft',
    role: 'miller',
    hq: 'Chattanooga, TN',
    primaryDomain: 'graincraft.com',
    aliases: ['Grain Craft Inc'],
    categories: ['food-commodities', 'wheat'],
    extraTags: ['flour-miller'],
    notes:
      'Third-largest US flour miller. Formed in 2014 from the merger of Cereal Food Processors, Mennel Milling Company, and Milner Milling. ~15 mills across the US. HQ Chattanooga, TN.',
  },

  // ── Soybean / rice / specialty processors ───────────────────────
  {
    slug: 'us-grain-ag-processing-inc',
    name: 'Ag Processing Inc (AGP)',
    role: 'cooperative',
    hq: 'Omaha, NE',
    primaryDomain: 'agp.com',
    aliases: ['AGP', 'Ag Processing'],
    categories: ['food-commodities', 'soybean', 'oilseeds'],
    extraTags: ['soybean-processor', 'cooperative'],
    notes:
      'Largest cooperative soybean processor in the US. Owned by ~175 local and regional co-ops. Operates 9 crushing plants and produces soybean meal, oil, and refined / biodiesel products. HQ Omaha, NE.',
  },
  {
    slug: 'us-grain-riceland-foods',
    name: 'Riceland Foods, Inc.',
    role: 'cooperative',
    hq: 'Stuttgart, AR',
    primaryDomain: 'riceland.com',
    aliases: ['Riceland'],
    categories: ['food-commodities', 'rice', 'soybean'],
    extraTags: ['rice-processor', 'cooperative'],
    notes:
      'Largest rice miller in the world and largest US rice marketer. Farmer-owned cooperative with ~5,000 members across Arkansas, Missouri, Texas, Louisiana, Oklahoma, and Mississippi. HQ Stuttgart, AR.',
  },

  // ── Integrators (massive feed-grain demand sinks) ───────────────
  {
    slug: 'us-grain-tyson-foods',
    name: 'Tyson Foods, Inc.',
    role: 'integrator',
    hq: 'Springdale, AR',
    primaryDomain: 'tyson.com',
    aliases: ['Tyson'],
    categories: ['food-commodities', 'corn', 'soybean', 'poultry', 'beef', 'pork'],
    extraTags: ['integrator', 'publicly-traded', 'protein-processor'],
    notes:
      'World’s second-largest processor of chicken, beef, and pork. Massive structural buyer of corn and soybean meal for feed operations. NYSE:TSN. HQ Springdale, AR.',
  },
  {
    slug: 'us-grain-conagra-brands',
    name: 'Conagra Brands, Inc.',
    role: 'producer',
    hq: 'Chicago, IL',
    primaryDomain: 'conagrabrands.com',
    aliases: ['ConAgra', 'Conagra'],
    categories: ['food-commodities', 'wheat', 'corn'],
    extraTags: ['packaged-foods', 'publicly-traded'],
    notes:
      'Major US packaged-foods producer. Owns Healthy Choice, Marie Callender’s, Slim Jim, Hunt’s, and many other brands. Ardent Mills JV partner. NYSE:CAG. HQ Chicago, IL.',
  },
  {
    slug: 'us-grain-general-mills',
    name: 'General Mills, Inc.',
    role: 'producer',
    hq: 'Minneapolis, MN',
    primaryDomain: 'generalmills.com',
    aliases: ['General Mills'],
    categories: ['food-commodities', 'wheat', 'corn', 'oilseeds'],
    extraTags: ['packaged-foods', 'publicly-traded', 'cereal-manufacturer'],
    notes:
      'Major US packaged-foods and cereal manufacturer. Brands include Cheerios, Pillsbury, Betty Crocker, Nature Valley. NYSE:GIS. HQ Minneapolis, MN.',
  },
  {
    slug: 'us-grain-hormel-foods',
    name: 'Hormel Foods Corporation',
    role: 'integrator',
    hq: 'Austin, MN',
    primaryDomain: 'hormelfoods.com',
    aliases: ['Hormel'],
    categories: ['food-commodities', 'pork', 'corn', 'soybean'],
    extraTags: ['integrator', 'publicly-traded', 'protein-processor'],
    notes:
      'Major US pork integrator and packaged-meat producer. Owns SPAM, Skippy, Applegate, Jennie-O Turkey. NYSE:HRL. HQ Austin, MN.',
  },
  {
    slug: 'us-grain-kellanova',
    name: 'Kellanova',
    role: 'producer',
    hq: 'Battle Creek, MI',
    primaryDomain: 'kellanova.com',
    aliases: ['Kellanova', "Kellogg's snacks", 'Kellogg'],
    categories: ['food-commodities', 'wheat', 'corn'],
    extraTags: ['packaged-foods', 'publicly-traded', 'cereal-manufacturer'],
    notes:
      'Global snacking + cereal company spun off from Kellogg in 2023. Brands include Pringles, Cheez-It, Eggo, Pop-Tarts, Special K. NYSE:K. HQ Battle Creek, MI.',
  },

  // ── Major regional co-ops ──────────────────────────────────────
  {
    slug: 'us-grain-growmark',
    name: 'GROWMARK, Inc.',
    role: 'cooperative',
    hq: 'Bloomington, IL',
    primaryDomain: 'growmark.com',
    aliases: ['GROWMARK', 'FS System'],
    categories: ['food-commodities', 'corn', 'soybean', 'wheat'],
    extraTags: ['cooperative', 'regional', 'fs-brand'],
    notes:
      'Regional agricultural cooperative serving the upper Midwest, Ontario, and the Great Lakes region. Grain, agronomy, energy, and risk management for ~250 local FS-brand member co-ops. HQ Bloomington, IL.',
  },
  {
    slug: 'us-grain-mfa-incorporated',
    name: 'MFA Incorporated',
    role: 'cooperative',
    hq: 'Columbia, MO',
    primaryDomain: 'mfa-inc.com',
    aliases: ['MFA'],
    categories: ['food-commodities', 'corn', 'soybean', 'wheat'],
    extraTags: ['cooperative', 'regional'],
    notes:
      'Regional farmer-owned cooperative serving Missouri, Arkansas, Iowa, and surrounding states. Grain origination, agronomy, feed, and animal health. HQ Columbia, MO.',
  },
  {
    slug: 'us-grain-mercer-landmark',
    name: 'Mercer Landmark, Inc.',
    role: 'cooperative',
    hq: 'Mercer, OH',
    primaryDomain: 'mercerlandmark.com',
    aliases: ['Mercer Landmark'],
    categories: ['food-commodities', 'corn', 'soybean', 'wheat'],
    extraTags: ['cooperative', 'regional'],
    notes:
      'Regional farmer-owned cooperative covering Ohio, Indiana, and parts of Michigan. ~50 grain elevators + agronomy and energy services. HQ Mercer, OH.',
  },
  {
    slug: 'us-grain-land-o-lakes',
    name: "Land O'Lakes, Inc.",
    role: 'cooperative',
    hq: 'Arden Hills, MN',
    primaryDomain: 'landolakes.com',
    aliases: ["Land O'Lakes", 'WinField United'],
    categories: ['food-commodities', 'dairy', 'corn', 'soybean'],
    extraTags: ['cooperative', 'dairy', 'feed'],
    notes:
      'Major US farmer-owned cooperative — dairy, feed (Purina Animal Nutrition), and crop inputs (WinField United). One of the largest dairy and feed operators in the US. HQ Arden Hills, MN.',
  },

  // ── Specialty / international with strong US presence ───────────
  {
    slug: 'us-grain-wilbur-ellis',
    name: 'Wilbur-Ellis Company',
    role: 'trader',
    hq: 'Aurora, CO (formerly San Francisco, CA)',
    primaryDomain: 'wilburellis.com',
    aliases: ['Wilbur-Ellis'],
    categories: ['food-commodities', 'corn', 'soybean'],
    extraTags: ['private', 'family-owned', 'agronomy'],
    notes:
      'Privately held agronomy, animal nutrition, and specialty-chemicals distributor. Founded 1921. Major Pacific Northwest grain origination footprint. HQ Aurora, CO.',
  },
  {
    slug: 'us-grain-olam-agri',
    name: 'Olam Agri',
    role: 'trader',
    hq: 'Singapore (US ops in Minneapolis and Memphis)',
    primaryDomain: 'olamagri.com',
    aliases: ['Olam Agri', 'Olam International'],
    categories: ['food-commodities', 'wheat', 'rice', 'oilseeds', 'corn'],
    extraTags: ['international', 'singapore-based'],
    notes:
      'Spun off from Olam International in 2022 as a dedicated agribusiness platform. Significant US operations in wheat milling, rice processing, and grain origination. HQ Singapore.',
  },
  {
    slug: 'us-grain-itochu-international',
    name: 'Itochu International Inc.',
    role: 'trader',
    hq: 'New York, NY (US ops); Tokyo, JP (parent HQ)',
    primaryDomain: 'itochu.com',
    aliases: ['Itochu', 'Itochu International'],
    categories: ['food-commodities', 'corn', 'soybean', 'wheat'],
    extraTags: ['international', 'japanese', 'sogo-shosha'],
    notes:
      'US arm of Itochu Corporation, one of the major Japanese sogo shosha (general trading companies). Major partner in CGB Enterprises and significant US grain origination footprint.',
  },
  {
    slug: 'us-grain-viterra',
    name: 'Viterra',
    role: 'trader',
    hq: 'Rotterdam, NL (US ops in St. Louis, MO post-Gavilon)',
    primaryDomain: 'viterra.com',
    aliases: ['Viterra', 'Gavilon'],
    categories: ['food-commodities', 'corn', 'soybean', 'wheat'],
    extraTags: ['glencore-spinout', 'gavilon-acquired'],
    notes:
      'Global grain, oilseed, and freight platform formed from Glencore Agriculture. Acquired Gavilon in 2022, materially expanding US Midwest origination. Merging with Bunge (pending close).',
  },
];

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required.');
  }
  const db = drizzle(neon(process.env.DATABASE_URL), { schema });

  console.log(`[us-grain-seed] inserting ${SEED.length} entities…`);

  let inserted = 0;
  let skipped = 0;

  for (const entity of SEED) {
    const tags = Array.from(
      new Set([
        'us-grain-seed',
        'curated',
        'fy2026-grain-rolodex',
        `role-${entity.role}`,
        ...entity.extraTags,
      ]),
    );
    const metadata: Record<string, unknown> = {
      source: 'curated_us_grain_seed',
      seeded_at: new Date().toISOString().slice(0, 10),
      headquarters: entity.hq,
    };

    const result = await db
      .insert(schema.knownEntities)
      .values({
        slug: entity.slug,
        name: entity.name,
        country: 'US',
        role: entity.role,
        categories: entity.categories,
        notes: `${entity.notes}\n\nHeadquarters: ${entity.hq}.`,
        aliases: entity.aliases,
        tags,
        metadata,
        primaryDomain: entity.primaryDomain,
      })
      .onConflictDoNothing({ target: schema.knownEntities.slug })
      .returning({ slug: schema.knownEntities.slug });

    if (result.length > 0) {
      inserted += 1;
      console.log(`  + ${entity.slug}  (${entity.name})`);
    } else {
      skipped += 1;
    }
  }

  console.log(
    `\n[us-grain-seed] done — inserted=${inserted} skipped-existing=${skipped} total=${SEED.length}`,
  );
  console.log(
    `[us-grain-seed] next: crawl them via\n    pnpm --filter @procur/ai crawl-entity-website --country=US --limit=30`,
  );
}

main().catch((err) => {
  console.error('[us-grain-seed] FAILED', err);
  process.exit(1);
});
