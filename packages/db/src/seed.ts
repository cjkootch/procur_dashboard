import 'dotenv/config';
import { config } from 'dotenv';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { sql } from 'drizzle-orm';
import * as schema from './schema';
import { seedJurisdictions, seedTaxonomyCategories } from './seed-data';

config({ path: '../../.env.local' });
config({ path: '../../.env' });

async function withRetry<T>(op: () => Promise<T>, label: string): Promise<T> {
  const delays = [0, 500, 1500, 4000, 10000];
  let lastErr: unknown;
  for (const delay of delays) {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    try {
      return await op();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  retry [${label}] after ${delay}ms: ${msg}`);
    }
  }
  throw lastErr;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');

  const client = neon(url);
  const db = drizzle(client, { schema, casing: 'snake_case' });

  const slugify = (input: string) =>
    input
      .toLowerCase()
      .replace(/&/g, 'and')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');

  console.log('Seeding taxonomy categories…');
  for (const cat of seedTaxonomyCategories) {
    await withRetry(
      () =>
        db
          .insert(schema.taxonomyCategories)
          .values(cat)
          .onConflictDoUpdate({
            target: schema.taxonomyCategories.slug,
            set: {
              name: cat.name,
              parentSlug: cat.parentSlug ?? null,
              sortOrder: cat.sortOrder ?? 0,
              active: cat.active ?? true,
            },
          }),
      `taxonomy ${cat.slug}`,
    );
  }

  console.log('Seeding jurisdictions and agencies…');
  for (const { agencies: agencyRows, ...j } of seedJurisdictions) {
    const inserted = await withRetry(
      () =>
        db
          .insert(schema.jurisdictions)
          .values(j)
          .onConflictDoUpdate({
            target: schema.jurisdictions.slug,
            set: {
              name: j.name,
              countryCode: j.countryCode,
              region: j.region,
              portalName: j.portalName,
              portalUrl: j.portalUrl,
              scraperModule: j.scraperModule,
              currency: j.currency,
              language: j.language,
              timezone: j.timezone,
              active: j.active ?? false,
              updatedAt: new Date(),
            },
          })
          .returning({ id: schema.jurisdictions.id }),
      `jurisdiction ${j.slug}`,
    );

    const jurisdictionId = inserted[0]?.id;
    if (!jurisdictionId) continue;

    for (const [name, shortName, type] of agencyRows) {
      if (!name) continue;
      const agencySlug = slugify(name);
      await withRetry(
        () =>
          db
            .insert(schema.agencies)
            .values({
              jurisdictionId,
              name,
              slug: agencySlug,
              shortName,
              type,
            })
            .onConflictDoNothing({
              target: [schema.agencies.jurisdictionId, schema.agencies.slug],
            }),
        `agency ${j.slug}/${agencySlug}`,
      );
    }
  }

  const counts = await withRetry(
    () =>
      Promise.all([
        db.select({ c: sql<number>`count(*)::int` }).from(schema.jurisdictions),
        db.select({ c: sql<number>`count(*)::int` }).from(schema.agencies),
        db.select({ c: sql<number>`count(*)::int` }).from(schema.taxonomyCategories),
      ]),
    'counts',
  );

  const [[juris], [ag], [tax]] = counts;
  console.log(
    `Seed complete — jurisdictions: ${juris?.c ?? 0}, agencies: ${ag?.c ?? 0}, taxonomy: ${tax?.c ?? 0}`,
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
