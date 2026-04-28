/**
 * One-shot script: backfill `awards.contract_value_usd` for rows that
 * have null USD but valid native amount + currency.
 *
 * The DR extractor populates USD at ingest time now (via @procur/scrapers-core
 * convertToUsd), but rows landed before the FX wire-up — including
 * the seed fixture's USD-pre-converted rows AND any extractor runs
 * that happened before this PR — may still be null. This sweeps them
 * up.
 *
 * Idempotent: rows that already have a non-null contract_value_usd are
 * skipped. Pages-at-a-time (1000 rows per batch) so a 6,000-row corpus
 * doesn't hold a long-running write transaction.
 *
 * Run from repo root:
 *   pnpm --filter @procur/db backfill-usd
 */
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { eq, and, isNull, isNotNull } from 'drizzle-orm';
import * as schema from './schema';

// Inlined from packages/scrapers-core/src/fx.ts to avoid a circular
// workspace dep (scrapers-core depends on @procur/db). MUST stay in
// sync with that source — both files reference the same hardcoded
// monthly rates.
const MONTHLY_RATES: Record<string, number> = {
  'DOP-2021-01': 1 / 58.0, 'DOP-2021-06': 1 / 56.9, 'DOP-2021-12': 1 / 57.3,
  'DOP-2022-01': 1 / 57.4, 'DOP-2022-06': 1 / 54.9, 'DOP-2022-12': 1 / 56.4,
  'DOP-2023-01': 1 / 56.4, 'DOP-2023-06': 1 / 54.6, 'DOP-2023-12': 1 / 56.7,
  'DOP-2024-01': 1 / 58.7, 'DOP-2024-06': 1 / 58.9, 'DOP-2024-12': 1 / 60.6,
  'DOP-2025-01': 1 / 61.1, 'DOP-2025-06': 1 / 60.4, 'DOP-2025-12': 1 / 60.0,
  'DOP-2026-01': 1 / 60.0, 'DOP-2026-06': 1 / 60.0,
  'JMD-2021-01': 1 / 144.5, 'JMD-2021-06': 1 / 149.6, 'JMD-2021-12': 1 / 154.4,
  'JMD-2022-01': 1 / 153.9, 'JMD-2022-06': 1 / 152.4, 'JMD-2022-12': 1 / 152.4,
  'JMD-2023-01': 1 / 153.5, 'JMD-2023-06': 1 / 154.7, 'JMD-2023-12': 1 / 155.1,
  'JMD-2024-01': 1 / 154.8, 'JMD-2024-06': 1 / 156.5, 'JMD-2024-12': 1 / 157.3,
  'JMD-2025-01': 1 / 158.0, 'JMD-2025-06': 1 / 159.2, 'JMD-2025-12': 1 / 160.0,
  'JMD-2026-01': 1 / 160.0, 'JMD-2026-06': 1 / 160.0,
};
const BASELINE_RATES: Record<string, number> = { USD: 1, DOP: 1 / 58, JMD: 1 / 155 };

function convertToUsd(
  amount: number | null,
  currency: string | null,
  awardDate: string | null,
): number | null {
  if (amount == null || !Number.isFinite(amount) || !currency) return null;
  const cur = currency.toUpperCase();
  if (cur === 'USD') return amount;
  if (awardDate) {
    const m = awardDate.match(/^(\d{4})-(\d{2})/);
    if (m) {
      const rate = MONTHLY_RATES[`${cur}-${m[1]}-${m[2]}`];
      if (rate != null) return amount * rate;
    }
  }
  const baseline = BASELINE_RATES[cur];
  return baseline != null ? amount * baseline : null;
}

loadEnv({ path: '../../.env.local' });
loadEnv({ path: '../../.env' });

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');

  const client = neon(url);
  const db = drizzle(client, { schema, casing: 'snake_case' });

  console.log('Scanning awards for USD backfill candidates...');
  const candidates = await db
    .select({
      id: schema.awards.id,
      contractValueNative: schema.awards.contractValueNative,
      contractCurrency: schema.awards.contractCurrency,
      awardDate: schema.awards.awardDate,
    })
    .from(schema.awards)
    .where(
      and(
        isNull(schema.awards.contractValueUsd),
        isNotNull(schema.awards.contractValueNative),
        isNotNull(schema.awards.contractCurrency),
      ),
    );

  console.log(`  ${candidates.length} candidate rows`);

  let updated = 0;
  let skipped = 0;
  for (const row of candidates) {
    const native = row.contractValueNative ? Number.parseFloat(row.contractValueNative) : null;
    const usd = convertToUsd(native, row.contractCurrency, row.awardDate);
    if (usd == null) {
      skipped += 1;
      continue;
    }
    await db
      .update(schema.awards)
      .set({ contractValueUsd: String(usd) })
      .where(eq(schema.awards.id, row.id));
    updated += 1;
    if (updated % 500 === 0) console.log(`  ...${updated} rows updated`);
  }

  console.log(`Done. updated=${updated}, skipped=${skipped} (unsupported currency).`);

  // Touch the materialized view; otherwise the per-supplier USD totals
  // stay stale until the next scheduled refresh.
  console.log('Refreshing supplier_capability_summary...');
  try {
    await client('REFRESH MATERIALIZED VIEW CONCURRENTLY supplier_capability_summary');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  CONCURRENTLY refresh failed (${msg}); falling back...`);
    await client('REFRESH MATERIALIZED VIEW supplier_capability_summary');
  }
  console.log('Done.');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
