import { schedules } from '@trigger.dev/sdk';
import { DrDgcpAwardsExtractor } from '../../awards-extractors/dr-dgcp/extractor';

/**
 * DGCP awards extraction — fetches OCDS bulk .jsonl.gz files from the
 * Open Contracting Data Registry and upserts into the supplier-graph
 * tables.
 *
 * STILL NOT IN THE DEPLOY GLOB. This file lives outside
 * `./src/trigger/scheduled/` (the trigger.config.ts auto-deploy path)
 * intentionally. To enable scheduled runs:
 *   1. Add `'./src/trigger/awards'` to trigger.config.ts `dirs`.
 *   2. Set DR_AWARDS_EXTRACTOR_ENABLED=1 in the trigger.dev project env.
 *
 * Defaults to remote streaming from data.open-contracting.org/en/
 * publication/22 for the last 5 years. Override with:
 *   - DR_OCDS_BULK_PATHS=<csv of local paths>  (offline runs)
 *   - DR_OCDS_YEARS_BACK=<N>                   (different lookback)
 *
 * For manual local runs use the CLI:
 *   pnpm --filter @procur/scrapers scrape awards-dr            # remote, last 5y
 *   pnpm --filter @procur/scrapers scrape awards-dr <path...>  # local files
 *
 * Outstanding follow-up:
 *   - FX conversion DOP -> USD for contract_value_usd (currently null).
 *   - supplier_capability_summary REFRESH MATERIALIZED VIEW after run.
 */
export const extractDrAwards = schedules.task({
  id: 'extract-dr-awards',
  // DGCP publishes monthly; run on the 5th to give them buffer to
  // release the prior month's data.
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
    const bulkFilePaths = pathsCsv
      ? pathsCsv.split(',').map((p) => p.trim()).filter(Boolean)
      : undefined;

    const yearsBackEnv = process.env.DR_OCDS_YEARS_BACK;
    const yearsBack = yearsBackEnv ? Number.parseInt(yearsBackEnv, 10) : undefined;

    const extractor = new DrDgcpAwardsExtractor({
      bulkFilePaths,
      yearsBack: yearsBack && Number.isFinite(yearsBack) ? yearsBack : undefined,
    });
    return await extractor.run({ triggerRunId: ctx.run.id });
  },
});
