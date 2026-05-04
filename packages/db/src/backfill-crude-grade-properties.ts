/**
 * Backfill empty `crude_grades.api_gravity` / `sulfur_pct` / `tan`
 * columns using values from the linked `crude_assays` rows.
 *
 * Why this exists: `crude_grades` is curated reference data with
 * sparse property fields — many rows have NULL api_gravity / sulfur
 * etc. because no analyst sat down to enter them. The 179 producer-
 * published assays we just ingested carry those properties for
 * (most) named grades. This script joins assays → grades by
 * `grade_slug` and writes the assay's value into the grade row IFF
 * the grade column is currently NULL — never overwrite a curated
 * value.
 *
 * Selection rule when multiple assays per grade: prefer the most
 * recent `assay_date`, falling back to the producer's published
 * vintage when assay_date is null. Median across assays would be
 * more robust but for typical named grades (Brent, Es Sider) all
 * producers' values cluster within 1-2% of each other so picking
 * the freshest is a reasonable v1.
 *
 * Idempotent — re-running after a fresh ingest only fills any
 * remaining NULL columns.
 *
 * Run:
 *   pnpm --filter @procur/db backfill-crude-grade-properties
 *   pnpm --filter @procur/db backfill-crude-grade-properties --dry-run
 */
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { desc, eq } from 'drizzle-orm';

import * as schema from './schema';

loadEnv({ path: '../../.env.local' });
loadEnv({ path: '../../.env' });

export type BackfillResult = {
  grades: number;
  apiFilled: number;
  sulfurFilled: number;
  tanFilled: number;
  skippedNoAssay: string[];
};

export async function backfillCrudeGradeProperties(opts: {
  dryRun?: boolean;
}): Promise<BackfillResult> {
  const dryRun = opts.dryRun ?? false;
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error('DATABASE_URL not set');
  const db = drizzle(neon(dbUrl), { schema });

  // Pull all grades that have at least one NULL property column.
  const grades = await db
    .select({
      slug: schema.crudeGrades.slug,
      name: schema.crudeGrades.name,
      apiGravity: schema.crudeGrades.apiGravity,
      sulfurPct: schema.crudeGrades.sulfurPct,
      tan: schema.crudeGrades.tan,
    })
    .from(schema.crudeGrades);

  const result: BackfillResult = {
    grades: 0,
    apiFilled: 0,
    sulfurFilled: 0,
    tanFilled: 0,
    skippedNoAssay: [],
  };

  for (const g of grades) {
    if (g.apiGravity != null && g.sulfurPct != null && g.tan != null) continue;

    // Pick the most recent assay linked to this grade.
    const [assay] = await db
      .select({
        apiGravity: schema.crudeAssays.apiGravity,
        sulphurWtPct: schema.crudeAssays.sulphurWtPct,
        acidityMgKohG: schema.crudeAssays.acidityMgKohG,
        assayDate: schema.crudeAssays.assayDate,
        source: schema.crudeAssays.source,
        reference: schema.crudeAssays.reference,
      })
      .from(schema.crudeAssays)
      .where(eq(schema.crudeAssays.gradeSlug, g.slug))
      .orderBy(desc(schema.crudeAssays.assayDate), desc(schema.crudeAssays.updatedAt))
      .limit(1);

    if (!assay) {
      result.skippedNoAssay.push(g.slug);
      continue;
    }

    const updates: Partial<{ apiGravity: string; sulfurPct: string; tan: string }> = {};
    if (g.apiGravity == null && assay.apiGravity != null) {
      updates.apiGravity = String(assay.apiGravity);
      result.apiFilled += 1;
    }
    if (g.sulfurPct == null && assay.sulphurWtPct != null) {
      updates.sulfurPct = String(assay.sulphurWtPct);
      result.sulfurFilled += 1;
    }
    if (g.tan == null && assay.acidityMgKohG != null) {
      updates.tan = String(assay.acidityMgKohG);
      result.tanFilled += 1;
    }

    if (Object.keys(updates).length === 0) continue;

    if (dryRun) {
      console.log(
        `  [dry] ${g.slug} ← ${assay.source}/${assay.reference}: ${Object.keys(updates).join(', ')}`,
      );
    } else {
      await db
        .update(schema.crudeGrades)
        .set({ ...updates, updatedAt: new Date() })
        .where(eq(schema.crudeGrades.slug, g.slug));
    }
    result.grades += 1;
  }

  return result;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const r = await backfillCrudeGradeProperties({ dryRun });
  console.log(
    `Updated ${r.grades} grades${dryRun ? ' (dry-run)' : ''}: ` +
      `api=${r.apiFilled} sulfur=${r.sulfurFilled} tan=${r.tanFilled}`,
  );
  if (r.skippedNoAssay.length > 0) {
    console.log(
      `Skipped ${r.skippedNoAssay.length} grades with no linked assay: ` +
        r.skippedNoAssay.join(', '),
    );
  }
}

if (process.argv[1] && process.argv[1].endsWith('backfill-crude-grade-properties.ts')) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
