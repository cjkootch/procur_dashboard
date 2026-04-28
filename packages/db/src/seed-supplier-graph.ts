/**
 * Ingest data/seed/caribbean_fuel/awards_sample.json into the
 * supplier-graph tables (external_suppliers, supplier_aliases, awards,
 * award_awardees).
 *
 * Idempotent: re-running is safe. external_suppliers upsert on
 * (jurisdictionId, sourceName, sourceReferenceId); aliases on
 * (supplierId, aliasNormalized); awards on (sourcePortal, sourceAwardId).
 *
 * Run from repo root: pnpm --filter @procur/db db:seed-supplier-graph
 *
 * Requires DATABASE_URL pointing at a database with migrations
 * 0032 + 0033 applied (`pnpm --filter @procur/db db:migrate` first).
 */

import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { eq } from 'drizzle-orm';
import * as schema from './schema';

loadEnv({ path: '../../.env.local' });
loadEnv({ path: '../../.env' });

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(
  __dirname,
  '..',
  '..',
  '..',
  'data',
  'seed',
  'caribbean_fuel',
  'awards_sample.json',
);

type SampleRow = {
  country: string;
  source_portal: string;
  ocid?: string;
  tender_id?: string;
  tender_title?: string;
  buyer: string;
  buyer_country: string;
  supplier_name: string;
  supplier_name_normalized: string;
  supplier_id: string;
  award_id: string;
  award_date: string;
  award_status: string;
  value_native?: number;
  value_currency?: string;
  value_usd?: number | null;
  fuel_categories: string[];
  unspsc_codes: string[];
};

// ISO-3 → ISO-2 (only codes present in the sample).
const ISO3_TO_ISO2: Record<string, string> = {
  DOM: 'DO',
  JAM: 'JM',
};
function iso2(country: string): string {
  return ISO3_TO_ISO2[country.toUpperCase()] ?? country.slice(0, 2).toUpperCase();
}

function dedupe<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

