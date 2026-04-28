/**
 * Diagnose + (optionally) repair entities damaged by the pre-role-aware
 * matcher. Two failure modes are possible from the original GOGPT run:
 *
 *   (a) Power-plant candidate merged into a same-priority refiner row
 *       (both source='gem'). Role stayed 'refiner', but `capacity_mw`
 *       and friends got grafted on. Easy to detect: role <> 'power-plant'
 *       AND metadata.capacity_mw IS NOT NULL.
 *
 *   (b) Power-plant candidate merged into a lower-priority refiner row
 *       (e.g. existing was 'wikidata', candidate was 'gem'). Higher-
 *       priority overwrote name / role / notes, so the row now
 *       *looks* like a normal power plant but its aliases still carry
 *       the original refinery name and the row's `wikidata_id` /
 *       wikidata aliases give it away.
 *
 * Run modes:
 *   --dry-run   Show counts + samples of (a) and (b). No writes.
 *   --repair-a  Strip GOGPT-only fields from (a) rows. After: re-run
 *               `ingest-gem-power-plants` to create proper power-plant
 *               rows.
 *   (no flag)   Default to --dry-run for safety.
 *
 * Case (b) needs analyst judgment to split — the script just reports.
 */
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { sql } from 'drizzle-orm';
import * as schema from './schema';

loadEnv({ path: '../../.env.local' });
loadEnv({ path: '../../.env' });

const POWER_PLANT_TAGS = ['power-plant', 'fuel:dual', 'fuel:oil', 'fuel:gas'];
const POWER_PLANT_META_KEYS = [
  'capacity_mw',
  'unit_count',
  'start_year',
  'fuels',
  'statuses',
];

async function main() {
  const repairA = process.argv.includes('--repair-a');
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL not set');
  const client = neon(databaseUrl);
  const db = drizzle(client, { schema });

  // Case A: role didn't flip but metadata leaked in.
  const caseA = (
    await db.execute(sql`
      SELECT slug, name, country, role, tags, metadata
      FROM known_entities
      WHERE role <> 'power-plant'
        AND metadata ? 'capacity_mw'
      ORDER BY country, name;
    `)
  ).rows as Array<{
    slug: string;
    name: string;
    country: string;
    role: string;
    tags: string[] | null;
    metadata: Record<string, unknown> | null;
  }>;

  // Case B: role flipped to power-plant, but the row carries refinery
  // residue. Heuristics:
  //   - aliases contains a string with "refinery" / "raffineri" / "raffinerie"
  //   - OR metadata has a wikidata_id / wikidata-source signal
  // Both heuristics together catch most realistic cases.
  const caseB = (
    await db.execute(sql`
      SELECT slug, name, country, aliases, tags, metadata
      FROM known_entities
      WHERE role = 'power-plant'
        AND (
          EXISTS (
            SELECT 1 FROM unnest(aliases) AS a
            WHERE lower(a) LIKE '%refinery%'
               OR lower(a) LIKE '%raffineri%'
          )
          OR metadata ? 'wikidata_id'
        )
      ORDER BY country, name;
    `)
  ).rows as Array<{
    slug: string;
    name: string;
    country: string;
    aliases: string[] | null;
    tags: string[] | null;
    metadata: Record<string, unknown> | null;
  }>;

  console.log(`Case A (refinery row with grafted power-plant data): ${caseA.length}`);
  for (const r of caseA.slice(0, 10)) {
    console.log(`  - [${r.country}] ${r.name} (role=${r.role})`);
  }
  if (caseA.length > 10) console.log(`  ... and ${caseA.length - 10} more`);

  console.log('');
  console.log(
    `Case B (role flipped from refiner→power-plant, refinery residue in aliases): ${caseB.length}`,
  );
  for (const r of caseB.slice(0, 10)) {
    const refineryAliases = (r.aliases ?? []).filter((a) =>
      /refinery|raffineri/i.test(a),
    );
    console.log(
      `  - [${r.country}] ${r.name} | refinery aliases: ${
        refineryAliases.slice(0, 2).join(' / ') || '(none — wikidata_id signal)'
      }`,
    );
  }
  if (caseB.length > 10) console.log(`  ... and ${caseB.length - 10} more`);

  if (!repairA) {
    console.log('');
    console.log('Diagnostic only. Pass --repair-a to strip case-A pollution.');
    console.log('Case B requires analyst judgment to split — not auto-repaired.');
    return;
  }

  let cleaned = 0;
  for (const r of caseA) {
    const newTags = (r.tags ?? []).filter((t) => !POWER_PLANT_TAGS.includes(t));
    const newMeta: Record<string, unknown> = { ...(r.metadata ?? {}) };
    for (const k of POWER_PLANT_META_KEYS) delete newMeta[k];
    await db
      .update(schema.knownEntities)
      .set({ tags: newTags, metadata: newMeta, updatedAt: new Date() })
      .where(sql`slug = ${r.slug}`);
    cleaned++;
  }
  console.log(`\nRepaired ${cleaned} case-A rows.`);
  console.log(
    'Next: re-run `pnpm --filter @procur/db ingest-gem-power-plants <path>` ' +
      'to materialize fresh power-plant rows for those plants.',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

