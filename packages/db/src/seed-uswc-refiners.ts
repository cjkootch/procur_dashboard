/**
 * Seed major US West Coast refiners into the rolodex. The earlier
 * chat-curated batch only covered USGC (Motiva, CITGO, PBF Chalmette,
 * Marathon Garyville, Flint Hills Corpus) — those are Atlantic-basin
 * loadports. Pacific-basin destinations (Pacific CentAm via Balboa,
 * Far East) want USWC origins to skip Panama Canal transit, which
 * the assistant can only recommend if these rows exist.
 *
 * `primary_domain` is set explicitly so Apollo enrichment links on
 * the next batch run. Lat/lng cover the actual refinery, not the
 * parent HQ — entity profile vessel-activity geofence depends on it.
 *
 * Re-seed-safe via ON CONFLICT (slug). Add a refiner by appending to
 * USWC_REFINERS and re-running.
 *
 * Run: pnpm --filter @procur/db seed-uswc-refiners
 */
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { sql } from 'drizzle-orm';
import * as schema from './schema';

loadEnv({ path: '../../.env.local' });
loadEnv({ path: '../../.env' });

type RefinerSeed = {
  slug: string;
  name: string;
  country: string;
  role: string;
  categories: string[];
  tags: string[];
  primaryDomain: string;
  websiteUrl: string;
  latitude: number;
  longitude: number;
  notes: string;
};

