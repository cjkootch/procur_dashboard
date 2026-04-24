import 'server-only';
import { and, desc, eq, gte, ilike, inArray, lte, not, or, sql } from 'drizzle-orm';
import {
  agencies,
  alertProfiles,
  db,
  jurisdictions,
  opportunities,
  type AlertProfile,
} from '@procur/db';

export type AlertMatch = {
  id: string;
  title: string;
  slug: string | null;
  referenceNumber: string | null;
  category: string | null;
  jurisdictionName: string;
  jurisdictionCountry: string;
  agencyName: string | null;
  valueEstimate: string | null;
  valueEstimateUsd: string | null;
  currency: string | null;
  deadlineAt: Date | null;
  publishedAt: Date | null;
};

export type AlertWithCount = AlertProfile & {
  matchCount: number;
};

export async function listAlertProfiles(userId: string): Promise<AlertWithCount[]> {
  const rows = await db
    .select()
    .from(alertProfiles)
    .where(eq(alertProfiles.userId, userId))
    .orderBy(desc(alertProfiles.updatedAt));

  const withCounts = await Promise.all(
    rows.map(async (r) => ({ ...r, matchCount: await countMatches(r) })),
  );
  return withCounts;
}

export async function getAlertProfile(
  userId: string,
  id: string,
): Promise<AlertProfile | null> {
  const row = await db.query.alertProfiles.findFirst({
    where: and(eq(alertProfiles.id, id), eq(alertProfiles.userId, userId)),
  });
  return row ?? null;
}

/**
 * Compose the where clause for an alert profile. Opportunities must be `open`.
 * - jurisdictions: match any of the listed jurisdiction slugs (empty = no filter)
 * - categories: match any of the listed categories (empty = no filter)
 * - keywords: title/description ILIKE any keyword (empty = no filter)
 * - excludeKeywords: title/description must NOT ILIKE any (empty = no filter)
 * - minValue/maxValue: gate on valueEstimateUsd (null-tolerant: only filters rows with a value)
 */
function buildWhere(profile: AlertProfile) {
  const conds = [eq(opportunities.status, 'active')];

  if (profile.jurisdictions && profile.jurisdictions.length > 0) {
    conds.push(inArray(jurisdictions.slug, profile.jurisdictions));
  }
  if (profile.categories && profile.categories.length > 0) {
    conds.push(inArray(opportunities.category, profile.categories));
  }
  if (profile.keywords && profile.keywords.length > 0) {
    const clauses = profile.keywords.flatMap((k) => {
      const term = `%${k}%`;
      return [ilike(opportunities.title, term), ilike(opportunities.description, term)];
    });
    const compound = or(...clauses);
    if (compound) conds.push(compound);
  }
  if (profile.excludeKeywords && profile.excludeKeywords.length > 0) {
    for (const k of profile.excludeKeywords) {
      const term = `%${k}%`;
      const negated = not(or(ilike(opportunities.title, term), ilike(opportunities.description, term))!);
      conds.push(negated);
    }
  }
  if (profile.minValue) {
    conds.push(gte(opportunities.valueEstimateUsd, profile.minValue));
  }
  if (profile.maxValue) {
    conds.push(lte(opportunities.valueEstimateUsd, profile.maxValue));
  }
  return and(...conds);
}

export async function countMatches(profile: AlertProfile): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(opportunities)
    .innerJoin(jurisdictions, eq(jurisdictions.id, opportunities.jurisdictionId))
    .where(buildWhere(profile));
  return rows[0]?.n ?? 0;
}

export async function matchOpportunities(
  profile: AlertProfile,
  limit = 25,
): Promise<AlertMatch[]> {
  const rows = await db
    .select({
      id: opportunities.id,
      title: opportunities.title,
      slug: opportunities.slug,
      referenceNumber: opportunities.referenceNumber,
      category: opportunities.category,
      jurisdictionName: jurisdictions.name,
      jurisdictionCountry: jurisdictions.countryCode,
      agencyName: agencies.name,
      valueEstimate: opportunities.valueEstimate,
      valueEstimateUsd: opportunities.valueEstimateUsd,
      currency: opportunities.currency,
      deadlineAt: opportunities.deadlineAt,
      publishedAt: opportunities.publishedAt,
    })
    .from(opportunities)
    .innerJoin(jurisdictions, eq(jurisdictions.id, opportunities.jurisdictionId))
    .leftJoin(agencies, eq(agencies.id, opportunities.agencyId))
    .where(buildWhere(profile))
    .orderBy(desc(opportunities.publishedAt))
    .limit(limit);
  return rows;
}

export async function listJurisdictionOptions(): Promise<Array<{ slug: string; name: string }>> {
  return db
    .select({ slug: jurisdictions.slug, name: jurisdictions.name })
    .from(jurisdictions)
    .orderBy(jurisdictions.name);
}

export async function listCategoryOptions(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ category: opportunities.category })
    .from(opportunities)
    .where(sql`${opportunities.category} IS NOT NULL`)
    .orderBy(opportunities.category);
  return rows.map((r) => r.category).filter((c): c is string => !!c);
}
