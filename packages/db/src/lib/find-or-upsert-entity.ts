import { sql } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/neon-http';
import * as schema from '../schema';

/**
 * Cross-source de-dup + enrichment for known_entities.
 *
 * Three ingest paths populate the rolodex:
 *   1. Curated seed (analyst-edited)
 *   2. Wikidata SPARQL (P31 → refinery classes, P625 coords, etc.)
 *   3. GEM Global Oil Refinery Tracker (CSV, capacity-by-unit detail)
 *
 * Same physical refinery can come up in multiple sources with name
 * variations ("Eni Sannazzaro Refinery" vs "Sannazzaro de' Burgondi
 * Refinery" vs "Eni Refinery — Sannazzaro"). Without de-dup we'd have
 * three rows on the map for one site. This helper:
 *
 *   - On insert: fuzzy-matches against existing rows in the same
 *     country using pg_trgm `similarity()`. Threshold 0.55 (same as
 *     supplier-graph alias matching). Above that, treat as the same
 *     entity.
 *   - On match: enriches existing row with new source's data without
 *     overwriting curated fields. Source-specific IDs (wikidata_id,
 *     gem_id) accumulate in metadata.
 *   - On no match: inserts a new row with the source-prefixed slug
 *     (curated-*, wd-*, gem-*).
 *
 * Source priority for field preservation:
 *   curated > gem > wikidata > osm
 *
 * Curated rows never get their existing fields overwritten — only
 * NULL fields are filled in by lower-priority sources.
 */

export type EntitySource = 'curated' | 'gem' | 'wikidata' | 'osm';

const SOURCE_PRIORITY: Record<EntitySource, number> = {
  curated: 4,
  gem: 3,
  wikidata: 2,
  osm: 1,
};

export type EntityCandidate = {
  /** Slug used if this becomes a new row. */
  slug: string;
  source: EntitySource;
  name: string;
  country: string;
  role: string;
  categories: string[];
  notes: string | null;
  aliases: string[];
  tags: string[];
  latitude: number | null;
  longitude: number | null;
  /** Source-specific metadata (capacity, operator, owner, IDs). */
  metadata: Record<string, unknown>;
};

type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Find an existing entity matching the candidate, or insert it.
 *
 * Match rule: same country + trigram similarity ≥ 0.55 against name
 * OR any alias. Returns the canonical entity slug (existing or new)
 * and whether the row was 'inserted' or 'merged'.
 */
export async function findOrUpsertEntity(
  db: DrizzleDb,
  candidate: EntityCandidate,
): Promise<{ slug: string; outcome: 'inserted' | 'merged' }> {
  // 1. Look for a matching existing row.
  const matchRows = await db.execute(sql`
    SELECT
      slug,
      name,
      role,
      categories,
      notes,
      aliases,
      tags,
      latitude,
      longitude,
      metadata,
      GREATEST(
        similarity(name, ${candidate.name}),
        COALESCE((
          SELECT MAX(similarity(unnest_alias, ${candidate.name}))
          FROM unnest(aliases) AS unnest_alias
        ), 0)
      ) AS sim
    FROM known_entities
    WHERE country = ${candidate.country}
      AND (
        name % ${candidate.name}
        OR EXISTS (
          SELECT 1 FROM unnest(aliases) AS a WHERE a % ${candidate.name}
        )
      )
    ORDER BY sim DESC
    LIMIT 1;
  `);

  const match = (matchRows.rows as Array<Record<string, unknown>>)[0];
  const sim = match ? Number(match.sim ?? 0) : 0;

  if (match && sim >= 0.55) {
    // 2. Enrich existing row.
    const existingSource =
      (match.metadata as Record<string, unknown> | null)?.source ?? 'unknown';
    const existingPriority =
      typeof existingSource === 'string'
        ? SOURCE_PRIORITY[existingSource as EntitySource] ?? 0
        : 0;
    const candidatePriority = SOURCE_PRIORITY[candidate.source];

    // Higher-priority source wins on top-level fields. Lower-priority
    // sources only fill NULL fields. Either way, metadata accumulates.
    const replaceTopLevel = candidatePriority > existingPriority;

    const mergedAliases = unionArr(
      match.aliases as string[] | null,
      candidate.aliases,
    );
    const mergedTags = unionArr(match.tags as string[] | null, candidate.tags);
    const mergedCategories = unionArr(
      match.categories as string[] | null,
      candidate.categories,
    );
    const mergedMetadata = {
      ...((match.metadata as Record<string, unknown>) ?? {}),
      ...candidate.metadata,
      // Always preserve the highest-priority source as the row's source label.
      source: replaceTopLevel ? candidate.source : existingSource,
    };

    await db
      .update(schema.knownEntities)
      .set({
        // Top-level fields: only overwrite if candidate's source ranks higher.
        name: replaceTopLevel ? candidate.name : (match.name as string),
        role: replaceTopLevel ? candidate.role : (match.role as string),
        notes: replaceTopLevel ? candidate.notes : (match.notes as string | null),
        // Coords: fill if missing, otherwise prefer existing
        latitude:
          match.latitude == null && candidate.latitude != null
            ? String(candidate.latitude)
            : (match.latitude as string | null),
        longitude:
          match.longitude == null && candidate.longitude != null
            ? String(candidate.longitude)
            : (match.longitude as string | null),
        // Aliases / tags / categories: union (no destruction)
        aliases: mergedAliases,
        tags: mergedTags,
        categories: mergedCategories,
        metadata: mergedMetadata,
        updatedAt: new Date(),
      })
      .where(sql`slug = ${match.slug as string}`);

    return { slug: String(match.slug), outcome: 'merged' };
  }

  // 3. No match — insert as new row.
  await db
    .insert(schema.knownEntities)
    .values({
      slug: candidate.slug,
      name: candidate.name,
      country: candidate.country,
      role: candidate.role,
      categories: candidate.categories,
      notes: candidate.notes,
      aliases: candidate.aliases,
      tags: candidate.tags,
      latitude: candidate.latitude != null ? String(candidate.latitude) : null,
      longitude: candidate.longitude != null ? String(candidate.longitude) : null,
      metadata: { source: candidate.source, ...candidate.metadata },
    })
    .onConflictDoUpdate({
      target: schema.knownEntities.slug,
      set: {
        name: candidate.name,
        country: candidate.country,
        role: candidate.role,
        categories: candidate.categories,
        notes: candidate.notes,
        aliases: candidate.aliases,
        tags: candidate.tags,
        latitude: candidate.latitude != null ? String(candidate.latitude) : null,
        longitude: candidate.longitude != null ? String(candidate.longitude) : null,
        metadata: { source: candidate.source, ...candidate.metadata },
        updatedAt: new Date(),
      },
    });

  return { slug: candidate.slug, outcome: 'inserted' };
}

function unionArr(a: string[] | null, b: string[] | null): string[] {
  const set = new Set<string>();
  for (const x of a ?? []) if (x) set.add(x);
  for (const x of b ?? []) if (x) set.add(x);
  return [...set];
}
