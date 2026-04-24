import { and, eq, gte, ilike, inArray, isNotNull, or, sql, type SQL } from 'drizzle-orm';
import {
  agencies,
  alertProfiles,
  db,
  jurisdictions,
  opportunities,
  type AlertProfile,
} from '@procur/db';

export type MatchedOpportunity = {
  id: string;
  slug: string;
  title: string;
  agency: string | null;
  jurisdictionName: string;
  valueEstimate: string | null;
  currency: string | null;
  valueEstimateUsd: string | null;
  deadlineAt: Date | null;
};

/**
 * Find opportunities matching an alert profile's criteria, created or updated
 * since `since`. Active tenders only.
 */
export async function findMatchingOpportunities(
  profile: AlertProfile,
  since: Date,
): Promise<MatchedOpportunity[]> {
  const conds: SQL[] = [
    eq(opportunities.status, 'active'),
    gte(opportunities.firstSeenAt, since),
    isNotNull(opportunities.slug),
  ];

  if (profile.jurisdictions && profile.jurisdictions.length > 0) {
    conds.push(inArray(jurisdictions.slug, profile.jurisdictions));
  }
  if (profile.categories && profile.categories.length > 0) {
    conds.push(inArray(opportunities.category, profile.categories));
  }
  if (profile.minValue != null) {
    conds.push(gte(opportunities.valueEstimateUsd, String(profile.minValue)));
  }
  if (profile.maxValue != null) {
    conds.push(sql`${opportunities.valueEstimateUsd} <= ${String(profile.maxValue)}`);
  }
  if (profile.keywords && profile.keywords.length > 0) {
    const keywordMatches = profile.keywords.map((k) => {
      const like = `%${k}%`;
      const clause = or(
        ilike(opportunities.title, like),
        ilike(opportunities.description, like),
        ilike(opportunities.aiSummary, like),
      );
      return clause;
    });
    const joined = or(...(keywordMatches.filter(Boolean) as SQL[]));
    if (joined) conds.push(joined);
  }
  if (profile.excludeKeywords && profile.excludeKeywords.length > 0) {
    for (const k of profile.excludeKeywords) {
      const like = `%${k}%`;
      conds.push(
        sql`(${opportunities.title} NOT ILIKE ${like} AND COALESCE(${opportunities.description}, '') NOT ILIKE ${like})`,
      );
    }
  }

  const rows = await db
    .select({
      id: opportunities.id,
      slug: opportunities.slug,
      title: opportunities.title,
      agency: agencies.name,
      jurisdictionName: jurisdictions.name,
      valueEstimate: opportunities.valueEstimate,
      currency: opportunities.currency,
      valueEstimateUsd: opportunities.valueEstimateUsd,
      deadlineAt: opportunities.deadlineAt,
    })
    .from(opportunities)
    .innerJoin(jurisdictions, eq(jurisdictions.id, opportunities.jurisdictionId))
    .leftJoin(agencies, eq(agencies.id, opportunities.agencyId))
    .where(and(...conds))
    .limit(50);

  return rows.map((r) => ({ ...r, slug: r.slug ?? '' }));
}

export async function markAlertSent(profileId: string, at: Date = new Date()) {
  await db
    .update(alertProfiles)
    .set({ lastSentAt: at, updatedAt: at })
    .where(eq(alertProfiles.id, profileId));
}
