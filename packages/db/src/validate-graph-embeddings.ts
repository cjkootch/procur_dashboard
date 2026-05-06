/**
 * Smoke-test the GraphSAGE embeddings end-to-end. Picks a seed
 * entity (CLI arg or a sample from the table), prints its top-N
 * cosine neighbors via raw pgvector. Validates that:
 *
 *   1. entity_embeddings has rows for the requested kind
 *   2. the HNSW index returns plausible neighbors
 *   3. the embeddings discriminate (not all sims ≈ 1.0)
 *
 * Lives in @procur/db rather than @procur/catalog because catalog
 * is server-only — its imports throw outside Next runtime. We do
 * the cosine query directly here.
 *
 * Run:
 *   pnpm --filter @procur/db validate-graph-embeddings
 *   pnpm --filter @procur/db validate-graph-embeddings --slug=<slug>
 *   pnpm --filter @procur/db validate-graph-embeddings --kind=graph_v1
 */
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { sql } from 'drizzle-orm';
import { db } from './client';

loadEnv({ path: '../../.env.local' });
loadEnv({ path: '../../.env' });

const DEFAULT_KIND = 'graph_v1';
const TOP_N = 10;

type NeighborRow = {
  slug: string;
  name: string;
  country: string;
  role: string;
  similarity: number;
};

async function pickSampleSlug(kind: string): Promise<string | null> {
  const result = await db.execute(sql`
    SELECT entity_slug FROM entity_embeddings
     WHERE embedding_kind = ${kind}
     ORDER BY entity_slug
     LIMIT 1;
  `);
  const rows = result.rows as unknown as Array<{ entity_slug: string }>;
  return rows[0]?.entity_slug ?? null;
}

async function findSimilar(slug: string, kind: string, limit: number): Promise<NeighborRow[]> {
  const result = await db.execute(sql`
    WITH src AS (
      SELECT embedding FROM entity_embeddings
       WHERE entity_slug = ${slug}
         AND embedding_kind = ${kind}
       ORDER BY trained_at DESC
       LIMIT 1
    )
    SELECT
      ke.slug,
      ke.name,
      ke.country,
      ke.role,
      (1 - (ee.embedding <=> src.embedding))::float8 AS similarity
      FROM entity_embeddings ee
      JOIN known_entities ke ON ke.slug = ee.entity_slug
      CROSS JOIN src
     WHERE ee.embedding_kind = ${kind}
       AND ee.entity_slug != ${slug}
     ORDER BY ee.embedding <=> src.embedding
     LIMIT ${limit};
  `);
  return result.rows as unknown as NeighborRow[];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const slugArg = args.find((a) => a.startsWith('--slug='))?.split('=')[1];
  const kind = args.find((a) => a.startsWith('--kind='))?.split('=')[1] ?? DEFAULT_KIND;

  const slug = slugArg ?? (await pickSampleSlug(kind));
  if (!slug) {
    console.error(`no rows in entity_embeddings for kind=${kind}; did upsert run?`);
    process.exit(1);
  }

  console.log(`validate-graph-embeddings — slug=${slug}, kind=${kind}, top=${TOP_N}\n`);

  const neighbors = await findSimilar(slug, kind, TOP_N);
  if (neighbors.length === 0) {
    console.error(`no neighbors found — embedding for ${slug} may be missing or all sims tied at zero`);
    process.exit(1);
  }

  console.log(`Top ${neighbors.length} cosine neighbors of ${slug}:\n`);
  console.log(`  rank  similarity  slug                                                  name`);
  console.log(`  ----  ----------  ----------------------------------------------------  ----`);
  for (let i = 0; i < neighbors.length; i += 1) {
    const n = neighbors[i];
    if (!n) continue;
    const sim = Number(n.similarity).toFixed(4);
    const slugCol = n.slug.padEnd(52).slice(0, 52);
    console.log(`  ${String(i + 1).padStart(4)}  ${sim.padStart(10)}  ${slugCol}  ${n.name}`);
  }

  const distinct = new Set(neighbors.map((n) => Number(n.similarity).toFixed(2))).size;
  console.log(`\n  ${distinct} distinct similarity buckets in top ${neighbors.length}`);
  if (distinct === 1) {
    console.warn(
      '\n  WARN: every neighbor has the same similarity — embeddings may be degenerate ' +
        '(no edges → no structural signal). Expected when the graph is sparse.',
    );
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
