/**
 * USDA FSIS MPI → rolodex + website-intelligence pipeline.
 *
 * For every MPI establishment with a `primary_domain` set (populated
 * by the Apollo enrichment in PR #659), this pipeline:
 *
 *   1. **Promote.** Creates a corresponding `known_entities` row that
 *      acts as the shadow rolodex entry. Stamps a back-pointer at
 *      `usda_fsis_establishments.linked_known_entity_slug`. The
 *      shadow row is what downstream surfaces (lookup_known_entities,
 *      analyze_supplier, map view) consume; the MPI row stays
 *      canonical for regulatory data.
 *
 *   2. **Crawl (optional).** Invokes the existing `crawlSingleEntity`
 *      on each promoted slug — fetches the company website, runs the
 *      Sonnet section extractor, writes `entity_web_summaries` rows
 *      that surface in `analyze_supplier`'s `webIntelligence` field.
 *      Operator gets cut / capacity / customer detail from the
 *      processor's own published content.
 *
 * The crawl is expensive (~30-60s + LLM cost per entity) — gated
 * behind an option so the operator can promote first (fast, free)
 * and crawl later in batches.
 *
 * Idempotent: promotion skips rows that already have
 * `linked_known_entity_slug` set. Crawl idempotency comes from the
 * existing crawler's 90-day re-crawl skip per CLAUDE.md.
 */

import { sql } from 'drizzle-orm';
import { neon } from '@neondatabase/serverless';
import { drizzle, type drizzle as drizzleType } from 'drizzle-orm/neon-http';
import * as schema from '@procur/db';
import { crawlSingleEntity } from './crawl-entity-website';

type Db = ReturnType<typeof drizzleType<typeof schema>>;

export interface PromoteCrawlResult {
  processed: number;
  promoted: number;
  crawled: number;
  crawlErrors: number;
  skippedAlreadyLinked: number;
  errors: number;
  remaining: number;
}

export interface PromoteCrawlArgs {
  /** Max MPI rows to process this run. Default 25 (the crawler is
   *  slow; ~25-50 entities fit inside Vercel's 300s budget). */
  limit?: number;
  /** Whether to crawl each promoted entity in the same pass.
   *  Set false when you just want to seed the rolodex shadow rows
   *  quickly. Default true. */
  crawl?: boolean;
  /** Filter to a specific species (e.g. 'swine'). */
  speciesFilter?: string;
}

/**
 * Map FSIS species to KNOWN_ENTITY_CATEGORIES. Each MPI row collapses
 * onto a tight category set; species not in the lookup fall back to
 * 'food-commodities' so every promoted entity has at least one
 * category.
 */
const SPECIES_TO_CATEGORIES: Record<string, string[]> = {
  swine: ['pork', 'food-commodities'],
  cattle: ['beef', 'food-commodities'],
  sheep: ['food-commodities'],
  goat: ['food-commodities'],
  equine: ['food-commodities'],
  poultry: ['poultry', 'food-commodities'],
  egg: ['dairy', 'food-commodities'],
};

function categoriesForMpi(speciesArr: string[]): string[] {
  const out = new Set<string>(['food-commodities']);
  for (const s of speciesArr) {
    const mapped = SPECIES_TO_CATEGORIES[s.toLowerCase()];
    if (mapped) mapped.forEach((c) => out.add(c));
  }
  return Array.from(out);
}

function composeNotes(row: {
  legalName: string;
  dbaName: string | null;
  establishmentNumber: string;
  city: string | null;
  state: string | null;
  activities: string[];
  species: string[];
  grants: string[];
}): string {
  const lines: string[] = [];
  lines.push(
    `USDA FSIS Establishment ${row.establishmentNumber}.`,
  );
  if (row.dbaName && row.dbaName !== row.legalName) {
    lines.push(`DBA: ${row.dbaName}.`);
  }
  const location = [row.city, row.state].filter(Boolean).join(', ');
  if (location) lines.push(`Located in ${location}.`);
  if (row.species.length > 0) lines.push(`Species: ${row.species.join(', ')}.`);
  if (row.activities.length > 0)
    lines.push(`Activities: ${row.activities.join(', ')}.`);
  if (row.grants.length > 0)
    lines.push(`Inspection grants: ${row.grants.join(', ')}.`);
  lines.push(
    'Auto-promoted from the FSIS MPI Directory; legally inspected for ' +
      'interstate commerce / export.',
  );
  return lines.join(' ');
}

