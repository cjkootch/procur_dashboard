/**
 * One-shot post-hoc dedup for known_entities.
 *
 * The in-pipeline `findOrUpsertEntity` helper deduplicates rows that
 * arrive through the same ingest run, but it doesn't sweep
 * pre-existing dups across earlier seed/ingest cycles. This script:
 *
 *   1. Pulls every known_entities row with role IN
 *      ('refiner', 'producer', 'terminal', 'port') AND lat/lng set.
 *   2. For each pair, computes haversine distance (km) +
 *      normalised-name trigram similarity. Pairs are candidate dups
 *      when (distance ≤ 1 km) AND (similarity ≥ 0.40).
 *   3. Picks a canonical row via deterministic rules:
 *        - prefer the row with metadata.wikidata_id set
 *        - else prefer the one with non-empty notes
 *        - else prefer the one with more aliases
 *        - else prefer the older row (created_at ASC)
 *   4. Merges the dup into the canonical (union aliases + tags +
 *      categories; shallow-merge metadata with canonical winning on
 *      conflict; concat notes; preserve canonical lat/lng).
 *   5. Retargets entity_news_events.known_entity_id from the dup to
 *      the canonical (ON DELETE SET NULL would otherwise null the
 *      link).
 *   6. Deletes the dup row.
 *
 * Default mode is REPORT — prints proposed merges with a side-by-
 * side diff and exits without writing. Pass `--apply` to actually
 * mutate. Always re-run report mode after `--apply` to confirm
 * the rolodex is clean.
 *
 * Run from repo root:
 *   pnpm --filter @procur/db dedup-refineries
 *   pnpm --filter @procur/db dedup-refineries -- --apply
 *   pnpm --filter @procur/db dedup-refineries -- --threshold-km=2 --threshold-name=0.5
 */
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { sql } from 'drizzle-orm';
import * as schema from './schema';

loadEnv({ path: '../../.env.local' });
loadEnv({ path: '../../.env' });

const PHYSICAL_ROLES = ['refiner', 'producer', 'terminal', 'port'];
const DEFAULT_DISTANCE_KM = 1;
const DEFAULT_NAME_SIMILARITY = 0.4;
const EARTH_RADIUS_KM = 6371;

type EntityRow = {
  id: string;
  slug: string;
  name: string;
  country: string;
  role: string;
  categories: string[];
  notes: string | null;
  aliases: string[];
  tags: string[];
  metadata: Record<string, unknown> | null;
  latitude: number;
  longitude: number;
  createdAt: string;
};

