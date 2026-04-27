import { schedules } from '@trigger.dev/sdk';
import { JamaicaGojepSuppliersScraper } from '../../jurisdictions/jamaica-gojep-suppliers/scraper';
import { upsertSuppliers } from '../../jurisdictions/jamaica-gojep-suppliers/upsert';

/**
 * Daily scrape of GOJEP's PPC-approved supplier registry. Suppliers
 * don't churn fast — registrations roll in slowly and addresses
 * occasionally update — so once a day at 02:00 UTC (21:00 Jamaica
 * the prior evening) is plenty.
 *
 * Output: rows in `external_suppliers`. Distinct from the tender
 * `opportunity.enrich` chain — supplier rows don't trigger AI
 * enrichment (no document text to extract).
 */
export const scrapeJamaicaSuppliers = schedules.task({
  id: 'scrape-jamaica-suppliers',
  cron: '0 2 * * *',
  maxDuration: 1800,
  run: async (_payload, { ctx }) => {
    const scraper = new JamaicaGojepSuppliersScraper();
    const rows = await scraper.fetch();
    const result = await upsertSuppliers(
      scraper.jurisdictionSlug,
      scraper.sourceName,
      rows,
    );
    return {
      runId: ctx.run.id,
      total: rows.length,
      ...result,
    };
  },
});
