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
