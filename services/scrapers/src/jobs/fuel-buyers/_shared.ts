/**
 * Shared types + ingest runner for fuel-buyer per-segment seeds.
 * Each segment's seed file declares an array of SeedEntry and a
 * source slug; this helper does the upsert + summary plumbing so
 * each segment file stays focused on entity data.
 */
import { sql } from 'drizzle-orm';
import { db } from '@procur/db';

export type FuelBuyerSeedEntry = {
  slug: string;
  name: string;
  country: string;
  aliases?: string[];
  notes?: string;
  /** WGS84 decimal degrees for the entity's primary operating
   *  asset (power plant, mine site, terminal, port). Optional —
   *  populate only when there's a single-point asset whose lat/lng
   *  is meaningful for vessel-activity / proximity-radius queries.
   *  Diversified distributor networks or corporate HQs without a
   *  single physical asset should leave this null. */
  latitude?: number;
  longitude?: number;
  /** Categories on the row (defaulted to ['fuel-buyer'] + segment if
   *  not supplied). */
  extraCategories?: string[];
  /** Extra tags to layer on top of the auto-applied ones. */
  extraTags?: string[];
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

export type SegmentRunSummary<S extends string> = {
  source: S;
  status: 'ok' | 'error';
  upserted: number;
  skipped: number;
  errors: string[];
  startedAt: string;
  finishedAt: string;
};

/**
 * Idempotent upsert across a segment's seed entries. Same shape +
 * tagging conventions as seed-utilities.ts: role=fuel-buyer-industrial,
 * categories=['fuel-buyer', segment-tag], tag region:caribbean +
 * source:curated-seed.
 */
export async function ingestSegmentSeed<S extends string>(
  source: S,
  entries: FuelBuyerSeedEntry[],
  segmentTag: string,
): Promise<SegmentRunSummary<S>> {
  const startedAt = new Date().toISOString();
  let upserted = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const e of entries) {
    try {
      const tags = [
        'fuel-buyer',
        'source:curated-seed',
        `segment:${segmentTag}`,
        'region:caribbean',
        ...(e.extraTags ?? []),
      ];
      const categories = ['fuel-buyer', segmentTag, ...(e.extraCategories ?? [])];
      const aliases = e.aliases ?? [];
      await db.execute(sql`
        INSERT INTO known_entities (
          slug, name, country, role, categories, aliases, tags, notes, metadata, latitude, longitude
        ) VALUES (
          ${e.slug},
          ${e.name},
          ${e.country},
          ${'fuel-buyer-industrial'},
          ARRAY[${sql.join(categories.map((c) => sql`${c}`), sql`, `)}]::text[],
          ${aliases.length > 0 ? sql`ARRAY[${sql.join(aliases.map((a) => sql`${a}`), sql`, `)}]::text[]` : sql`NULL`},
          ARRAY[${sql.join(tags.map((t) => sql`${t}`), sql`, `)}]::text[],
          ${e.notes ?? null},
          ${JSON.stringify({ fuelBuyerProfile: e.profile })}::jsonb,
          ${e.latitude ?? null},
          ${e.longitude ?? null}
        )
        ON CONFLICT (slug) DO UPDATE SET
          name       = EXCLUDED.name,
          aliases    = EXCLUDED.aliases,
          categories = EXCLUDED.categories,
          tags       = EXCLUDED.tags,
          notes      = EXCLUDED.notes,
          metadata   = EXCLUDED.metadata,
          latitude   = COALESCE(EXCLUDED.latitude, known_entities.latitude),
          longitude  = COALESCE(EXCLUDED.longitude, known_entities.longitude),
          updated_at = NOW();
      `);
      upserted += 1;
    } catch (err) {
      errors.push(`seed ${e.slug}: ${(err as Error).message}`);
      skipped += 1;
    }
  }

  return {
    source,
    status: errors.length > 0 && upserted === 0 ? 'error' : 'ok',
    upserted,
    skipped,
    errors,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}