const USWC_REFINERS: RefinerSeed[] = [
  {
    slug: 'seed-us-marathon-los-angeles',
    name: 'Marathon Los Angeles Refinery (Carson)',
    country: 'US',
    role: 'refiner',
    categories: [
      'heavy-fuel-oil',
      'diesel',
      'gasoline',
      'jet-fuel',
      'marine-bunker',
      'crude-oil',
    ],
    tags: [
      'region:uswc',
      'uswc-refiner',
      'pacific-exporter',
      'hfo-producer',
      'high-complexity',
      'chat-curated',
      'role:refiner',
    ],
    primaryDomain: 'marathonpetroleum.com',
    websiteUrl: 'https://www.marathonpetroleum.com',
    latitude: 33.83,
    longitude: -118.27,
    notes:
      "Marathon Petroleum's integrated Los Angeles complex spanning Carson + Wilmington, CA — combined ~365,000 bpd, the largest refining system on the US West Coast. High-complexity coker configuration produces full slate including residual fuel oil. Direct marine access via Berths 121 / 238 at Port of Los Angeles. Natural Pacific-basin loadport for Pacific CentAm, Mexican Pacific, Hawaii, and Far East deliveries — skips Panama Canal vs. USGC origin. Active products desk in Findlay HQ + on-site marketing at the refinery.",
  },
  {
    slug: 'seed-us-pbf-martinez',
    name: 'PBF Energy - Martinez Refinery',
    country: 'US',
    role: 'refiner',
    categories: ['heavy-fuel-oil', 'diesel', 'gasoline', 'jet-fuel', 'crude-oil'],
    tags: [
      'region:uswc',
      'uswc-refiner',
      'pacific-exporter',
      'hfo-producer',
      'high-complexity',
      'chat-curated',
      'role:refiner',
    ],
    primaryDomain: 'pbfenergy.com',
    websiteUrl: 'https://www.pbfenergy.com',
    latitude: 38.025,
    longitude: -122.115,
    notes:
      'PBF Energy subsidiary. Located in Martinez, California (San Francisco Bay Area). 156,400 bpd dual-train refinery with Nelson Complexity ~16, one of the highest-complexity refineries on the US West Coast. Processes wide slate of heavy and sour crude. Marine access via direct deepwater terminal on the Carquinez Strait. Natural Pacific-basin loadport for Pacific Latam (Balboa, Pacific CentAm), Mexico Pacific, and Far East deliveries — skips Panama Canal vs. USGC origin. Sister refinery to PBF Chalmette in the rolodex.',
  },
  {
    slug: 'seed-us-phillips-66-los-angeles',
    name: 'Phillips 66 Los Angeles Refinery',
    country: 'US',
    role: 'refiner',
    categories: ['heavy-fuel-oil', 'diesel', 'gasoline', 'jet-fuel', 'crude-oil'],
    tags: [
      'region:uswc',
      'uswc-refiner',
      'pacific-exporter',
      'hfo-producer',
      'shutdown-pending',
      'chat-curated',
      'role:refiner',
    ],
    primaryDomain: 'phillips66.com',
    websiteUrl: 'https://www.phillips66.com',
    latitude: 33.78,
    longitude: -118.265,
    notes:
      'Phillips 66 Los Angeles Refinery — twin-plant complex (Wilmington + Carson, CA) with combined ~139,000 bpd capacity. Phillips 66 announced phased shutdown of the LA complex by end of 2025 / early 2026; capacity is winding down. Until shutdown completes, residual FO and other product cargoes are still available on a spot basis. After shutdown, contact the Phillips 66 commercial desk for Sweeny (TX) and Ferndale (WA) origin alternatives — Ferndale is the natural USPNW Pacific origin replacement.',
  },
  {
    slug: 'seed-us-marathon-anacortes',
    name: 'Marathon Anacortes Refinery (Tesoro)',
    country: 'US',
    role: 'refiner',
    categories: ['heavy-fuel-oil', 'diesel', 'gasoline', 'jet-fuel', 'crude-oil'],
    tags: [
      'region:uswc',
      'uswc-refiner',
      'pacific-northwest',
      'pacific-exporter',
      'hfo-producer',
      'chat-curated',
      'role:refiner',
    ],
    primaryDomain: 'marathonpetroleum.com',
    websiteUrl: 'https://www.marathonpetroleum.com',
    latitude: 48.495,
    longitude: -122.62,
    notes:
      "Marathon Petroleum (formerly Tesoro / Andeavor) Anacortes Refinery — Anacortes, Washington, ~120,000 bpd. Pacific Northwest loadport with deepwater marine access on Puget Sound; ANS (Alaska North Slope) and Bakken crude diet. Produces full slate including residual fuel oil and asphalt. Natural USPNW alternative to LA-basin sourcing for Far East deliveries; voyage to Asia via great-circle is shorter than from LA. Marathon's products desk in Findlay HQ handles spot inquiries.",
  },
  {
    slug: 'seed-us-hf-sinclair-puget-sound',
    name: 'HF Sinclair Puget Sound Refinery',
    country: 'US',
    role: 'refiner',
    categories: ['heavy-fuel-oil', 'diesel', 'gasoline', 'jet-fuel', 'crude-oil'],
    tags: [
      'region:uswc',
      'uswc-refiner',
      'pacific-northwest',
      'pacific-exporter',
      'hfo-producer',
      'chat-curated',
      'role:refiner',
    ],
    primaryDomain: 'hfsinclair.com',
    websiteUrl: 'https://www.hfsinclair.com',
    latitude: 48.515,
    longitude: -122.555,
    notes:
      'HF Sinclair Puget Sound Refinery — Anacortes, Washington (formerly Shell Anacortes / Equilon). ~149,000 bpd. ANS-heavy diet plus Canadian crudes via pipeline. Marine access via deepwater berth on Puget Sound. Active Pacific basin exporter. HF Sinclair (HEP) merger created an integrated ~678,000 bpd refining system across mid-continent + West Coast; commercial team in Dallas TX HQ handles spot.',
  },
  {
    slug: 'seed-us-chevron-richmond',
    name: 'Chevron Richmond Refinery',
    country: 'US',
    role: 'refiner',
    categories: [
      'heavy-fuel-oil',
      'diesel',
      'gasoline',
      'jet-fuel',
      'marine-bunker',
      'crude-oil',
    ],
    tags: [
      'region:uswc',
      'uswc-refiner',
      'pacific-exporter',
      'hfo-producer',
      'high-complexity',
      'integrated-major',
      'bruno-relationship',
      'chat-curated',
      'role:refiner',
    ],
    primaryDomain: 'chevron.com',
    websiteUrl: 'https://www.chevron.com',
    latitude: 37.93,
    longitude: -122.41,
    notes:
      "Chevron's Richmond Refinery — Richmond, California (San Francisco Bay Area). ~245,000 bpd; one of the most complex refineries on the US West Coast and Chevron's largest WC asset. Direct deepwater marine access via the Long Wharf on San Francisco Bay; capable of handling Aframax-class vessels. Produces full slate including residual fuel oil. VTC context: Bruno has an existing supplier relationship at the Chevron parent level — open contact path for Pacific-basin spot inquiries (typically lower spot capacity than independents per Bruno).",
  },
  {
    slug: 'seed-us-valero-wilmington',
    name: 'Valero Wilmington Refinery',
    country: 'US',
    role: 'refiner',
    categories: [
      'heavy-fuel-oil',
      'diesel',
      'gasoline',
      'jet-fuel',
      'marine-bunker',
      'crude-oil',
    ],
    tags: [
      'region:uswc',
      'uswc-refiner',
      'pacific-exporter',
      'hfo-producer',
      'integrated-major',
      'bruno-relationship',
      'chat-curated',
      'role:refiner',
    ],
    primaryDomain: 'valero.com',
    websiteUrl: 'https://www.valero.com',
    latitude: 33.78,
    longitude: -118.27,
    notes:
      "Valero Wilmington Refinery — Wilmington, California (Port of Los Angeles complex). ~135,000 bpd, dual-train high-conversion refinery. Produces gasoline, diesel, jet, marine residual FO. Direct marine access at Wilmington/Long Beach terminals; natural Pacific basin loadport for Pacific Latam, Mexico Pacific, Hawaii. VTC context: Bruno has an existing supplier relationship with Valero — Wilmington and Benicia are the two USWC sites; per Bruno, capacity for spot is typically constrained.",
  },
  {
    slug: 'seed-us-valero-benicia',
    name: 'Valero Benicia Refinery',
    country: 'US',
    role: 'refiner',
    categories: [
      'heavy-fuel-oil',
      'diesel',
      'gasoline',
      'jet-fuel',
      'crude-oil',
    ],
    tags: [
      'region:uswc',
      'uswc-refiner',
      'pacific-exporter',
      'hfo-producer',
      'integrated-major',
      'bruno-relationship',
      'chat-curated',
      'role:refiner',
    ],
    primaryDomain: 'valero.com',
    websiteUrl: 'https://www.valero.com',
    latitude: 38.06,
    longitude: -122.155,
    notes:
      "Valero Benicia Refinery — Benicia, California (San Francisco Bay Area, Carquinez Strait). ~145,000 bpd. Marine access via direct deepwater terminal on the Strait. Sister refinery to Valero Wilmington on the WC. Produces full slate; residual FO available on spot basis. VTC context: Bruno has an existing supplier relationship with Valero — capacity for spot is typically constrained per Bruno.",
  },
  {
    slug: 'seed-us-par-hawaii-kapolei',
    name: 'Par Hawaii Refining (Kapolei)',
    country: 'US',
    role: 'refiner',
    categories: [
      'heavy-fuel-oil',
      'diesel',
      'gasoline',
      'jet-fuel',
      'marine-bunker',
      'crude-oil',
    ],
    tags: [
      'region:uswc',
      'uswc-refiner',
      'pacific-mid',
      'pacific-exporter',
      'hfo-producer',
      'bruno-relationship',
      'chat-curated',
      'role:refiner',
    ],
    primaryDomain: 'parpacific.com',
    websiteUrl: 'https://www.parpacific.com',
    latitude: 21.32,
    longitude: -158.10,
    notes:
      "Par Hawaii Refining — Kapolei, Oahu, Hawaii. ~94,000 bpd. The only operating refinery in Hawaii; supplies the state's transportation, jet, and marine bunker demand. Marine access via Barbers Point harbor + onsite deepwater terminal. Subsidiary of Par Pacific Holdings (NYSE: PARR). VTC context: Bruno has an existing supplier relationship with Par Pacific — Hawaii is mid-Pacific, geographically advantageous for FE deliveries vs. mainland West Coast origin. Per Bruno, capacity for spot is typically constrained.",
  },
  {
    slug: 'seed-us-par-pacific-tacoma',
    name: 'Par Pacific Tacoma Refinery',
    country: 'US',
    role: 'refiner',
    categories: [
      'heavy-fuel-oil',
      'diesel',
      'gasoline',
      'jet-fuel',
      'crude-oil',
    ],
    tags: [
      'region:uswc',
      'uswc-refiner',
      'pacific-northwest',
      'pacific-exporter',
      'hfo-producer',
      'bruno-relationship',
      'chat-curated',
      'role:refiner',
    ],
    primaryDomain: 'parpacific.com',
    websiteUrl: 'https://www.parpacific.com',
    latitude: 47.265,
    longitude: -122.385,
    notes:
      "Par Pacific Tacoma Refinery — Tacoma, Washington. ~42,000 bpd; primarily produces asphalt, marine fuels, gasoline blendstocks, distillate. Marine access via Commencement Bay / Port of Tacoma. Smaller than other WC refiners but operationally focused on Pacific Northwest distribution + asphalt/marine product. Sister to Par Hawaii (Kapolei). VTC context: Bruno has an existing relationship with Par Pacific.",
  },
];

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const dryRun = process.argv.includes('--dry-run');

  const client = neon(url);
  const db = drizzle(client, { schema, casing: 'snake_case' });

  console.log(
    `seed-uswc-refiners — ${USWC_REFINERS.length} refiners, dryRun=${dryRun}`,
  );

  let inserted = 0;
  let updated = 0;
  for (const r of USWC_REFINERS) {
    if (dryRun) {
      console.log(`  ${r.slug}\t${r.name}\t${r.primaryDomain}`);
      continue;
    }
    const result = await db
      .insert(schema.knownEntities)
      .values({
        slug: r.slug,
        name: r.name,
        country: r.country,
        role: r.role,
        categories: r.categories,
        notes: r.notes,
        aliases: [],
        tags: r.tags,
        metadata: { source: 'chat-curated', website_url: r.websiteUrl },
        latitude: String(r.latitude),
        longitude: String(r.longitude),
        primaryDomain: r.primaryDomain,
      })
      .onConflictDoUpdate({
        target: schema.knownEntities.slug,
        set: {
          name: sql`EXCLUDED.name`,
          categories: sql`EXCLUDED.categories`,
          notes: sql`EXCLUDED.notes`,
          tags: sql`EXCLUDED.tags`,
          metadata: sql`EXCLUDED.metadata`,
          latitude: sql`EXCLUDED.latitude`,
          longitude: sql`EXCLUDED.longitude`,
          primaryDomain: sql`EXCLUDED.primary_domain`,
        },
      })
      .returning({
        slug: schema.knownEntities.slug,
        // xmax = 0 means a fresh insert (no prior row was updated).
        wasInserted: sql<boolean>`(xmax = 0)`,
      });
    const row = result[0];
    if (row?.wasInserted) inserted += 1;
    else updated += 1;
  }

  console.log(
    `done — inserted=${inserted}, updated=${updated}${dryRun ? ' (dry run)' : ''}`,
  );
  console.log('next:');
  console.log('  pnpm --filter ai-pipeline apollo-batch-enrich');
  console.log('  pnpm --filter @procur/ai seed-entity-text-embeddings');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
