/**
 * Scraper CLI.
 *
 * Usage:
 *   pnpm --filter @procur/scrapers scrape jamaica
 *   pnpm --filter @procur/scrapers scrape guyana
 *   pnpm --filter @procur/scrapers scrape trinidad-and-tobago
 *   pnpm --filter @procur/scrapers scrape jamaica-suppliers
 *
 * Loads .env.local from repo root, runs the requested scraper against
 * the live portal, upserts into Neon, and prints the run summary.
 */
import 'dotenv/config';
import { config } from 'dotenv';
import { getScraper, scrapers } from './registry';
import { JamaicaGojepSuppliersScraper } from './jurisdictions/jamaica-gojep-suppliers/scraper';
import { upsertSuppliers } from './jurisdictions/jamaica-gojep-suppliers/upsert';

config({ path: '../../.env.local' });
config({ path: '../../.env' });

async function runJamaicaSuppliers() {
  const scraper = new JamaicaGojepSuppliersScraper();
  console.log(`running ${scraper.sourceName} against ${scraper.portalUrl}`);
  const rows = await scraper.fetch();
  console.log(`scraped ${rows.length} supplier rows`);
  const result = await upsertSuppliers(scraper.jurisdictionSlug, scraper.sourceName, rows);
  console.log(JSON.stringify({ ...result, total: rows.length }, null, 2));
}

async function main() {
  const slug = process.argv[2];
  if (!slug) {
    console.error('usage: scrape <jurisdiction-slug | jamaica-suppliers>');
    console.error(`available tender scrapers: ${Object.keys(scrapers).join(', ')}`);
    console.error('supplier scrapers: jamaica-suppliers');
    process.exit(1);
  }

  if (slug === 'jamaica-suppliers') {
    await runJamaicaSuppliers();
    return;
  }

  const scraper = getScraper(slug);
  console.log(`running ${scraper.sourceName} against ${scraper.portalUrl}`);

  const result = await scraper.run();
  console.log(JSON.stringify(result, null, 2));

  process.exit(result.status === 'failed' ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
