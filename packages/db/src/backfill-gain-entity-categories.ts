/**
 * Backfill GAIN-curated entity categories from their source-report
 * commodity slice.
 *
 * The original GAIN extractor used a coarse `food_processed` tag for
 * downstream retailers / distributors / food-service operators. The
 * resolver then mapped that onto the KNOWN_ENTITY_CATEGORIES umbrella
 * `food-commodities`. Result: every Caribbean food retailer landed
 * with categories=['food-commodities'], losing the "this retailer
 * was mentioned in a Livestock and Products Annual" specificity.
 *
 * The parent report's category IS the specificity. Inherit it.
 *
 *   Grain and Feed                   → wheat, corn, soybean
 *   Oilseeds and Products            → soybean, palm-oil
 *   Sugar                            → sugar
 *   Livestock and Products           → beef, pork
 *   Poultry and Products             → poultry
 *   Dairy and Products               → dairy
 *
 * Broad reports (Exporter Guide / Food Processing Ingredients /
 * Retail Foods / Food Service - HRI) stay as 'food-commodities'
 * since they don't carry a single-commodity signal.
 *
 * Idempotent — re-running is a no-op for entities whose categories
 * already contain every inherited tag. Pure SQL, no LLM call, $0.
 *
 * Run from repo root:
 *   pnpm --filter @procur/db backfill-gain-entity-categories
 */
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { sql } from 'drizzle-orm';
import * as schema from './schema';

loadEnv({ path: '../../.env.local' });
loadEnv({ path: '../../.env' });

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required.');
  }
  const db = drizzle(neon(process.env.DATABASE_URL), { schema });

  // CTE chain:
  //   1. report_commodities: map each gain_reports.report_type to an
  //      array of canonical KNOWN_ENTITY_CATEGORIES commodities.
  //   2. entity_commodities: for each GAIN-resolved known_entity slug,
  //      union the commodities across all source reports the entity
  //      was mentioned in.
  //   3. UPDATE known_entities: merge the inherited commodities into
  //      the existing categories array, dedupe.
  //
  // The 'gain-curated' tag filter scopes the UPDATE to the auto-
  // promoted set so we don't accidentally mutate hand-seeded or
  // FSIS-promoted entities that happen to be mentioned in GAIN too.
  const result = await db.execute(sql`
    WITH report_commodities AS (
      SELECT
        id AS report_id,
        CASE report_type
          WHEN 'Grain and Feed'         THEN ARRAY['wheat','corn','soybean']
          WHEN 'Oilseeds and Products'  THEN ARRAY['soybean','palm-oil']
          WHEN 'Sugar'                  THEN ARRAY['sugar']
          WHEN 'Livestock and Products' THEN ARRAY['beef','pork']
          WHEN 'Poultry and Products'   THEN ARRAY['poultry']
          WHEN 'Dairy and Products'     THEN ARRAY['dairy']
          ELSE ARRAY[]::text[]
        END AS cmds
      FROM gain_reports
    ),
    entity_commodities AS (
      SELECT
        gim.resolved_entity_id AS slug,
        array_agg(DISTINCT cmd) AS new_cmds
      FROM gain_importer_mentions gim
      JOIN report_commodities rc ON gim.report_id = rc.report_id
      CROSS JOIN LATERAL unnest(rc.cmds) AS cmd
      WHERE gim.resolved_entity_id IS NOT NULL
        AND array_length(rc.cmds, 1) > 0
      GROUP BY gim.resolved_entity_id
    )
    UPDATE known_entities ke
    SET categories = ARRAY(
      SELECT DISTINCT u FROM unnest(ke.categories || ec.new_cmds) AS u
    )
    FROM entity_commodities ec
    WHERE ke.slug = ec.slug
      AND 'gain-curated' = ANY(ke.tags)
      AND NOT (ec.new_cmds <@ ke.categories)
    RETURNING ke.slug, ke.categories
  `);

  console.log(
    `[backfill-gain-categories] updated ${result.rows.length} entities.`,
  );

  // Diagnostic: post-backfill category distribution across the
  // GAIN-curated set. Useful for sanity-checking that pork/beef/
  // poultry/dairy etc. are now represented.
  const dist = await db.execute(sql`
    SELECT cat, count(*)::int AS n
    FROM (
      SELECT unnest(categories) AS cat
      FROM known_entities
      WHERE 'gain-curated' = ANY(tags)
    ) m
    GROUP BY cat
    ORDER BY n DESC
  `);
  console.log('\n[backfill-gain-categories] category distribution after backfill:');
  for (const r of dist.rows as Array<{ cat: string; n: number }>) {
    console.log(`  ${String(r.n).padStart(4, ' ')}  ${r.cat}`);
  }
}

main().catch((err) => {
  console.error('[backfill-gain-categories] FAILED', err);
  process.exit(1);
});
