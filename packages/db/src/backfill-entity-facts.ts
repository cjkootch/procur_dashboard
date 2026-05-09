/**
 * One-shot script: backfill `entity_facts` from existing
 * known_entities columns. Each known_entity becomes:
 *   - one fact (fact_type='company_role', source='ingest') from the
 *     entity's `role` column when set
 *   - N facts (fact_type='product_category', source='ingest') from
 *     the entity's `categories[]` column
 *
 * Idempotent via the partial unique index on (entity_slug,
 * fact_type, value, source) WHERE superseded_at IS NULL — re-running
 * the script is a no-op for facts that already exist.
 *
 * Run from repo root:
 *   pnpm --filter @procur/db backfill-entity-facts
 *
 * Phase 1 of the entity-cleanup architecture. Doesn't backfill
 * `industry` or `market_segment` — those don't have authoritative
 * source columns today; later phases will produce them via the
 * model classifier (source='model').
 */
import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from './schema';

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL not set');
    process.exit(1);
  }
  const sqlClient = neon(databaseUrl);
  const db = drizzle(sqlClient, { schema });

  console.log('Reading known_entities...');
  const entities = await db.select().from(schema.knownEntities);
  console.log(`  ${entities.length} entities to scan`);

  const rows: schema.NewEntityFact[] = [];
  let roleCount = 0;
  let categoryCount = 0;

  for (const e of entities) {
    if (e.role && e.role.trim().length > 0) {
      rows.push({
        entitySlug: e.slug,
        factType: 'company_role',
        value: e.role,
        source: 'ingest',
        evidenceJson: { backfilledFrom: 'known_entities.role' },
      });
      roleCount += 1;
    }
    const cats = e.categories ?? [];
    for (const cat of cats) {
      if (typeof cat !== 'string' || cat.trim().length === 0) continue;
      rows.push({
        entitySlug: e.slug,
        factType: 'product_category',
        value: cat,
        source: 'ingest',
        evidenceJson: { backfilledFrom: 'known_entities.categories' },
      });
      categoryCount += 1;
    }
  }

  console.log(
    `  built ${rows.length} candidate facts (${roleCount} role, ${categoryCount} category)`,
  );

  if (rows.length === 0) {
    console.log('Nothing to insert.');
    return;
  }

  // Insert in chunks of 500 — neon-http has a limited statement
  // size and inserting 30k rows in one shot will exceed it.
  const CHUNK = 500;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const result = await db
      .insert(schema.entityFacts)
      .values(slice)
      .onConflictDoNothing()
      .returning({ id: schema.entityFacts.id });
    inserted += result.length;
    console.log(
      `  inserted ${Math.min(i + CHUNK, rows.length)}/${rows.length} (${result.length} new in this chunk)`,
    );
  }

  console.log(`Backfill done: ${inserted} new facts inserted.`);
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
