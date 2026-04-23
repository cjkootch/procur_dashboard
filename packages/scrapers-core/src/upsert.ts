import { and, eq, sql } from 'drizzle-orm';
import {
  db,
  agencies,
  documents,
  jurisdictions,
  opportunities,
  scraperRuns,
  type NewOpportunity,
} from '@procur/db';
import { parseMoney, toUsd } from './currency';
import { buildOpportunitySlug } from './slug';
import type { NormalizedOpportunity } from './types';

export type UpsertOutcome = 'inserted' | 'updated' | 'skipped';

export type UpsertResult = {
  outcome: UpsertOutcome;
  opportunityId: string | null;
};

async function resolveAgencyId(
  jurisdictionId: string,
  agencyName: string | undefined,
  agencySlug: string | undefined,
): Promise<string | null> {
  if (!agencyName && !agencySlug) return null;

  const existing = await db.query.agencies.findFirst({
    where: agencySlug
      ? and(eq(agencies.jurisdictionId, jurisdictionId), eq(agencies.slug, agencySlug))
      : and(eq(agencies.jurisdictionId, jurisdictionId), eq(agencies.name, agencyName ?? '')),
  });
  if (existing) return existing.id;

  if (!agencyName) return null;
  const slugToUse =
    agencySlug ??
    agencyName
      .toLowerCase()
      .replace(/&/g, 'and')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');

  const [inserted] = await db
    .insert(agencies)
    .values({
      jurisdictionId,
      name: agencyName,
      slug: slugToUse,
    })
    .onConflictDoNothing({ target: [agencies.jurisdictionId, agencies.slug] })
    .returning({ id: agencies.id });

  if (inserted) return inserted.id;

  const refetched = await db.query.agencies.findFirst({
    where: and(eq(agencies.jurisdictionId, jurisdictionId), eq(agencies.slug, slugToUse)),
  });
  return refetched?.id ?? null;
}

export async function upsertOpportunity(
  jurisdictionId: string,
  jurisdictionSlug: string,
  norm: NormalizedOpportunity,
): Promise<UpsertResult> {
  const agencyId = await resolveAgencyId(jurisdictionId, norm.agencyName, norm.agencySlug);
  const valueNumber = norm.valueEstimate ?? null;
  const valueString = valueNumber != null ? String(valueNumber) : null;
  const valueUsd =
    valueNumber != null ? toUsd(valueNumber, norm.currency ?? 'USD') : null;
  const valueUsdString = valueUsd != null ? String(valueUsd) : null;

  const slug = buildOpportunitySlug(jurisdictionSlug, norm.title, norm.sourceReferenceId);

  const existing = await db.query.opportunities.findFirst({
    where: and(
      eq(opportunities.jurisdictionId, jurisdictionId),
      eq(opportunities.sourceReferenceId, norm.sourceReferenceId),
    ),
  });

  const row: NewOpportunity = {
    sourceReferenceId: norm.sourceReferenceId,
    jurisdictionId,
    agencyId,
    sourceUrl: norm.sourceUrl,
    title: norm.title,
    description: norm.description ?? null,
    referenceNumber: norm.referenceNumber ?? null,
    type: norm.type ?? null,
    category: norm.category ?? null,
    valueEstimate: valueString,
    currency: norm.currency ?? 'USD',
    valueEstimateUsd: valueUsdString,
    publishedAt: norm.publishedAt ?? null,
    deadlineAt: norm.deadlineAt ?? null,
    deadlineTimezone: norm.deadlineTimezone ?? null,
    language: norm.language ?? 'en',
    rawContent: norm.rawContent,
    slug,
    lastSeenAt: new Date(),
  };

  if (!existing) {
    const [created] = await db
      .insert(opportunities)
      .values({ ...row, firstSeenAt: new Date() })
      .onConflictDoNothing({
        target: [opportunities.jurisdictionId, opportunities.sourceReferenceId],
      })
      .returning({ id: opportunities.id });

    if (created) {
      await upsertDocuments(created.id, norm);
      return { outcome: 'inserted', opportunityId: created.id };
    }
    return { outcome: 'skipped', opportunityId: null };
  }

  await db
    .update(opportunities)
    .set({ ...row, updatedAt: new Date() })
    .where(eq(opportunities.id, existing.id));
  await upsertDocuments(existing.id, norm);
  return { outcome: 'updated', opportunityId: existing.id };
}

async function upsertDocuments(
  opportunityId: string,
  norm: NormalizedOpportunity,
): Promise<void> {
  if (!norm.documents || norm.documents.length === 0) return;
  for (const doc of norm.documents) {
    const existing = await db.query.documents.findFirst({
      where: and(
        eq(documents.opportunityId, opportunityId),
        eq(documents.originalUrl, doc.originalUrl),
      ),
    });
    if (existing) continue;

    await db.insert(documents).values({
      opportunityId,
      documentType: doc.documentType,
      title: doc.title ?? null,
      originalUrl: doc.originalUrl,
      processingStatus: 'pending',
    });
  }
}

export async function startScraperRun(jurisdictionId: string): Promise<string> {
  const [row] = await db
    .insert(scraperRuns)
    .values({
      jurisdictionId,
      startedAt: new Date(),
      status: 'running',
    })
    .returning({ id: scraperRuns.id });

  if (!row) throw new Error('failed to create scraper_runs row');
  return row.id;
}

export type FinishScraperRunInput = {
  runId: string;
  jurisdictionId: string;
  status: 'success' | 'partial' | 'failed';
  recordsFound: number;
  recordsNew: number;
  recordsUpdated: number;
  recordsSkipped: number;
  errors: Array<{ message: string; context?: Record<string, unknown>; stack?: string }>;
  logOutput?: string;
  triggerRunId?: string;
  durationMs: number;
};

export async function finishScraperRun(input: FinishScraperRunInput): Promise<void> {
  await db
    .update(scraperRuns)
    .set({
      completedAt: new Date(),
      status: input.status,
      recordsFound: input.recordsFound,
      recordsNew: input.recordsNew,
      recordsUpdated: input.recordsUpdated,
      recordsSkipped: input.recordsSkipped,
      errors: input.errors,
      durationMs: input.durationMs,
      logOutput: input.logOutput ?? null,
      triggerRunId: input.triggerRunId ?? null,
    })
    .where(eq(scraperRuns.id, input.runId));

  if (input.status === 'success' || input.status === 'partial') {
    await db
      .update(jurisdictions)
      .set({
        lastSuccessfulScrapeAt: new Date(),
        consecutiveFailures: 0,
        opportunitiesCount: sql`(select count(*)::int from ${opportunities} where ${opportunities.jurisdictionId} = ${input.jurisdictionId} and ${opportunities.status} = 'active')`,
      })
      .where(eq(jurisdictions.id, input.jurisdictionId));
  } else {
    await db
      .update(jurisdictions)
      .set({
        consecutiveFailures: sql`${jurisdictions.consecutiveFailures} + 1`,
      })
      .where(eq(jurisdictions.id, input.jurisdictionId));
  }
}

export async function getJurisdictionBySlug(
  slug: string,
): Promise<{ id: string; slug: string; timezone: string | null } | null> {
  const row = await db.query.jurisdictions.findFirst({
    where: eq(jurisdictions.slug, slug),
    columns: { id: true, slug: true, timezone: true },
  });
  return row ?? null;
}

// Re-export for scraper convenience
export { parseMoney };
