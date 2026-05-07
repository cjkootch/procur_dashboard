/**
 * One-shot: populate `known_entities.primary_domain` for rows that
 * pre-date PR #508. Chat-curated entities created before that fix
 * stuffed website_url into metadata only — primary_domain stayed
 * NULL, so Apollo enrichment, find_decision_makers_at_entity, and
 * mention-resolution all silently missed them.
 *
 * Reads metadata.website_url, derives the bare host, writes to
 * primary_domain. Idempotent — safe to re-run.
 *
 * After this lands, kick the Apollo backfill so the freshly-set
 * domains get linked to apollo_org_id:
 *   pnpm --filter ai-pipeline apollo-batch-enrich
 *
 * And refresh text embeddings (mention resolution):
 *   pnpm --filter @procur/ai seed-entity-text-embeddings
 *
 * Run: pnpm --filter @procur/db backfill-known-entity-primary-domain
 */
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { sql } from 'drizzle-orm';

loadEnv({ path: '../../.env.local' });
loadEnv({ path: '../../.env' });

/**
 * Mirror of apps/app/lib/assistant/apply.ts deriveDomainFromUrl —
 * keep these two implementations in sync. Returns null on garbage
 * so the UPDATE skips the row.
 */
function deriveDomainFromUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  try {
    const u = new URL(value.trim());
    return u.hostname.replace(/^www\./i, '').toLowerCase() || null;
  } catch {
    const m = value.trim().match(/^(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}$/);
    return m ? value.trim().replace(/^www\./i, '').toLowerCase() : null;
  }
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const dryRun = process.argv.includes('--dry-run');

  const client = neon(url);
  const db = drizzle(client);

  // Pull every row missing primary_domain that has a candidate URL
  // somewhere in metadata. Two common keys: website_url (chat-curated)
  // and source_url (some scraped seeds).
  const result = await db.execute(sql`
    SELECT slug, metadata
      FROM known_entities
     WHERE primary_domain IS NULL
       AND (metadata->>'website_url' IS NOT NULL
            OR metadata->>'source_url' IS NOT NULL)
  `);
  const rows = result.rows as unknown as Array<{
    slug: string;
    metadata: Record<string, unknown> | null;
  }>;

  console.log(
    `backfill-known-entity-primary-domain — ${rows.length} candidate rows, dryRun=${dryRun}`,
  );

  let updated = 0;
  let skipped = 0;
  for (const r of rows) {
    const candidate =
      (r.metadata?.['website_url'] as string | undefined) ??
      (r.metadata?.['source_url'] as string | undefined) ??
      null;
    const domain = deriveDomainFromUrl(candidate);
    if (!domain) {
      skipped += 1;
      continue;
    }
    if (dryRun) {
      console.log(`  ${r.slug}\t<- ${domain}`);
      updated += 1;
      continue;
    }
    await db.execute(sql`
      UPDATE known_entities
         SET primary_domain = ${domain}
       WHERE slug = ${r.slug}
         AND primary_domain IS NULL
    `);
    updated += 1;
  }

  console.log(
    `done — updated=${updated}, skipped=${skipped}${dryRun ? ' (dry run)' : ''}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