// Mirrors normalizeSupplierName in packages/catalog/src/queries.ts.
function normalize(name: string): string {
  return name
    .toLowerCase()
    .replace(
      /\b(s\.?\s?a\.?(\s?s)?|s\.?\s?r\.?\s?l\.?|llc|l\.?l\.?c\.?|inc|inc\.|incorporated|corp|corp\.|corporation|ltd|ltd\.|limited|gmbh|n\.?v\.?|b\.?v\.?|p\.?l\.?c\.?|plc|s\.?p\.?a\.?)\b/g,
      ' ',
    )
    .replace(/[.,&]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');

  const client = neon(url);
  const db = drizzle(client, { schema, casing: 'snake_case' });

  console.log('Enabling pg_trgm (idempotent)...');
  await client('CREATE EXTENSION IF NOT EXISTS pg_trgm');

  console.log(`Loading fixture: ${FIXTURE}`);
  const rows = JSON.parse(await readFile(FIXTURE, 'utf8')) as SampleRow[];
  console.log(`  ${rows.length} rows`);

  const jurisdictionMap = new Map<string, string>();
  for (const code of ['DO', 'JM']) {
    const j = await db.query.jurisdictions.findFirst({
      where: eq(schema.jurisdictions.countryCode, code),
      columns: { id: true },
    });
    if (!j) {
      throw new Error(
        `Jurisdiction with country_code=${code} not seeded. Run pnpm --filter @procur/db db:seed first.`,
      );
    }
    jurisdictionMap.set(code, j.id);
  }

  // Walk rows once and emit one external_suppliers row per
  // (portal, supplier_id) instead of per award.
  const supplierKey = (r: SampleRow) => `${r.source_portal}::${r.supplier_id}`;
  const uniqueSuppliers = new Map<string, SampleRow>();
  for (const r of rows) uniqueSuppliers.set(supplierKey(r), r);

  console.log(`Upserting ${uniqueSuppliers.size} external_suppliers...`);
  const supplierIdByKey = new Map<string, string>();
  for (const r of uniqueSuppliers.values()) {
    const buyerCountryIso2 = iso2(r.buyer_country);
    const jurisdictionId = jurisdictionMap.get(buyerCountryIso2);
    if (!jurisdictionId) {
      console.warn(`  skip supplier (no jurisdiction for ${buyerCountryIso2}): ${r.supplier_name}`);
      continue;
    }
    const inserted = await db
      .insert(schema.externalSuppliers)
      .values({
        jurisdictionId,
        sourceName: r.source_portal,
        sourceReferenceId: r.supplier_id,
        organisationName: r.supplier_name,
        country: buyerCountryIso2,
      })
      .onConflictDoUpdate({
        target: [
          schema.externalSuppliers.jurisdictionId,
          schema.externalSuppliers.sourceName,
          schema.externalSuppliers.sourceReferenceId,
        ],
        set: {
          organisationName: r.supplier_name,
          lastSeenAt: new Date(),
        },
      })
      .returning({ id: schema.externalSuppliers.id });
    const id = inserted[0]?.id;
    if (id) supplierIdByKey.set(supplierKey(r), id);
  }
  console.log(`  resolved ${supplierIdByKey.size} supplier IDs`);

  console.log('Inserting supplier_aliases...');
  let aliasCount = 0;
  for (const r of uniqueSuppliers.values()) {
    const supplierId = supplierIdByKey.get(supplierKey(r));
    if (!supplierId) continue;
    const aliasNormalized = r.supplier_name_normalized || normalize(r.supplier_name);
    // verified=true: portal's own supplier_id is authoritative.
    await db
      .insert(schema.supplierAliases)
      .values({
        supplierId,
        alias: r.supplier_name,
        aliasNormalized,
        sourcePortal: r.source_portal,
        confidence: '1.00',
        verified: true,
      })
      .onConflictDoNothing({
        target: [schema.supplierAliases.supplierId, schema.supplierAliases.aliasNormalized],
      });
    aliasCount += 1;
  }
  console.log(`  ${aliasCount} alias upserts`);

  console.log(`Upserting ${rows.length} awards + award_awardees...`);
  let awardCount = 0;
  for (const r of rows) {
    const buyerCountryIso2 = iso2(r.buyer_country);
    const jurisdictionId = jurisdictionMap.get(buyerCountryIso2);
    const supplierId = supplierIdByKey.get(supplierKey(r));
    if (!jurisdictionId || !supplierId) continue;

    const inserted = await db
      .insert(schema.awards)
      .values({
        sourcePortal: r.source_portal,
        sourceAwardId: r.award_id,
        rawPayload: r as unknown as Record<string, unknown>,
        jurisdictionId,
        buyerName: r.buyer,
        buyerCountry: buyerCountryIso2,
        title: r.tender_title ?? null,
        commodityDescription: r.tender_title ?? null,
        unspscCodes: dedupe(r.unspsc_codes ?? []),
        categoryTags: dedupe(r.fuel_categories ?? []),
        contractValueNative:
          typeof r.value_native === 'number' ? String(r.value_native) : null,
        contractCurrency: r.value_currency ?? null,
        contractValueUsd:
          typeof r.value_usd === 'number' ? String(r.value_usd) : null,
        awardDate: r.award_date,
        status: r.award_status ?? 'active',
      })
      .onConflictDoUpdate({
        target: [schema.awards.sourcePortal, schema.awards.sourceAwardId],
        set: {
          rawPayload: r as unknown as Record<string, unknown>,
          updatedAt: new Date(),
        },
      })
      .returning({ id: schema.awards.id });

    const awardId = inserted[0]?.id;
    if (!awardId) continue;

    await db
      .insert(schema.awardAwardees)
      .values({
        awardId,
        supplierId,
        role: 'prime',
      })
      .onConflictDoNothing();

    awardCount += 1;
  }
  console.log(`  ${awardCount} award upserts`);

  console.log('Refreshing supplier_capability_summary materialized view...');
  try {
    await client('REFRESH MATERIALIZED VIEW CONCURRENTLY supplier_capability_summary');
  } catch (err) {
    // First refresh requires non-CONCURRENTLY since the view is empty.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  CONCURRENTLY refresh failed (${msg}), retrying without...`);
    await client('REFRESH MATERIALIZED VIEW supplier_capability_summary');
  }

  const buyerCount = (await client(
    `SELECT COUNT(DISTINCT buyer_name)::int AS n FROM awards`,
  )) as Array<{ n: number }>;
  const supplierCount = (await client(
    `SELECT COUNT(*)::int AS n FROM external_suppliers`,
  )) as Array<{ n: number }>;
  console.log(
    `Done. ${buyerCount[0]?.n ?? 0} distinct buyers, ${supplierCount[0]?.n ?? 0} external_suppliers.`,
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