type DupPair = {
  canonical: EntityRow;
  dup: EntityRow;
  distanceKm: number;
  similarity: number;
};

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');

  const apply = process.argv.includes('--apply');
  const distanceKm = readNumberArg('--threshold-km') ?? DEFAULT_DISTANCE_KM;
  const nameSim = readNumberArg('--threshold-name') ?? DEFAULT_NAME_SIMILARITY;

  const client = neon(url);
  const db = drizzle(client, { schema, casing: 'snake_case' });

  console.log(
    `Scanning known_entities for dups (distance ≤ ${distanceKm} km, ` +
      `name similarity ≥ ${nameSim.toFixed(2)})${apply ? ' — APPLY mode' : ' — REPORT only'}.`,
  );

  const rows = await loadEntities(db);
  console.log(`Loaded ${rows.length} physical-asset rows with coordinates.`);

  const pairs = findDupPairs(rows, distanceKm, nameSim);
  if (pairs.length === 0) {
    console.log('No dup candidates found. Rolodex is clean by these thresholds.');
    return;
  }

  console.log(`\n${pairs.length} dup candidate pair${pairs.length === 1 ? '' : 's'}:\n`);
  for (let i = 0; i < pairs.length; i += 1) {
    const p = pairs[i]!;
    console.log(
      `[${i + 1}/${pairs.length}] ${p.distanceKm.toFixed(2)} km · ` +
        `name-sim ${p.similarity.toFixed(2)}`,
    );
    console.log(
      `  canonical:  ${p.canonical.slug.padEnd(40)} ${p.canonical.name}`,
    );
    console.log(`              ${dumpMeta(p.canonical)}`);
    console.log(
      `  duplicate:  ${p.dup.slug.padEnd(40)} ${p.dup.name}`,
    );
    console.log(`              ${dumpMeta(p.dup)}`);
    console.log();
  }

  if (!apply) {
    console.log('REPORT mode — no DB writes. Re-run with --apply to merge.');
    return;
  }

  // APPLY mode.
  let merged = 0;
  for (let i = 0; i < pairs.length; i += 1) {
    const p = pairs[i]!;
    try {
      await mergePair(db, p);
      merged += 1;
      console.log(
        `  ✓ merged ${p.dup.slug} → ${p.canonical.slug} (${i + 1}/${pairs.length})`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ✗ failed ${p.dup.slug} → ${p.canonical.slug}: ${msg}`);
    }
  }
  console.log(`\nApplied ${merged}/${pairs.length} merges.`);
}

async function loadEntities(
  db: ReturnType<typeof drizzle<typeof schema>>,
): Promise<EntityRow[]> {
  // Unroll the role list into an IN-list. The `ANY(${arr}::text[])`
  // pattern is brittle under Neon's HTTP wire protocol — Drizzle
  // serialises the array in a way the parser rejects with
  // 'cannot cast type record to text[]'. sql.join with one
  // placeholder per element is the workaround that's known to work.
  const rolesIn = sql.join(
    PHYSICAL_ROLES.map((r) => sql`${r}`),
    sql`, `,
  );
  const result = await db.execute(sql`
    SELECT id, slug, name, country, role, categories, notes, aliases, tags,
           metadata, latitude, longitude, created_at
    FROM known_entities
    WHERE role IN (${rolesIn})
      AND latitude IS NOT NULL
      AND longitude IS NOT NULL
  `);
  return (result.rows as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    slug: String(r.slug),
    name: String(r.name),
    country: String(r.country),
    role: String(r.role),
    categories: (r.categories as string[] | null) ?? [],
    notes: r.notes == null ? null : String(r.notes),
    aliases: (r.aliases as string[] | null) ?? [],
    tags: (r.tags as string[] | null) ?? [],
    metadata: (r.metadata as Record<string, unknown> | null) ?? null,
    latitude: Number.parseFloat(String(r.latitude)),
    longitude: Number.parseFloat(String(r.longitude)),
    createdAt:
      r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  }));
}

function findDupPairs(
  rows: EntityRow[],
  distanceKm: number,
  nameSim: number,
): DupPair[] {
  const pairs: DupPair[] = [];
  // Bucket by country first — refineries with the same name in
  // different countries are NOT dups.
  const byCountry = new Map<string, EntityRow[]>();
  for (const r of rows) {
    const arr = byCountry.get(r.country) ?? [];
    arr.push(r);
    byCountry.set(r.country, arr);
  }
  for (const [, group] of byCountry) {
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        const a = group[i]!;
        const b = group[j]!;
        const d = haversineKm(a.latitude, a.longitude, b.latitude, b.longitude);
        if (d > distanceKm) continue;
        const sim = trigramSimilarity(normaliseName(a.name), normaliseName(b.name));
        if (sim < nameSim) continue;
        const { canonical, dup } = pickCanonical(a, b);
        pairs.push({ canonical, dup, distanceKm: d, similarity: sim });
      }
    }
  }
  return pairs;
}

function pickCanonical(
  a: EntityRow,
  b: EntityRow,
): { canonical: EntityRow; dup: EntityRow } {
  const aHasWd = !!(a.metadata as { wikidata_id?: string } | null)?.wikidata_id;
  const bHasWd = !!(b.metadata as { wikidata_id?: string } | null)?.wikidata_id;
  if (aHasWd !== bHasWd) {
    return aHasWd ? { canonical: a, dup: b } : { canonical: b, dup: a };
  }
  const aHasNotes = !!a.notes && a.notes.trim().length > 0;
  const bHasNotes = !!b.notes && b.notes.trim().length > 0;
  if (aHasNotes !== bHasNotes) {
    return aHasNotes ? { canonical: a, dup: b } : { canonical: b, dup: a };
  }
  if (a.aliases.length !== b.aliases.length) {
    return a.aliases.length > b.aliases.length
      ? { canonical: a, dup: b }
      : { canonical: b, dup: a };
  }
  // Older row wins on ties.
  return a.createdAt <= b.createdAt
    ? { canonical: a, dup: b }
    : { canonical: b, dup: a };
}

async function mergePair(
  db: ReturnType<typeof drizzle<typeof schema>>,
  pair: DupPair,
): Promise<void> {
  const { canonical, dup } = pair;
  const mergedAliases = unique([
    ...canonical.aliases,
    ...dup.aliases,
    dup.name,
  ].filter((a) => a !== canonical.name));
  const mergedTags = unique([...canonical.tags, ...dup.tags]);
  const mergedCategories = unique([...canonical.categories, ...dup.categories]);
  const mergedMetadata = {
    ...(dup.metadata ?? {}),
    ...(canonical.metadata ?? {}),
  };
  const mergedNotes = mergeNotes(canonical.notes, dup.notes, dup.slug);

  await db.transaction(async (tx) => {
    // Retarget any entity_news_events the dup owned. ON DELETE
    // SET NULL would otherwise drop the link.
    await tx.execute(sql`
      UPDATE entity_news_events
      SET known_entity_id = ${canonical.id}::uuid,
          updated_at = NOW()
      WHERE known_entity_id = ${dup.id}::uuid
    `);

    await tx.execute(sql`
      UPDATE known_entities
      SET aliases = ${mergedAliases}::text[],
          tags = ${mergedTags}::text[],
          categories = ${mergedCategories}::text[],
          metadata = ${JSON.stringify(mergedMetadata)}::jsonb,
          notes = ${mergedNotes},
          updated_at = NOW()
      WHERE id = ${canonical.id}::uuid
    `);

    await tx.execute(sql`
      DELETE FROM known_entities WHERE id = ${dup.id}::uuid
    `);
  });
}

function mergeNotes(
  canonicalNotes: string | null,
  dupNotes: string | null,
  dupSlug: string,
): string | null {
  if (!dupNotes || !dupNotes.trim()) return canonicalNotes;
  if (!canonicalNotes || !canonicalNotes.trim()) {
    return `${dupNotes.trim()}\n[merged from ${dupSlug}]`;
  }
  if (canonicalNotes.includes(dupNotes.trim())) return canonicalNotes;
  return `${canonicalNotes.trim()}\n\n[merged from ${dupSlug}]\n${dupNotes.trim()}`;
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.asin(Math.sqrt(a));
}

function normaliseName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(
      /\b(refinery|terminal|port|loading|complex|inc|llc|ltd|s\.?a\.?|s\.?p\.?a\.?|gmbh|corp(?:oration)?|company|co\.|holdings|holding|group|plc|nv|bv)\b/g,
      '',
    )
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function trigramSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const sa = trigrams(a);
  const sb = trigrams(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter += 1;
  return inter / (sa.size + sb.size - inter);
}

function trigrams(s: string): Set<string> {
  const padded = `  ${s} `;
  const out = new Set<string>();
  for (let i = 0; i < padded.length - 2; i += 1) {
    out.add(padded.slice(i, i + 3));
  }
  return out;
}

function unique<T>(xs: T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const x of xs) {
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}

function readNumberArg(prefix: string): number | null {
  const arg = process.argv.find((a) => a.startsWith(`${prefix}=`));
  if (!arg) return null;
  const n = Number.parseFloat(arg.split('=')[1] ?? '');
  return Number.isFinite(n) ? n : null;
}

function dumpMeta(r: EntityRow): string {
  const parts: string[] = [];
  parts.push(`(${r.latitude.toFixed(4)}, ${r.longitude.toFixed(4)})`);
  parts.push(`role=${r.role}`);
  if (r.aliases.length > 0) parts.push(`aliases=${r.aliases.length}`);
  if (r.tags.length > 0) parts.push(`tags=[${r.tags.slice(0, 3).join(',')}]`);
  const wd = (r.metadata as { wikidata_id?: string } | null)?.wikidata_id;
  if (wd) parts.push(`wd=${wd}`);
  if (r.notes && r.notes.trim().length > 0) parts.push('notes:✓');
  return parts.join(' · ');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
