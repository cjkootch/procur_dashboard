/**
 * Scraper CLI.
 *
 * Usage:
 *   pnpm --filter @procur/scrapers scrape jamaica
 *   pnpm --filter @procur/scrapers scrape guyana
 *   pnpm --filter @procur/scrapers scrape trinidad-and-tobago
 *   pnpm --filter @procur/scrapers scrape jamaica-suppliers
 *   pnpm --filter @procur/scrapers scrape awards-dr <bulk1.jsonl.gz> [bulk2.jsonl.gz ...]
 *   pnpm --filter @procur/scrapers scrape awards-jm
 *
 * Loads .env.local from repo root, runs the requested scraper against
 * the live portal, upserts into Neon, and prints the run summary.
 */
import 'dotenv/config';
import { config } from 'dotenv';
import { getScraper, scrapers } from './registry';
import { JamaicaGojepSuppliersScraper } from './jurisdictions/jamaica-gojep-suppliers/scraper';
import { upsertSuppliers } from './jurisdictions/jamaica-gojep-suppliers/upsert';
import { DrDgcpAwardsExtractor } from './awards-extractors/dr-dgcp/extractor';
import { JamaicaGojepAwardsExtractor } from './awards-extractors/jamaica-gojep/extractor';
import { TedAwardsExtractor } from './awards-extractors/ted/extractor';
import { UngmAwardsExtractor } from './awards-extractors/ungm/extractor';
import { OcdsBulkAwardsExtractor } from './awards-extractors/ocds-bulk/extractor';
import {
  OCDS_PUBLISHERS,
  buildOcdrYearUrls,
  getPublisherPreset,
} from './awards-extractors/ocds-bulk/publishers';
import {
  run as runEnvServicesSource,
  runAll as runEnvServicesAll,
  type EnvServicesSource,
} from './jobs/ingest-environmental-services';
import {
  run as runFuelBuyerSource,
  runAll as runFuelBuyerAll,
  type FuelBuyerSource,
} from './jobs/ingest-fuel-buyers';

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

async function runDrAwardsExtractor(paths: string[]) {
  // No args -> remote mode (last 5 years from OCDR). Args -> local files.
  const extractor =
    paths.length > 0
      ? new DrDgcpAwardsExtractor({ bulkFilePaths: paths })
      : new DrDgcpAwardsExtractor();
  const sources = paths.length > 0 ? `${paths.length} local file(s)` : 'OCDR (last 5 years)';
  console.log(`extracting DR DGCP awards from ${sources}...`);
  const result = await extractor.run();
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.status === 'failed' ? 1 : 0);
}

async function runJamaicaAwardsExtractor() {
  console.log('extracting Jamaica GOJEP awards (HTML pagination + PDF parsing)...');
  const extractor = new JamaicaGojepAwardsExtractor();
  const result = await extractor.run();
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.status === 'failed' ? 1 : 0);
}

async function runTedAwardsExtractor(daysArg: string | undefined) {
  const days = daysArg ? Number.parseInt(daysArg, 10) : undefined;
  console.log(`extracting TED awards (CPV 09 + 15) for last ${days ?? 30} days...`);
  const extractor = new TedAwardsExtractor({ postedWithinDays: days });
  const result = await extractor.run();
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.status === 'failed' ? 1 : 0);
}

async function runUngmAwardsExtractor() {
  console.log('extracting UNGM awards (search + per-notice detail HTML)...');
  const extractor = new UngmAwardsExtractor();
  const result = await extractor.run();
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.status === 'failed' ? 1 : 0);
}

async function runOcdsBulkExtractor(publisherKey: string, yearsArg: string | undefined) {
  const preset = getPublisherPreset(publisherKey);
  if (!preset) {
    console.error(
      `unknown publisher: ${publisherKey}\navailable: ${Object.keys(OCDS_PUBLISHERS).join(', ')}`,
    );
    process.exit(2);
  }
  const yearsBack = yearsArg ? Math.max(1, Number.parseInt(yearsArg, 10)) : 5;
  const currentYear = new Date().getUTCFullYear();
  const years: number[] = [];
  for (let i = 0; i < yearsBack; i += 1) years.push(currentYear - i);
  const urls = buildOcdrYearUrls(preset, years);

  console.log(
    `extracting OCDS awards from ${publisherKey} (publication ${preset.publicationId}, last ${yearsBack}y)...`,
  );
  const extractor = new OcdsBulkAwardsExtractor({
    ...preset,
    bulkFileUrls: urls,
  });
  const result = await extractor.run();
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.status === 'failed' ? 1 : 0);
}

