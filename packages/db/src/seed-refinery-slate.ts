/**
 * Tag refineries in `known_entities` with crude-grade compatibility.
 *
 * Two outputs per matched refinery:
 *   - tags: 'compatible:<grade-slug>' for each grade the refinery can run
 *   - metadata.slate: structured RefinerySlateCapability envelope
 *     (camelCase keys — apiMin/apiMax/sulfurMaxPct/tanMax/
 *     vanadiumMaxPpm/nickelMaxPpm/acidicTolerance/
 *     crudeUnitCapacityBpd/complexityIndex/notes). Schema lives in
 *     `@procur/catalog/slate-capability.ts` and is consumed by the
 *     `refinery_grade_compatibility` view (migration 0057).
 *
 * Match strategy: case-insensitive substring match on known_entities.name
 * OR aliases. We keep the curated list small + targeted (the Libyan
 * deal's Tier-1/2 buyer pool from libyan-crude-buyer-brief.md), not
 * exhaustive — this is meant to seed the most-actionable subset.
 *
 * Re-run safe (idempotent — tags + metadata get unioned/replaced).
 * Re-running after the camelCase migration replaces any legacy
 * snake_case slate keys (min_api, max_api, …) with the new shape.
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
  /** Slate capability envelope. camelCase keys; consumed by
   *  refinery_grade_compatibility view + the
   *  RefinerySlateCapability schema in @procur/catalog. Optional
   *  numeric fields are omitted (not zero) when not characterized. */
  slate: {
    apiMin: number;
    apiMax: number;
    sulfurMaxPct: number;
    /** Total acid number ceiling (mg KOH/g). Default 0.5 unless
     *  the refinery is specifically high-TAN tolerant. */
    tanMax?: number;
    vanadiumMaxPpm?: number;
    nickelMaxPpm?: number;
    acidicTolerance?: boolean;
    /** Crude unit nameplate, bpd. From IEA / company disclosure. */
    crudeUnitCapacityBpd?: number;
    /** Nelson Complexity Index. Public datapoint from the operator's
     *  annual report or IEA Energy Atlas. */
    complexityIndex?: number;
    /** Was `sourceNotes` in the legacy schema. Free-form. */
    notes: string;
  };
};

/**
 * Curated from libyan-crude-buyer-brief.md Tiers 1 + 2 plus a handful
 * of commonly-cited adjacent buyers. Slate windows reflect what each
 * site is publicly known to run — not a guess. Capacity + NCI from
 * IEA Energy Atlas / operator annual reports / company press releases.
 */