function slugifyName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export async function promoteAndCrawlMpiEstablishments(
  db: Db,
  args: PromoteCrawlArgs = {},
): Promise<PromoteCrawlResult> {
  const limit = args.limit ?? 25;
  const shouldCrawl = args.crawl ?? true;

  // Pending rows: have a primary_domain (so there's something to crawl)
  // AND either haven't been promoted yet OR have been promoted but no
  // web_summaries exist yet (a previous run did promote-only). Without
  // the second branch, a promote-only first pass leaves all rows
  // ineligible for the later crawl pass.
  //
  // When crawl=false, we only want unpromoted rows — promoting an
  // already-promoted row is a no-op, but selecting them wastes the
  // batch budget.
  const whereParts: ReturnType<typeof sql>[] = [];
  whereParts.push(sql`${schema.usdaFsisEstablishments.primaryDomain} IS NOT NULL`);
  if (shouldCrawl) {
    whereParts.push(
      sql`(${schema.usdaFsisEstablishments.linkedKnownEntitySlug} IS NULL OR NOT EXISTS (SELECT 1 FROM ${schema.entityWebSummaries} WHERE ${schema.entityWebSummaries.entitySlug} = ${schema.usdaFsisEstablishments.linkedKnownEntitySlug}))`,
    );
  } else {
    whereParts.push(sql`${schema.usdaFsisEstablishments.linkedKnownEntitySlug} IS NULL`);
  }
  if (args.speciesFilter) {
    whereParts.push(
      sql`${schema.usdaFsisEstablishments.species} @> ARRAY[${args.speciesFilter}]::text[]`,
    );
  }
  const whereClause = sql.join(whereParts, sql` AND `);

  const rows = await db
    .select({
      establishmentNumber: schema.usdaFsisEstablishments.establishmentNumber,
      legalName: schema.usdaFsisEstablishments.legalName,
      dbaName: schema.usdaFsisEstablishments.dbaName,
      city: schema.usdaFsisEstablishments.city,
      state: schema.usdaFsisEstablishments.state,
      species: schema.usdaFsisEstablishments.species,
      activities: schema.usdaFsisEstablishments.activities,
      grants: schema.usdaFsisEstablishments.grants,
      latitude: schema.usdaFsisEstablishments.latitude,
      longitude: schema.usdaFsisEstablishments.longitude,
      primaryDomain: schema.usdaFsisEstablishments.primaryDomain,
      websiteUrl: schema.usdaFsisEstablishments.websiteUrl,
      existingSlug: schema.usdaFsisEstablishments.linkedKnownEntitySlug,
    })
    .from(schema.usdaFsisEstablishments)
    .where(whereClause)
    .orderBy(schema.usdaFsisEstablishments.establishmentNumber)
    .limit(limit);

  let promoted = 0;
  let crawled = 0;
  let crawlErrors = 0;
  let skippedAlreadyLinked = 0;
  let errors = 0;

  for (const row of rows) {
    let slug: string;
    if (row.existingSlug) {
      // Already promoted by a prior run — reuse the slug, skip the
      // promote-side writes entirely. We're here because the crawl
      // pass selected this row (no web_summaries yet).
      slug = row.existingSlug;
      skippedAlreadyLinked += 1;
    } else {
      const baseSlug = `mpi-fsis-${slugifyName(row.legalName)}-${slugifyName(row.establishmentNumber)}`;
      slug = baseSlug.slice(0, 100);
      const categories = categoriesForMpi(row.species);
      const speciesTags = row.species.map((s) => `fsis-${s}`);
      const tags = Array.from(
        new Set([
          'usda-fsis',
          'fsis-mpi-curated',
          'meat-processor',
          ...speciesTags,
        ]),
      );
      const metadata: Record<string, unknown> = {
        source: 'usda-fsis-mpi',
        fsis_establishment_number: row.establishmentNumber,
      };
      if (row.websiteUrl) metadata.website_url = row.websiteUrl;

      try {
        // Insert the shadow rolodex row. ON CONFLICT DO NOTHING handles
        // the rare race where two promote runs target the same slug or
        // the slug already exists for some unrelated reason — we still
        // want to stamp the back-pointer either way.
        await db
          .insert(schema.knownEntities)
          .values({
            slug,
            name: row.legalName,
            country: 'US',
            role: 'producer',
            categories,
            notes: composeNotes(row),
            aliases: row.dbaName && row.dbaName !== row.legalName ? [row.dbaName] : [],
            tags,
            metadata,
            latitude: row.latitude,
            longitude: row.longitude,
            primaryDomain: row.primaryDomain,
          })
          .onConflictDoNothing({ target: schema.knownEntities.slug });

        // Stamp back-pointer regardless of whether the insert created a
        // new row (idempotent path lands on the existing slug).
        await db
          .update(schema.usdaFsisEstablishments)
          .set({
            linkedKnownEntitySlug: slug,
            updatedAt: sql`NOW()`,
          })
          .where(
            sql`${schema.usdaFsisEstablishments.establishmentNumber} = ${row.establishmentNumber}`,
          );
        promoted += 1;
      } catch (err) {
        errors += 1;
        console.warn(
          JSON.stringify({
            level: 'warn',
            service: 'usda-fsis.promote',
            msg: 'promote failed — continuing',
            establishmentNumber: row.establishmentNumber,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
        continue;
      }
    }

    if (shouldCrawl) {
      try {
        const result = await crawlSingleEntity(slug, { refresh: false });
        if (result.ok) {
          crawled += 1;
        } else {
          crawlErrors += 1;
          console.warn(
            JSON.stringify({
              level: 'warn',
              service: 'usda-fsis.crawl',
              msg: 'crawl returned not-ok',
              slug,
              error: result.error,
            }),
          );
        }
      } catch (err) {
        crawlErrors += 1;
        console.warn(
          JSON.stringify({
            level: 'warn',
            service: 'usda-fsis.crawl',
            msg: 'crawl threw — continuing',
            slug,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }
  }

  // Remaining count for operator progress. Mirror the eligibility
  // filter above so the printed `remaining` matches what would be
  // picked on the next iteration.
  const remainingResult = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.usdaFsisEstablishments)
    .where(whereClause);
  const remaining = remainingResult[0]?.n ?? 0;

  return {
    processed: rows.length,
    promoted,
    crawled,
    crawlErrors,
    skippedAlreadyLinked,
    errors,
    remaining,
  };
}

/**
 * Convenience wrapper: builds a Neon-HTTP drizzle client from
 * process.env.DATABASE_URL then calls promoteAndCrawlMpiEstablishments.
 */
export async function runMpiIntelligencePipeline(
  args: PromoteCrawlArgs = {},
): Promise<PromoteCrawlResult> {
  if (!process.env.DATABASE_URL) {
    throw new Error('runMpiIntelligencePipeline: DATABASE_URL is required.');
  }
  const db = drizzle(neon(process.env.DATABASE_URL), { schema });
  return promoteAndCrawlMpiEstablishments(db, args);
}