async function main() {
  const slug = process.argv[2];
  if (!slug) {
    console.error('usage: scrape <jurisdiction-slug | jamaica-suppliers | awards-dr [paths...] | awards-jm>');
    console.error(`available tender scrapers: ${Object.keys(scrapers).join(', ')}`);
    console.error('supplier scrapers: jamaica-suppliers');
    console.error('awards extractors: awards-dr, awards-jm, awards-ted [days], awards-un');
    console.error(
      `OCDS bulk: awards-ocds <publisher> [yearsBack=5]; publishers: ${Object.keys(OCDS_PUBLISHERS).join(', ')}`,
    );
    console.error(
      'env-services rolodex: env-services [epa-rcra|anla|curated-seed|...] (no sub = run all)',
    );
    console.error(
      'fuel-buyer rolodex: fuel-buyers [utilities-seed|mining-seed|...] (no sub = run all)',
    );
    process.exit(1);
  }

  if (slug === 'jamaica-suppliers') {
    await runJamaicaSuppliers();
    return;
  }

  if (slug === 'awards-dr') {
    await runDrAwardsExtractor(process.argv.slice(3));
    return;
  }

  if (slug === 'awards-jm') {
    await runJamaicaAwardsExtractor();
    return;
  }

  if (slug === 'awards-ted') {
    await runTedAwardsExtractor(process.argv[3]);
    return;
  }

  if (slug === 'awards-un') {
    await runUngmAwardsExtractor();
    return;
  }

  if (slug === 'awards-ocds') {
    const publisher = process.argv[3];
    if (!publisher) {
      console.error(
        `awards-ocds requires a publisher key.\navailable: ${Object.keys(OCDS_PUBLISHERS).join(', ')}`,
      );
      process.exit(2);
    }
    await runOcdsBulkExtractor(publisher, process.argv[4]);
    return;
  }

  if (slug === 'env-services') {
    // Usage:
    //   pnpm --filter @procur/scrapers scrape env-services            # run all wired workers
    //   pnpm --filter @procur/scrapers scrape env-services curated-seed
    //   pnpm --filter @procur/scrapers scrape env-services epa-rcra
    //   pnpm --filter @procur/scrapers scrape env-services anla
    const sub = process.argv[3] as EnvServicesSource | undefined;
    if (!sub) {
      console.log('running all wired env-services workers in order...');
      const summaries = await runEnvServicesAll();
      console.log(JSON.stringify(summaries, null, 2));
      // Exit non-zero only when at least one worker erred AND no
      // worker succeeded. Stubs and needs-discovery sources don't
      // count toward error tally.
      const anyOk = summaries.some((s) => s.status === 'ok');
      const anyError = summaries.some((s) => s.status === 'error');
      process.exit(!anyOk && anyError ? 1 : 0);
    }
    console.log(`running env-services worker: ${sub}...`);
    const summary = await runEnvServicesSource(sub);
    console.log(JSON.stringify(summary, null, 2));
    process.exit(summary.status === 'error' ? 1 : 0);
  }

  if (slug === 'fuel-buyers') {
    // Usage:
    //   pnpm --filter @procur/scrapers scrape fuel-buyers            # run all wired
    //   pnpm --filter @procur/scrapers scrape fuel-buyers utilities-seed
    const sub = process.argv[3] as FuelBuyerSource | undefined;
    if (!sub) {
      console.log('running all wired fuel-buyer workers in order...');
      const summaries = await runFuelBuyerAll();
      console.log(JSON.stringify(summaries, null, 2));
      const anyOk = summaries.some((s) => s.status === 'ok');
      const anyError = summaries.some((s) => s.status === 'error');
      process.exit(!anyOk && anyError ? 1 : 0);
    }
    console.log(`running fuel-buyer worker: ${sub}...`);
    const summary = await runFuelBuyerSource(sub);
    console.log(JSON.stringify(summary, null, 2));
    process.exit(summary.status === 'error' ? 1 : 0);
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