const SLATES: RefinerySlate[] = [
  // ── Tier 1: Italy (Eni-operated) ────────────────────────────
  {
    matchAny: ['Sannazzaro'],
    country: 'IT',
    compatibleGrades: ['es-sider', 'sirtica', 'brega', 'sharara', 'azeri-light', 'bonny-light', 'qua-iboe', 'saharan-blend', 'cpc-blend'],
    slate: {
      apiMin: 28,
      apiMax: 50,
      sulfurMaxPct: 1.0,
      tanMax: 0.5,
      crudeUnitCapacityBpd: 190_000,
      complexityIndex: 9.0,
      notes: 'Eni Sannazzaro — sweet-diet complex, hydrocracker + FCC. Configured for Mediterranean + WAF light sweets. Mellitah JV preferential access to Es Sider.',
    },
  },
  {
    matchAny: ['Taranto'],
    country: 'IT',
    compatibleGrades: ['es-sider', 'sirtica', 'brega', 'azeri-light', 'bonny-light', 'qua-iboe'],
    slate: {
      apiMin: 28,
      apiMax: 45,
      sulfurMaxPct: 1.0,
      tanMax: 0.3,
      crudeUnitCapacityBpd: 120_000,
      complexityIndex: 6.5,
      notes: 'Eni Taranto — hydroskimming, light-sweet runner; same buyer pool / commercial channel as Sannazzaro.',
    },
  },
  {
    matchAny: ['Saras', 'Sarroch'],
    country: 'IT',
    compatibleGrades: ['es-sider', 'sirtica', 'brega', 'sharara', 'azeri-light', 'bonny-light', 'qua-iboe', 'kirkuk', 'arab-light', 'arab-medium', 'urals'],
    slate: {
      apiMin: 22,
      apiMax: 50,
      sulfurMaxPct: 3.0,
      tanMax: 0.8,
      vanadiumMaxPpm: 250,
      nickelMaxPpm: 80,
      crudeUnitCapacityBpd: 300_000,
      complexityIndex: 14.0,
      acidicTolerance: true,
      notes: 'Saras Sarroch — highest-complexity Med refinery (NCI ~14). Coker + hydrocracker. Will run almost anything; commercial preference now via Vitol JV.',
    },
  },

  // ── Tier 1: Spain (Repsol) ──────────────────────────────────
  {
    matchAny: ['Cartagena'],
    country: 'ES',
    compatibleGrades: ['es-sider', 'sirtica', 'brega', 'sharara', 'bonny-light', 'qua-iboe', 'azeri-light', 'cpc-blend', 'arab-light', 'urals'],
    slate: {
      apiMin: 22,
      apiMax: 50,
      sulfurMaxPct: 3.0,
      tanMax: 0.7,
      vanadiumMaxPpm: 200,
      nickelMaxPpm: 60,
      crudeUnitCapacityBpd: 220_000,
      complexityIndex: 12.0,
      notes: 'Repsol Cartagena — full-conversion complex (coker + hydrocracker). Diverse diet incl. Russian + Latin heavies pre-sanctions; Sahara/Libya sweets baseline.',
    },
  },
  {
    matchAny: ['Petronor', 'Bilbao', 'Muskiz'],
    country: 'ES',
    compatibleGrades: ['es-sider', 'sirtica', 'brega', 'bonny-light', 'qua-iboe', 'azeri-light', 'arab-light', 'urals'],
    slate: {
      apiMin: 25,
      apiMax: 50,
      sulfurMaxPct: 2.5,
      tanMax: 0.5,
      crudeUnitCapacityBpd: 220_000,
      complexityIndex: 9.0,
      notes: 'Repsol Petronor (Bilbao/Muskiz) — mid-complexity coastal refinery; consistent Libyan and WAF buyer.',
    },
  },

  // ── Tier 1: Indian state refiners ───────────────────────────
  {
    matchAny: ['Paradip'],
    country: 'IN',
    compatibleGrades: ['es-sider', 'bonny-light', 'qua-iboe', 'arab-light', 'arab-medium', 'arab-heavy', 'basrah-light', 'urals', 'cpc-blend'],
    slate: {
      apiMin: 21,
      apiMax: 50,
      sulfurMaxPct: 4.0,
      tanMax: 1.0,
      vanadiumMaxPpm: 350,
      nickelMaxPpm: 100,
      crudeUnitCapacityBpd: 300_000,
      complexityIndex: 12.2,
      acidicTolerance: true,
      notes: 'IOCL Paradip — 300 kbd full-conversion coastal complex. Most flexible diet of Indian state refineries.',
    },
  },
  {
    matchAny: ['Kochi'],
    country: 'IN',
    compatibleGrades: ['es-sider', 'bonny-light', 'arab-light', 'arab-medium', 'basrah-light', 'urals'],
    slate: {
      apiMin: 25,
      apiMax: 45,
      sulfurMaxPct: 2.5,
      tanMax: 0.5,
      crudeUnitCapacityBpd: 310_000,
      complexityIndex: 9.0,
      notes: 'BPCL Kochi — complex coastal refinery, active spot tender buyer.',
    },
  },
  {
    matchAny: ['Mangalore', 'MRPL'],
    country: 'IN',
    compatibleGrades: ['es-sider', 'bonny-light', 'arab-light', 'arab-medium', 'basrah-light', 'urals'],
    slate: {
      apiMin: 25,
      apiMax: 45,
      sulfurMaxPct: 2.5,
      tanMax: 0.5,
      crudeUnitCapacityBpd: 300_000,
      complexityIndex: 9.0,
      notes: 'MRPL Mangalore — complex coastal refinery, active spot tender buyer.',
    },
  },

  // ── Tier 2: Greece (HelleniQ) ──────────────────────────────
  {
    matchAny: ['Aspropyrgos'],
    country: 'GR',
    compatibleGrades: ['es-sider', 'sirtica', 'brega', 'azeri-light', 'bonny-light', 'qua-iboe', 'arab-light', 'urals'],
    slate: {
      apiMin: 25,
      apiMax: 50,
      sulfurMaxPct: 2.0,
      tanMax: 0.4,
      crudeUnitCapacityBpd: 150_000,
      complexityIndex: 7.0,
      notes: 'HelleniQ Aspropyrgos — historical Libyan crude buyer. Geographic adjacency.',
    },
  },
  {
    matchAny: ['Elefsina'],
    country: 'GR',
    compatibleGrades: ['es-sider', 'sirtica', 'brega', 'azeri-light', 'bonny-light', 'qua-iboe', 'arab-light', 'arab-medium', 'urals'],
    slate: {
      apiMin: 22,
      apiMax: 50,
      sulfurMaxPct: 3.0,
      tanMax: 0.6,
      crudeUnitCapacityBpd: 100_000,
      complexityIndex: 9.0,
      notes: 'HelleniQ Elefsina — full-conversion complex with coker. Took the heaviest slate of HelleniQ assets.',
    },
  },

  // ── Tier 2: Hungary + Croatia (MOL group) ──────────────────
  {
    matchAny: ['Százhalombatta', 'Szazhalombatta', 'Danube'],
    country: 'HU',
    compatibleGrades: ['es-sider', 'sirtica', 'brega', 'azeri-light', 'bonny-light', 'urals', 'cpc-blend'],
    slate: {
      apiMin: 28,
      apiMax: 45,
      sulfurMaxPct: 2.0,
      tanMax: 0.4,
      crudeUnitCapacityBpd: 165_000,
      complexityIndex: 10.5,
      notes: 'MOL Százhalombatta (Danube) — pivoting away from Russian Urals post-sanctions; Adria pipeline brings Med crude inland.',
    },
  },
  {
    matchAny: ['Rijeka'],
    country: 'HR',
    compatibleGrades: ['es-sider', 'sirtica', 'brega', 'azeri-light', 'bonny-light', 'arab-light', 'urals'],
    slate: {
      apiMin: 25,
      apiMax: 45,
      sulfurMaxPct: 2.0,
      tanMax: 0.4,
      crudeUnitCapacityBpd: 90_000,
      complexityIndex: 7.0,
      notes: 'INA Rijeka (MOL group) — Adriatic coastal refinery. Med crude pool buyer.',
    },
  },

  // ── Tier 2: Turkey (TÜPRAŞ) ────────────────────────────────
  {
    matchAny: ['İzmit', 'Izmit'],
    country: 'TR',
    compatibleGrades: ['es-sider', 'sirtica', 'brega', 'azeri-light', 'kirkuk', 'arab-light', 'arab-medium', 'urals'],
    slate: {
      apiMin: 22,
      apiMax: 50,
      sulfurMaxPct: 3.0,
      tanMax: 0.5,
      crudeUnitCapacityBpd: 226_000,
      complexityIndex: 9.5,
      notes: 'TÜPRAŞ İzmit — flagship Turkish refinery, full-conversion complex. Heavy historical Russian-crude diet; sweet-crude flexibility exists.',
    },
  },
  {
    matchAny: ['İzmir', 'Izmir', 'Aliağa', 'Aliaga'],
    country: 'TR',
    compatibleGrades: ['es-sider', 'sirtica', 'brega', 'azeri-light', 'kirkuk', 'arab-light', 'urals'],
    slate: {
      apiMin: 25,
      apiMax: 45,
      sulfurMaxPct: 2.5,
      tanMax: 0.4,
      crudeUnitCapacityBpd: 226_000,
      complexityIndex: 7.0,
      notes: 'TÜPRAŞ İzmir (Aliağa) — coastal refinery, Mediterranean crude pool.',
    },
  },
  {
    matchAny: ['Kırıkkale', 'Kirikkale'],
    country: 'TR',
    compatibleGrades: ['azeri-light', 'kirkuk', 'arab-light', 'urals'],
    slate: {
      apiMin: 28,
      apiMax: 42,
      sulfurMaxPct: 2.0,
      tanMax: 0.3,
      crudeUnitCapacityBpd: 113_000,
      complexityIndex: 6.0,
      notes: 'TÜPRAŞ Kırıkkale — inland refinery, BTC pipeline-served (Azeri Light).',
    },
  },

  // ── Adjacent: Israel + Cyprus + France (light-sweet runners) ─
  {
    matchAny: ['Ashdod'],
    country: 'IL',
    compatibleGrades: ['es-sider', 'azeri-light', 'bonny-light', 'qua-iboe', 'cpc-blend'],
    slate: {
      apiMin: 30,
      apiMax: 45,
      sulfurMaxPct: 1.0,
      tanMax: 0.3,
      crudeUnitCapacityBpd: 100_000,
      complexityIndex: 9.0,
      notes: 'Paz Ashdod — light-sweet diet refinery.',
    },
  },
  {
    matchAny: ['La Mède', 'La Mede'],
    country: 'FR',
    compatibleGrades: ['es-sider', 'sirtica', 'azeri-light', 'bonny-light'],
    slate: {
      apiMin: 30,
      apiMax: 45,
      sulfurMaxPct: 1.0,
      tanMax: 0.3,
      crudeUnitCapacityBpd: 100_000,
      complexityIndex: 6.0,
      notes: 'TotalEnergies La Mède — light-sweet only post-conversion to biofuels. Limited remaining crude capacity.',
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
      // Build the slate envelope, omitting undefined fields so the
      // jsonb stays clean (consumers treat absent keys as
      // "unconstrained" — see refinery_grade_compatibility view).
      const slate: Record<string, unknown> = {
        apiMin: seed.slate.apiMin,
        apiMax: seed.slate.apiMax,
        sulfurMaxPct: seed.slate.sulfurMaxPct,
        notes: seed.slate.notes,
      };
      if (seed.slate.tanMax != null) slate.tanMax = seed.slate.tanMax;
      if (seed.slate.vanadiumMaxPpm != null) slate.vanadiumMaxPpm = seed.slate.vanadiumMaxPpm;
      if (seed.slate.nickelMaxPpm != null) slate.nickelMaxPpm = seed.slate.nickelMaxPpm;
      if (seed.slate.acidicTolerance != null) slate.acidicTolerance = seed.slate.acidicTolerance;
      if (seed.slate.crudeUnitCapacityBpd != null) {
        slate.crudeUnitCapacityBpd = seed.slate.crudeUnitCapacityBpd;
      }
      if (seed.slate.complexityIndex != null) {
        slate.complexityIndex = seed.slate.complexityIndex;
      }
      const newMetadata = {
        ...(row.metadata ?? {}),
        slate,
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
