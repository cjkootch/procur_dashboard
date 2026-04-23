/**
 * Scraper CLI.
 *
 * Usage:
 *   pnpm --filter @procur/scrapers scrape jamaica
 *   pnpm --filter @procur/scrapers scrape guyana
 *   pnpm --filter @procur/scrapers scrape trinidad-and-tobago
 *
 * Loads .env.local from repo root, runs the requested scraper against
 * the live portal, upserts into Neon via @procur/scrapers-core, and
 * prints the run summary.
 */
import 'dotenv/config';
import { config } from 'dotenv';
import { getScraper, scrapers } from './registry';

config({ path: '../../.env.local' });
config({ path: '../../.env' });

async function main() {
  const slug = process.argv[2];
  if (!slug) {
    console.error('usage: scrape <jurisdiction-slug>');
    console.error(`available: ${Object.keys(scrapers).join(', ')}`);
    process.exit(1);
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
