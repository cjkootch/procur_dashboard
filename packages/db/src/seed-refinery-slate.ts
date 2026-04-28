/**
 * Tag refineries in `known_entities` with crude-grade compatibility.
 *
 * Two outputs per matched refinery:
 *   - tags: 'compatible:<grade-slug>' for each grade the refinery can run
 *   - metadata.slate: { min_api, max_api, max_sulfur_pct, source_notes }
 *     describing the diet window the analyst has researched
 *
 * Match strategy: case-insensitive substring match on known_entities.name
 * OR aliases. We keep the curated list small + targeted (the Libyan
 * deal's Tier-1/2 buyer pool from libyan-crude-buyer-brief.md), not
 * exhaustive — this is meant to seed the most-actionable subset.
 *
 * Re-run safe (idempotent — tags + metadata get unioned/replaced).
 *
 * Run: pnpm --filter @procur/db seed-refinery-slate
 */
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { sql } from 'drizzle-orm';
import * as schema from './schema';

loadEnv({ path: '../../.env.local' });
loadEnv({ path: '../../.env' });

type RefinerySlate = {
  /** Substrings to match against name OR any alias (case-insensitive,
      ANY match wins). Use the most distinctive fragment. */
  matchAny: string[];
  /** ISO-2 narrows the match — important because "Cartagena" exists in
      both Spain and Colombia. */
  country: string;
  /** Grade slugs (from crude_grades) the refinery is configured to run. */
  compatibleGrades: string[];
  /** Diet window — drives derived compatibility for grades not explicitly
      enumerated above. */
  slate: {
    minApi: number;
    maxApi: number;
    maxSulfurPct: number;
    sourceNotes: string;
  };
};

/**
 * Curated from libyan-crude-buyer-brief.md Tiers 1 + 2 plus a handful
 * of commonly-cited adjacent buyers. Slate windows reflect what each
 * site is publicly known to run — not a guess.
 */
