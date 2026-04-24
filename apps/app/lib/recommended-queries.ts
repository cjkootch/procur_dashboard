import 'server-only';
import { and, desc, eq, gt, ilike, inArray, notInArray, or } from 'drizzle-orm';
import {
  agencies,
  db,
  jurisdictions,
  opportunities,
  pursuits,
  savedOpportunities,
  type Company,
} from '@procur/db';

export type RecommendedOpportunity = {
  id: string;
  slug: string | null;
  title: string;
  referenceNumber: string | null;
  category: string | null;
  jurisdictionName: string;
  jurisdictionCountry: string;
  agencyName: string | null;
  valueEstimate: string | null;
  valueEstimateUsd: string | null;
  currency: string | null;
  deadlineAt: Date | null;
  aiSummary: string | null;
  matchReasons: string[];
};

/**
 * Surface active opportunities that match the company's declared capabilities,
 * preferred categories, or preferred jurisdictions. ILIKE-based — a future
 * upgrade will add pgvector embeddings on opportunities for semantic match.
 *
 * Excludes opportunities the user's already in a pursuit for or has saved.
 */
export async function getRecommendedOpportunities(
  company: Company,
  userId: string,
  limit = 6,
): Promise<RecommendedOpportunity[]> {
  const capabilities = (company.capabilities ?? []).filter((c) => c.trim().length > 2);
  const preferredCategories = company.preferredCategories ?? [];
  const preferredJurisdictions = company.preferredJurisdictions ?? [];

  if (
    capabilities.length === 0 &&
    preferredCategories.length === 0 &&
    preferredJurisdictions.length === 0
  ) {
    return [];
  }

  const now = new Date();
  const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

  // Excluded: opportunities already in pursuits for this company, or saved by
  // this user. Fetch the ids up-front so the opportunity query can exclude.
  const [pursuitRows, savedRows] = await Promise.all([
    db
      .select({ opportunityId: pursuits.opportunityId })
      .from(pursuits)
      .where(eq(pursuits.companyId, company.id)),
    db
      .select({ opportunityId: savedOpportunities.opportunityId })
      .from(savedOpportunities)
      .where(eq(savedOpportunities.userId, userId)),
  ]);

  const excludedIds = new Set<string>();
  for (const r of pursuitRows) excludedIds.add(r.opportunityId);
  for (const r of savedRows) excludedIds.add(r.opportunityId);

  // Build OR predicate: any capability keyword matches title or description;
  // or the opportunity's category is in preferredCategories; or its
  // jurisdiction slug is in preferredJurisdictions.
  const clauses = [];
  for (const cap of capabilities) {
    const like = `%${cap}%`;
    clauses.push(ilike(opportunities.title, like));
    clauses.push(ilike(opportunities.description, like));
    clauses.push(ilike(opportunities.aiSummary, like));
  }
  if (preferredCategories.length > 0) {
    clauses.push(inArray(opportunities.category, preferredCategories));
  }
  if (preferredJurisdictions.length > 0) {
    clauses.push(inArray(jurisdictions.slug, preferredJurisdictions));
  }

  const matchClause = clauses.length > 0 ? or(...clauses) : undefined;
  if (!matchClause) return [];

  const conds = [
    eq(opportunities.status, 'active'),
    gt(opportunities.publishedAt, sixtyDaysAgo),
    matchClause,
  ];
  if (excludedIds.size > 0) {
    conds.push(notInArray(opportunities.id, Array.from(excludedIds)));
  }

  // Pull 3x the limit so we can rank in JS and still fill the slots after
  // dedupe / capability-match scoring.
  const rows = await db
    .select({
      id: opportunities.id,
      slug: opportunities.slug,
      title: opportunities.title,
      description: opportunities.description,
      referenceNumber: opportunities.referenceNumber,
      category: opportunities.category,
      jurisdictionName: jurisdictions.name,
      jurisdictionCountry: jurisdictions.countryCode,
      jurisdictionSlug: jurisdictions.slug,
      agencyName: agencies.name,
      valueEstimate: opportunities.valueEstimate,
      valueEstimateUsd: opportunities.valueEstimateUsd,
      currency: opportunities.currency,
      deadlineAt: opportunities.deadlineAt,
      publishedAt: opportunities.publishedAt,
      aiSummary: opportunities.aiSummary,
    })
    .from(opportunities)
    .innerJoin(jurisdictions, eq(jurisdictions.id, opportunities.jurisdictionId))
    .leftJoin(agencies, eq(agencies.id, opportunities.agencyId))
    .where(and(...conds))
    .orderBy(desc(opportunities.publishedAt))
    .limit(limit * 3);

  // Score + rank
  const preferredCats = new Set(preferredCategories);
  const preferredJurs = new Set(preferredJurisdictions);
  const capLower = capabilities.map((c) => c.toLowerCase());

  type Scored = RecommendedOpportunity & { score: number };
  const scored: Scored[] = rows.map((r) => {
    let score = 0;
    const reasons: string[] = [];
    const hay = `${r.title} ${r.description ?? ''} ${r.aiSummary ?? ''}`.toLowerCase();
    const matchedCaps = capLower.filter((c) => hay.includes(c));
    if (matchedCaps.length > 0) {
      score += matchedCaps.length * 5;
      reasons.push(
        `Matches ${matchedCaps.length} capabilit${matchedCaps.length === 1 ? 'y' : 'ies'}`,
      );
    }
    if (r.category && preferredCats.has(r.category)) {
      score += 3;
      reasons.push('Preferred category');
    }
    if (preferredJurs.has(r.jurisdictionSlug)) {
      score += 2;
      reasons.push('Preferred jurisdiction');
    }
    // Recency boost
    const ageDays =
      r.publishedAt != null
        ? (now.getTime() - r.publishedAt.getTime()) / (24 * 60 * 60 * 1000)
        : 30;
    score += Math.max(0, 7 - ageDays / 7);
    return {
      id: r.id,
      slug: r.slug,
      title: r.title,
      referenceNumber: r.referenceNumber,
      category: r.category,
      jurisdictionName: r.jurisdictionName,
      jurisdictionCountry: r.jurisdictionCountry,
      agencyName: r.agencyName,
      valueEstimate: r.valueEstimate,
      valueEstimateUsd: r.valueEstimateUsd,
      currency: r.currency,
      deadlineAt: r.deadlineAt,
      aiSummary: r.aiSummary,
      matchReasons: reasons,
      score,
    };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(({ score: _score, ...rest }) => rest);
}
