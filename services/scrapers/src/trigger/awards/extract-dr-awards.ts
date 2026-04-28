import { schedules } from '@trigger.dev/sdk';
import { DrDgcpAwardsExtractor } from '../../awards-extractors/dr-dgcp/extractor';

/**
 * DGCP awards extraction — runs against pre-downloaded OCDS bulk
 * .jsonl.gz files and upserts into the supplier-graph tables.
 *
 * NOT YET DEPLOYED. This file lives outside `./src/trigger/scheduled/`
 * (the trigger.config.ts auto-deploy glob) intentionally — to enable,
 * add `'./src/trigger/awards'` to trigger.config.ts `dirs`.
 *
 * Deferred work blocking automated runs:
 *   1. OCDS bulk download — discover the latest per-year .jsonl.gz
 *      URLs from data.open-contracting.org/en/publication/22, fetch,
 *      and cache (R2 or worker-local). Currently the extractor reads
 *      from `process.env.DR_OCDS_BULK_PATHS` (comma-separated paths).
 *   2. FX conversion — DR awards are denominated in DOP. Once a daily
 *      FX-rate snapshot lands, populate `contract_value_usd` so the
 *      reverse-search "total $USD" column has values for DR rows.
 *
 * For manual local runs (and PR validation), use the CLI:
 *
 *   pnpm --filter @procur/scrapers extract awards-dr <path1> [path2 ...]
 */
export const extractDrAwards = schedules.task({
  id: 'extract-dr-awards',
  // DGCP publishes OCDS bulk monthly; run on the 5th to give them
  // buffer to release the prior month's data.
  cron: '0 3 5 * *',
  maxDuration: 1800,
  run: async (_payload, { ctx }) => {
    const enabled = process.env.DR_AWARDS_EXTRACTOR_ENABLED === '1';
    if (!enabled) {
      return {
        skipped: true,
        reason: 'DR_AWARDS_EXTRACTOR_ENABLED not set — task is intentionally inert.',
      };
    }

    const pathsCsv = process.env.DR_OCDS_BULK_PATHS;
    if (!pathsCsv) {
      throw new Error(
        'DR_OCDS_BULK_PATHS env var required when DR_AWARDS_EXTRACTOR_ENABLED=1',
      );
    }
    const bulkFilePaths = pathsCsv
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);

    const extractor = new DrDgcpAwardsExtractor({ bulkFilePaths });
    return await extractor.run({ triggerRunId: ctx.run.id });
  },
});
