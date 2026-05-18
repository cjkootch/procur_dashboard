/**
 * Backfill known_entities.state from the data we already have on hand.
 *
 * Two source paths:
 *
 *   1. **FSIS MPI shadow rolodex.** Every `mpi-fsis-*` slug is
 *      back-pointed by `usda_fsis_establishments.linked_known_entity_slug`,
 *      and the establishment row carries `state` directly (TX, IA, etc.)
 *      from the USDA CSV. Single UPDATE joining on the back-pointer.
 *
 *   2. **US grain seed.** The 29 seeded merchants carry their HQ in
 *      notes as "Headquarters: <City>, <ST>." — parse the trailing ST
 *      out and stamp.
 *
 * Idempotent: skips rows with state already set. Re-running is safe.
 *
 * Run from repo root:
 *   pnpm --filter @procur/db backfill-known-entity-state
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

  // ── Pass 1: FSIS MPI back-pointer copy ─────────────────────────
  const fsisResult = await db.execute(sql`
    WITH src AS (
      SELECT u.linked_known_entity_slug AS slug,
             upper(u.state) AS state
      FROM usda_fsis_establishments u
      WHERE u.linked_known_entity_slug IS NOT NULL
        AND u.state IS NOT NULL
        AND length(u.state) = 2
    )
    UPDATE known_entities ke
    SET state = src.state
    FROM src
    WHERE ke.slug = src.slug
      AND ke.state IS NULL
    RETURNING ke.slug
  `);
  console.log(
    `[backfill-state] FSIS MPI: stamped ${fsisResult.rows.length} entities.`,
  );

  // ── Pass 2: us-grain-seed HQ parse ─────────────────────────────
  // The seed notes end with "Headquarters: <City>, <ST>." The regex
  // anchors on the trailing `, ST.` to avoid false positives like
  // "based in Chicago, Illinois" written as prose elsewhere.
  const grainResult = await db.execute(sql`
    UPDATE known_entities ke
    SET state = upper((m.match)[1])
    FROM (
      SELECT slug,
             regexp_match(notes, 'Headquarters:[^.]*,\\s+([A-Z]{2})(?:\\s|\\.|$)') AS match
      FROM known_entities
      WHERE 'us-grain-seed' = ANY(tags)
        AND state IS NULL
        AND notes IS NOT NULL
    ) m
    WHERE ke.slug = m.slug
      AND m.match IS NOT NULL
    RETURNING ke.slug
  `);
  console.log(
    `[backfill-state] us-grain-seed: stamped ${grainResult.rows.length} entities.`,
  );

  // ── Diagnostic: how many still null per source ─────────────────
  const pending = await db.execute(sql`
    SELECT
      count(*) FILTER (WHERE country = 'US' AND state IS NULL) AS us_null,
      count(*) FILTER (WHERE country = 'US' AND state IS NOT NULL) AS us_stamped,
      count(*) FILTER (WHERE country = 'CA' AND state IS NULL) AS ca_null,
      count(*) FILTER (WHERE state IS NOT NULL) AS total_stamped
    FROM known_entities
  `);
  const row = pending.rows[0] as {
    us_null: number;
    us_stamped: number;
    ca_null: number;
    total_stamped: number;
  };
  console.log(
    `[backfill-state] coverage — US stamped=${row.us_stamped} null=${row.us_null}; CA null=${row.ca_null}; total stamped=${row.total_stamped}.`,
  );
}

main().catch((err) => {
  console.error('[backfill-state] FAILED', err);
  process.exit(1);
});
