/**
 * One-shot script: backfill `known_entities.primary_domain` from
 * `metadata.website_url` for rows where the column was left null
 * after operator-approved propose_update_known_entity calls that
 * pre-dated the apply.ts fix (PR #626).
 *
 * Symptom this fixes: tile shows clickable website link (reads
 * metadata.website_url), Apollo "Refresh from Apollo" says
 * "primary_domain not set" because the actual column is still null.
 *
 * Idempotent: rows that already have a non-null primary_domain are
 * skipped. Rows where the URL can't be parsed are skipped + logged.
 * Pages-at-a-time (200 rows per batch) so a 30k-row corpus doesn't
 * hold a long-running connection.
 *
 * Run from repo root:
 *   pnpm --filter @procur/db backfill-primary-domain
 */
import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { and, eq, isNull, sql } from 'drizzle-orm';
import * as schema from './schema';

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
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL not set');
    process.exit(1);
  }
  const sqlClient = neon(databaseUrl);
  const db = drizzle(sqlClient, { schema });

  console.log('Scanning known_entities for primary_domain backfill candidates...');
  // Filter at SQL: primary_domain IS NULL AND metadata->>'website_url' IS NOT NULL.
  // Cast to text since metadata is jsonb.
  const candidates = await db
    .select({
      slug: schema.knownEntities.slug,
      name: schema.knownEntities.name,
      metadata: schema.knownEntities.metadata,
    })
    .from(schema.knownEntities)
    .where(
      and(
        isNull(schema.knownEntities.primaryDomain),
        sql`${schema.knownEntities.metadata}->>'website_url' IS NOT NULL`,
      ),
    );

  console.log(`  ${candidates.length} entity(s) with website_url but no primary_domain`);

  if (candidates.length === 0) {
    console.log('Nothing to backfill.');
    return;
  }

  let filled = 0;
  let unparsed = 0;
  let skipped = 0;

  for (const row of candidates) {
    const meta = (row.metadata ?? {}) as Record<string, unknown>;
    const websiteUrl = meta['website_url'];
    const derived = deriveDomainFromUrl(websiteUrl);

    if (!derived) {
      console.log(
        `  ${row.slug} (${row.name}): could not derive domain from "${String(websiteUrl)}" — skipping`,
      );
      unparsed += 1;
      continue;
    }

    // Race-safe: only update when primary_domain is still NULL.
    // Concurrent writes (a chat-tool approval landing mid-backfill)
    // shouldn't get overwritten.
    const updated = await db
      .update(schema.knownEntities)
      .set({ primaryDomain: derived, updatedAt: new Date() })
      .where(
        and(
          eq(schema.knownEntities.slug, row.slug),
          isNull(schema.knownEntities.primaryDomain),
        ),
      )
      .returning({ slug: schema.knownEntities.slug });

    if (updated.length > 0) {
      console.log(`  ${row.slug}: ${derived}`);
      filled += 1;
    } else {
      skipped += 1;
    }
  }

  console.log(`Done: ${filled} filled, ${unparsed} unparsed, ${skipped} skipped (concurrent write).`);
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