const SLATES: RefinerySlate[] = [
  // ── Tier 1: Italy (Eni-operated) ────────────────────────────
  {
    matchAny: ['Sannazzaro'],
    country: 'IT',
    compatibleGrades: ['es-sider', 'sirtica', 'brega', 'sharara', 'azeri-light', 'bonny-light', 'qua-iboe', 'saharan-blend', 'cpc-blend'],
    slate: {
      minApi: 28,
      maxApi: 50,
      maxSulfurPct: 1.0,
      sourceNotes: 'Eni Sannazzaro — sweet-diet complex, hydrocracker + FCC. Configured for Mediterranean + WAF light sweets. Mellitah JV preferential access to Es Sider.',
    },
  },
  {
    matchAny: ['Taranto'],
    country: 'IT',
    compatibleGrades: ['es-sider', 'sirtica', 'brega', 'azeri-light', 'bonny-light', 'qua-iboe'],
    slate: {
      minApi: 28,
      maxApi: 45,
      maxSulfurPct: 1.0,
      sourceNotes: 'Eni Taranto — light-sweet runner; same buyer pool / commercial channel as Sannazzaro.',
    },
  },
  {
    matchAny: ['Saras', 'Sarroch'],
    country: 'IT',
    compatibleGrades: ['es-sider', 'sirtica', 'brega', 'sharara', 'azeri-light', 'bonny-light', 'qua-iboe', 'kirkuk', 'arab-light', 'arab-medium', 'urals'],
    slate: {
      minApi: 22,
      maxApi: 50,
      maxSulfurPct: 3.0,
      sourceNotes: 'Saras Sarroch — highest-complexity Med refinery (NCI ~14). Coker + hydrocracker. Will run almost anything; commercial preference now via Vitol JV.',
    },
  },

  // ── Tier 1: Spain (Repsol) ──────────────────────────────────
  {
    matchAny: ['Cartagena'],
    country: 'ES',
    compatibleGrades: ['es-sider', 'sirtica', 'brega', 'sharara', 'bonny-light', 'qua-iboe', 'azeri-light', 'cpc-blend', 'arab-light', 'urals'],
    slate: {
      minApi: 22,
      maxApi: 50,
      maxSulfurPct: 3.0,
      sourceNotes: 'Repsol Cartagena — full-conversion complex (coker + hydrocracker). Diverse diet incl. Russian + Latin heavies pre-sanctions; Sahara/Libya sweets baseline.',
    },
  },
  {
    matchAny: ['Petronor', 'Bilbao', 'Muskiz'],
    country: 'ES',
    compatibleGrades: ['es-sider', 'sirtica', 'brega', 'bonny-light', 'qua-iboe', 'azeri-light', 'arab-light', 'urals'],
    slate: {
      minApi: 25,
      maxApi: 50,
      maxSulfurPct: 2.5,
      sourceNotes: 'Repsol Petronor (Bilbao/Muskiz) — complex coastal refinery; consistent Libyan and WAF buyer.',
    },
  },

  // ── Tier 1: Indian state refiners ───────────────────────────
  {
    matchAny: ['Paradip'],
    country: 'IN',
    compatibleGrades: ['es-sider', 'bonny-light', 'qua-iboe', 'arab-light', 'arab-medium', 'arab-heavy', 'basrah-light', 'urals', 'cpc-blend'],
    slate: {
      minApi: 21,
      maxApi: 50,
      maxSulfurPct: 4.0,
      sourceNotes: 'IOCL Paradip — 300 kbd full-conversion coastal complex. Most flexible diet of Indian state refineries.',
    },
  },
  {
    matchAny: ['Kochi'],
    country: 'IN',
    compatibleGrades: ['es-sider', 'bonny-light', 'arab-light', 'arab-medium', 'basrah-light', 'urals'],
    slate: {
      minApi: 25,
      maxApi: 45,
      maxSulfurPct: 2.5,
      sourceNotes: 'BPCL Kochi — complex coastal refinery, active spot tender buyer.',
    },
  },
  {
    matchAny: ['Mangalore', 'MRPL'],
    country: 'IN',
    compatibleGrades: ['es-sider', 'bonny-light', 'arab-light', 'arab-medium', 'basrah-light', 'urals'],
    slate: {
      minApi: 25,
      maxApi: 45,
      maxSulfurPct: 2.5,
      sourceNotes: 'MRPL Mangalore — complex coastal refinery, active spot tender buyer.',
    },
  },

  // ── Tier 2: Greece (HelleniQ) ──────────────────────────────
  {
    matchAny: ['Aspropyrgos'],
    country: 'GR',
    compatibleGrades: ['es-sider', 'sirtica', 'brega', 'azeri-light', 'bonny-light', 'qua-iboe', 'arab-light', 'urals'],
    slate: {
      minApi: 25,
      maxApi: 50,
      maxSulfurPct: 2.0,
      sourceNotes: 'HelleniQ Aspropyrgos — historical Libyan crude buyer. Geographic adjacency.',
    },
  },
  {
    matchAny: ['Elefsina'],
    country: 'GR',
    compatibleGrades: ['es-sider', 'sirtica', 'brega', 'azeri-light', 'bonny-light', 'qua-iboe', 'arab-light', 'arab-medium', 'urals'],
    slate: {
      minApi: 22,
      maxApi: 50,
      maxSulfurPct: 3.0,
      sourceNotes: 'HelleniQ Elefsina — full-conversion complex with coker. Took the heaviest slate of HelleniQ assets.',
    },
  },

  // ── Tier 2: Hungary + Croatia (MOL group) ──────────────────
  {
    matchAny: ['Százhalombatta', 'Szazhalombatta', 'Danube'],
    country: 'HU',
    compatibleGrades: ['es-sider', 'sirtica', 'brega', 'azeri-light', 'bonny-light', 'urals', 'cpc-blend'],
    slate: {
      minApi: 28,
      maxApi: 45,
      maxSulfurPct: 2.0,
      sourceNotes: 'MOL Százhalombatta (Danube) — pivoting away from Russian Urals post-sanctions; Adria pipeline brings Med crude inland.',
    },
  },
  {
    matchAny: ['Rijeka'],
    country: 'HR',
    compatibleGrades: ['es-sider', 'sirtica', 'brega', 'azeri-light', 'bonny-light', 'arab-light', 'urals'],
    slate: {
      minApi: 25,
      maxApi: 45,
      maxSulfurPct: 2.0,
      sourceNotes: 'INA Rijeka (MOL group) — Adriatic coastal refinery. Med crude pool buyer.',
    },
  },

  // ── Tier 2: Turkey (TÜPRAŞ) ────────────────────────────────
  {
    matchAny: ['İzmit', 'Izmit'],
    country: 'TR',
    compatibleGrades: ['es-sider', 'sirtica', 'brega', 'azeri-light', 'kirkuk', 'arab-light', 'arab-medium', 'urals'],
    slate: {
      minApi: 22,
      maxApi: 50,
      maxSulfurPct: 3.0,
      sourceNotes: 'TÜPRAŞ İzmit — flagship Turkish refinery, full-conversion complex. Heavy historical Russian-crude diet; sweet-crude flexibility exists.',
    },
  },
  {
    matchAny: ['İzmir', 'Izmir', 'Aliağa', 'Aliaga'],
    country: 'TR',
    compatibleGrades: ['es-sider', 'sirtica', 'brega', 'azeri-light', 'kirkuk', 'arab-light', 'urals'],
    slate: {
      minApi: 25,
      maxApi: 45,
      maxSulfurPct: 2.5,
      sourceNotes: 'TÜPRAŞ İzmir (Aliağa) — coastal refinery, Mediterranean crude pool.',
    },
  },
  {
    matchAny: ['Kırıkkale', 'Kirikkale'],
    country: 'TR',
    compatibleGrades: ['azeri-light', 'kirkuk', 'arab-light', 'urals'],
    slate: {
      minApi: 28,
      maxApi: 42,
      maxSulfurPct: 2.0,
      sourceNotes: 'TÜPRAŞ Kırıkkale — inland refinery, BTC pipeline-served (Azeri Light).',
    },
  },

  // ── Adjacent: Israel + Cyprus + France (light-sweet runners) ─
  {
    matchAny: ['Ashdod'],
    country: 'IL',
    compatibleGrades: ['es-sider', 'azeri-light', 'bonny-light', 'qua-iboe', 'cpc-blend'],
    slate: {
      minApi: 30,
      maxApi: 45,
      maxSulfurPct: 1.0,
      sourceNotes: 'Paz Ashdod — light-sweet diet refinery.',
    },
  },
  {
    matchAny: ['La Mède', 'La Mede'],
    country: 'FR',
    compatibleGrades: ['es-sider', 'sirtica', 'azeri-light', 'bonny-light'],
    slate: {
      minApi: 30,
      maxApi: 45,
      maxSulfurPct: 1.0,
      sourceNotes: 'TotalEnergies La Mède — light-sweet only post-conversion to biofuels. Limited remaining crude capacity.',
    },
  },
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');

  const client = neon(url);
  const db = drizzle(client, { schema, casing: 'snake_case' });

  let updatedRows = 0;
  let unmatched = 0;

  for (const seed of SLATES) {
    // Build an OR-of-LIKEs over name + any alias. ILIKE for
    // case-insensitive matching.
    const likes = seed.matchAny.flatMap((m) => [`%${m}%`]);
    const result = await db.execute(sql`
      SELECT slug, name, tags, metadata
      FROM known_entities
      WHERE country = ${seed.country}
        AND role = 'refiner'
        AND (
          ${sql.join(
            likes.map(
              (l) => sql`name ILIKE ${l} OR EXISTS (
                SELECT 1 FROM unnest(aliases) AS a WHERE a ILIKE ${l}
              )`,
            ),
            sql` OR `,
          )}
        )
      LIMIT 5;
    `);
    const rows = result.rows as Array<{
      slug: string;
      name: string;
      tags: string[] | null;
      metadata: Record<string, unknown> | null;
    }>;
    if (rows.length === 0) {
      console.warn(
        `  no match: ${seed.matchAny.join(' / ')} [${seed.country}] — skipping`,
      );
      unmatched += 1;
      continue;
    }

    const compatibilityTags = seed.compatibleGrades.map((g) => `compatible:${g}`);
    for (const row of rows) {
      const existingTags = new Set(row.tags ?? []);
      for (const t of compatibilityTags) existingTags.add(t);
      // Strip stale compatible:* tags that aren't in the new set so a
      // re-seed cleans up after a list change.
      const newTags = [...existingTags].filter((t) => {
        if (!t.startsWith('compatible:')) return true;
        return compatibilityTags.includes(t);
      });
      const newMetadata = {
        ...(row.metadata ?? {}),
        slate: {
          min_api: seed.slate.minApi,
          max_api: seed.slate.maxApi,
          max_sulfur_pct: seed.slate.maxSulfurPct,
          source_notes: seed.slate.sourceNotes,
        },
      };
      await db
        .update(schema.knownEntities)
        .set({
          tags: newTags,
          metadata: newMetadata,
          updatedAt: new Date(),
        })
        .where(sql`slug = ${row.slug}`);
      console.log(`  + ${row.name} [${seed.country}]: tagged ${compatibilityTags.length} grades`);
      updatedRows += 1;
    }
  }

  console.log(
    `Done. ${updatedRows} entity rows updated; ${unmatched} curated entries had no match (probably missing from rolodex).`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
