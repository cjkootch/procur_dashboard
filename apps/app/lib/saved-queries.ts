import 'server-only';
import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  agencies,
  db,
  jurisdictions,
  opportunities,
  pursuits,
  savedOpportunities,
} from '@procur/db';

export type SavedOpportunityRow = {
  savedId: string;
  opportunityId: string;
  slug: string | null;
  title: string;
  referenceNumber: string | null;
  category: string | null;
  jurisdictionName: string;
  jurisdictionCountry: string;
  agencyName: string | null;
  valueEstimate: string | null;
  currency: string | null;
  valueEstimateUsd: string | null;
  deadlineAt: Date | null;
  status: string;
  notes: string | null;
  savedAt: Date;
  hasActivePursuit: boolean;
  pursuitId: string | null;
};

export async function listSavedOpportunities(
  userId: string,
  companyId: string,
): Promise<SavedOpportunityRow[]> {
  const rows = await db
    .select({
      savedId: savedOpportunities.id,
      opportunityId: opportunities.id,
      slug: opportunities.slug,
      title: opportunities.title,
      referenceNumber: opportunities.referenceNumber,
      category: opportunities.category,
      jurisdictionName: jurisdictions.name,
      jurisdictionCountry: jurisdictions.countryCode,
      agencyName: agencies.name,
      valueEstimate: opportunities.valueEstimate,
      currency: opportunities.currency,
      valueEstimateUsd: opportunities.valueEstimateUsd,
      deadlineAt: opportunities.deadlineAt,
      status: opportunities.status,
      notes: savedOpportunities.notes,
      savedAt: savedOpportunities.createdAt,
    })
    .from(savedOpportunities)
    .innerJoin(opportunities, eq(opportunities.id, savedOpportunities.opportunityId))
    .innerJoin(jurisdictions, eq(jurisdictions.id, opportunities.jurisdictionId))
    .leftJoin(agencies, eq(agencies.id, opportunities.agencyId))
    .where(eq(savedOpportunities.userId, userId))
    .orderBy(desc(savedOpportunities.createdAt));

  if (rows.length === 0) return [];

  // Match each saved opp against existing pursuits for the company so we can
  // surface "already pursuing" vs "convert" CTAs correctly.
  const pursuitRows = await db
    .select({ id: pursuits.id, opportunityId: pursuits.opportunityId })
    .from(pursuits)
    .where(
      and(
        eq(pursuits.companyId, companyId),
        inArray(
          pursuits.opportunityId,
          rows.map((r) => r.opportunityId),
        ),
      ),
    );
  const pursuitByOpp = new Map(pursuitRows.map((p) => [p.opportunityId, p.id]));

  return rows.map((r) => ({
    ...r,
    hasActivePursuit: pursuitByOpp.has(r.opportunityId),
    pursuitId: pursuitByOpp.get(r.opportunityId) ?? null,
  }));
}

export async function countSavedOpportunities(userId: string): Promise<number> {
  const rows = await db
    .select({ id: savedOpportunities.id })
    .from(savedOpportunities)
    .where(eq(savedOpportunities.userId, userId));
  return rows.length;
}
