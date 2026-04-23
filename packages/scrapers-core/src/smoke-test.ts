/**
 * End-to-end smoke test for the scraper framework.
 *
 * Uses a fixture scraper (no network) that emits two synthetic raw
 * opportunities, runs them through the real pipeline against Neon, and
 * verifies they land in opportunities + scraper_runs.
 *
 * Run with: pnpm --filter @procur/scrapers-core exec tsx src/smoke-test.ts
 */

import 'dotenv/config';
import { config } from 'dotenv';
import { and, eq, desc, sql } from 'drizzle-orm';
import { db, jurisdictions, opportunities, scraperRuns } from '@procur/db';
import { TenderScraper } from './base';
import { parseTenderDate } from './dates';
import type { NormalizedOpportunity, RawOpportunity } from './types';

config({ path: '../../.env.local' });
config({ path: '../../.env' });

class FixtureJamaicaScraper extends TenderScraper {
  readonly jurisdictionSlug = 'jamaica';
  readonly sourceName = 'fixture-jamaica';
  readonly portalUrl = 'https://example.test/fixtures/jamaica';

  async fetch(): Promise<RawOpportunity[]> {
    return [
      {
        sourceReferenceId: 'FIXTURE-JM-001',
        sourceUrl: 'https://example.test/fixtures/jamaica/001',
        rawData: {
          title: 'Supply of medical equipment to Kingston Public Hospital',
          procuringEntity: 'Ministry of Health and Wellness',
          closingDate: '15-Jun-2026',
          publishedDate: '10-Apr-2026',
          estimatedValue: 'JMD 125,000,000',
          type: 'ITB',
        },
      },
      {
        sourceReferenceId: 'FIXTURE-JM-002',
        sourceUrl: 'https://example.test/fixtures/jamaica/002',
        rawData: {
          title: 'Road rehabilitation — Kingston to Spanish Town corridor',
          procuringEntity: 'National Works Agency',
          closingDate: '01/07/2026',
          publishedDate: '20/04/2026',
          estimatedValue: 'JMD 2,500,000,000',
          type: 'RFP',
        },
      },
    ];
  }

  async parse(raw: RawOpportunity): Promise<NormalizedOpportunity | null> {
    const d = raw.rawData as Record<string, string>;
    return {
      sourceReferenceId: raw.sourceReferenceId,
      sourceUrl: raw.sourceUrl,
      title: d.title ?? 'Untitled',
      description: d.title,
      type: d.type ?? undefined,
      agencyName: d.procuringEntity,
      category: 'construction',
      currency: 'JMD',
      valueEstimate: Number.parseFloat((d.estimatedValue ?? '').replace(/[^0-9.]/g, '')) || undefined,
      publishedAt: parseTenderDate(d.publishedDate, 'America/Jamaica') ?? undefined,
      deadlineAt: parseTenderDate(d.closingDate, 'America/Jamaica') ?? undefined,
      deadlineTimezone: 'America/Jamaica',
      language: 'en',
      rawContent: d,
      documents: [
        {
          documentType: 'tender_notice',
          originalUrl: `${raw.sourceUrl}/notice.pdf`,
          title: `${d.title} — tender notice`,
        },
      ],
    };
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL not set');
  }

  const scraper = new FixtureJamaicaScraper();
  console.log('running fixture scraper…');
  const result = await scraper.run();
  console.log('result:', result);

  const jam = await db.query.jurisdictions.findFirst({
    where: eq(jurisdictions.slug, 'jamaica'),
  });
  if (!jam) throw new Error('jamaica jurisdiction missing');

  const inserted = await db
    .select({
      id: opportunities.id,
      title: opportunities.title,
      reference: opportunities.sourceReferenceId,
      currency: opportunities.currency,
      valueEstimate: opportunities.valueEstimate,
      valueEstimateUsd: opportunities.valueEstimateUsd,
      deadline: opportunities.deadlineAt,
      agencyId: opportunities.agencyId,
    })
    .from(opportunities)
    .where(
      and(
        eq(opportunities.jurisdictionId, jam.id),
        sql`${opportunities.sourceReferenceId} LIKE 'FIXTURE-JM-%'`,
      ),
    );

  console.log(`inserted rows for fixture: ${inserted.length}`);
  for (const row of inserted) {
    console.log(' ', row.reference, '·', row.title);
    console.log('     value:', row.valueEstimate, row.currency, '→ USD', row.valueEstimateUsd);
    console.log('     deadline:', row.deadline?.toISOString());
  }

  const [latestRun] = await db
    .select()
    .from(scraperRuns)
    .where(eq(scraperRuns.jurisdictionId, jam.id))
    .orderBy(desc(scraperRuns.startedAt))
    .limit(1);
  console.log('latest scraper run:', {
    status: latestRun?.status,
    found: latestRun?.recordsFound,
    new: latestRun?.recordsNew,
    updated: latestRun?.recordsUpdated,
    skipped: latestRun?.recordsSkipped,
    duration: latestRun?.durationMs,
  });

  if (result.status !== 'success' || result.recordsFound !== 2) {
    console.error('smoke test FAILED');
    process.exit(1);
  }
  if (inserted.length !== 2) {
    console.error('smoke test FAILED — expected 2 rows');
    process.exit(1);
  }
  console.log('smoke test OK');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
