import 'server-only';
import {
  and,
  asc,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
} from 'drizzle-orm';
import {
  agencies,
  db,
  documents,
  jurisdictions,
  opportunities,
  taxonomyCategories,
} from '@procur/db';

/**
 * Per-language translations stored on `opportunities.parsed_content`
 * under the `translations` key. Populated by the AI pipeline's
 * translateTask when an opportunity's source language isn't the
 * Procur display language.
 */
export type OpportunityTranslations = Record<
  string,
  { title?: string; description?: string; summary?: string } | undefined
>;

export type OpportunitySummary = {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  referenceNumber: string | null;
  type: string | null;
  category: string | null;
  aiSummary: string | null;
  // Nullable now that the opportunities schema relaxed source_url. In
  // practice every row Discover returns has it set (scraped opportunities
  // always carry a sourceUrl) — uploaded ones are filtered out by
  // `isNull(opportunities.companyId)` upstream.
  sourceUrl: string | null;
  valueEstimate: string | null;
  currency: string | null;
  valueEstimateUsd: string | null;
  publishedAt: Date | null;
  deadlineAt: Date | null;
  jurisdictionSlug: string;
  jurisdictionName: string;
  jurisdictionCountry: string;
  /** UN-style beneficiary country (e.g. "Suriname" for a UNDP-Suriname
   *  notice). Distinct from jurisdictionCountry which marks the
   *  portal's own country. Null for national portals where the
   *  jurisdiction IS the beneficiary. */
  beneficiaryCountry: string | null;
  agencyName: string | null;
  agencyShort: string | null;
  language: string | null;
  translations: OpportunityTranslations | null;
};

export type OpportunitySort = 'deadline-asc' | 'deadline-desc' | 'value-desc' | 'recent';

export type OpportunityFilters = {
  q?: string;
  jurisdiction?: string;
  category?: string;
  /** Beneficiary country name (e.g. "Suriname"). Stored verbatim as
   *  written by the scraper; matches the listing-page filter dropdown. */
  beneficiaryCountry?: string;
  minValueUsd?: number;
  maxValueUsd?: number;
  deadlineBefore?: Date;
  deadlineAfter?: Date;
  /** Filter to rows whose publishedAt (or firstSeenAt fallback) is on
   *  or after this instant. Powers "posted in the last 24 hours" /
   *  "new since yesterday" type queries. */
  publishedAfter?: Date;
};

/**
 * Listing scope:
 *   - 'open'   active tenders whose deadline is still in the future
 *              (or unknown). The default for /opportunities — what a
 *              bidder would actually act on.
 *   - 'past'   closed / awarded — deadline already passed. Useful for
 *              market-intelligence research ("who won fuel contracts
 *              in Jamaica last year?"). Backs the past-awards view.
 *
 * Both scopes share filters and pagination; only the deadline
 * predicate flips.
 */
export type OpportunityScope = 'open' | 'past';

export type ListOpportunitiesInput = OpportunityFilters & {
  page?: number;
  perPage?: number;
  sort?: OpportunitySort;
  scope?: OpportunityScope;
};

/**
 * Past-scope predicate. Unifies two ways an opportunity can be "past":
 *
 *   1. status IN ('awarded','closed') — labeled by a scraper that
 *      consumes an award-notice or closed-tender surface (e.g. Jamaica
 *      GOJEP's award-notices feed sets status='awarded'). This is the
 *      authoritative signal and works even when deadlineAt is null.
 *
 *   2. status='active' AND deadlineAt < now() — legacy/unlabeled rows
 *      where the scraper never set a lifecycle but the deadline has
 *      passed. Most scrapers historically leave everything 'active'.
 *
 * The 'open' scope stays narrow: status='active' AND (no deadline OR
 * deadline still in the future). Awarded/closed rows are explicitly
 * excluded from open even if their deadline somehow lands in the future.
 */
const scopeCondition = (scope: OpportunityScope) =>
  scope === 'past'
    ? or(
        inArray(opportunities.status, ['awarded', 'closed']),
        and(
          eq(opportunities.status, 'active'),
          isNotNull(opportunities.deadlineAt),
          lt(opportunities.deadlineAt, sql`now()`),
        ),
      )!
    : and(
        eq(opportunities.status, 'active'),
        or(gte(opportunities.deadlineAt, sql`now()`), isNull(opportunities.deadlineAt))!,
      )!;

const base = (filters: OpportunityFilters, scope: OpportunityScope = 'open') => {
  const conds = [
    // Privacy boundary: Discover is the public listing — never expose
    // private uploaded opportunities (companyId IS NOT NULL means a
    // tenant's own RFP, scoped to their Capture app only).
    isNull(opportunities.companyId),
    scopeCondition(scope),
  ];
  if (filters.q) {
    const term = `%${filters.q}%`;
    const titleOrDesc = or(
      ilike(opportunities.title, term),
      ilike(opportunities.description, term),
      ilike(opportunities.referenceNumber, term),
    );
    if (titleOrDesc) conds.push(titleOrDesc);
  }
  if (filters.jurisdiction) {
    conds.push(eq(jurisdictions.slug, filters.jurisdiction));
  }
  if (filters.category) {
    conds.push(eq(opportunities.category, filters.category));
  }
  if (filters.beneficiaryCountry) {
    conds.push(eq(opportunities.beneficiaryCountry, filters.beneficiaryCountry));
  }
  if (filters.minValueUsd != null) {
    conds.push(gte(opportunities.valueEstimateUsd, String(filters.minValueUsd)));
  }
  if (filters.maxValueUsd != null) {
    conds.push(lte(opportunities.valueEstimateUsd, String(filters.maxValueUsd)));
  }
  if (filters.deadlineBefore) {
    conds.push(lte(opportunities.deadlineAt, filters.deadlineBefore));
  }
  if (filters.deadlineAfter) {
    conds.push(gte(opportunities.deadlineAt, filters.deadlineAfter));
  }
  if (filters.publishedAfter) {
    // Coalesce on firstSeenAt so rows whose source omitted publishedAt
    // (common for several portals) still hit the "new in last N days"
    // window via when Procur first ingested them.
    conds.push(
      gte(
        sql`coalesce(${opportunities.publishedAt}, ${opportunities.firstSeenAt})`,
        filters.publishedAfter,
      ),
    );
  }
  return and(...conds);
};

export async function listOpportunities(
  input: ListOpportunitiesInput,
): Promise<{ rows: OpportunitySummary[]; total: number }> {
  const perPage = input.perPage ?? 24;
  const page = Math.max(1, input.page ?? 1);
  const offset = (page - 1) * perPage;
  const scope = input.scope ?? 'open';
  const where = base(input, scope);

  // Past awards default to most-recently-closed first; open tenders
  // default to closing-soonest first.
  const defaultSort: OpportunitySort = scope === 'past' ? 'deadline-desc' : 'deadline-asc';
  const orderBy = (() => {
    switch (input.sort ?? defaultSort) {
      case 'deadline-asc':
        return asc(opportunities.deadlineAt);
      case 'deadline-desc':
        return desc(opportunities.deadlineAt);
      case 'value-desc':
        return desc(opportunities.valueEstimateUsd);
      case 'recent':
      default:
        return desc(opportunities.publishedAt);
    }
  })();

  const rows = await db
    .select({
      id: opportunities.id,
      slug: opportunities.slug,
      title: opportunities.title,
      description: opportunities.description,
      referenceNumber: opportunities.referenceNumber,
      type: opportunities.type,
      category: opportunities.category,
      aiSummary: opportunities.aiSummary,
      sourceUrl: opportunities.sourceUrl,
      valueEstimate: opportunities.valueEstimate,
      currency: opportunities.currency,
      valueEstimateUsd: opportunities.valueEstimateUsd,
      publishedAt: opportunities.publishedAt,
      deadlineAt: opportunities.deadlineAt,
      jurisdictionSlug: jurisdictions.slug,
      jurisdictionName: jurisdictions.name,
      jurisdictionCountry: jurisdictions.countryCode,
      beneficiaryCountry: opportunities.beneficiaryCountry,
      agencyName: agencies.name,
      agencyShort: agencies.shortName,
      language: opportunities.language,
      translations: sql<OpportunityTranslations | null>`${opportunities.parsedContent}->'translations'`,
    })
    .from(opportunities)
    .innerJoin(jurisdictions, eq(jurisdictions.id, opportunities.jurisdictionId))
    .leftJoin(agencies, eq(agencies.id, opportunities.agencyId))
    .where(where)
    .orderBy(orderBy)
    .limit(perPage)
    .offset(offset);

  const [countRow] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(opportunities)
    .innerJoin(jurisdictions, eq(jurisdictions.id, opportunities.jurisdictionId))
    .where(where);

  const total = countRow?.c ?? 0;
  return {
    rows: rows.map((r) => ({ ...r, slug: r.slug ?? '' })),
    total,
  };
}

export type OpportunityDetail = OpportunitySummary & {
  /** When Procur first scraped this opportunity. Surfaced as a fallback
   *  for "posted on" when the source portal didn't expose publishedAt. */
  firstSeenAt: Date | null;
  preBidMeetingAt: Date | null;
  clarificationDeadlineAt: Date | null;
  subCategory: string | null;
  tags: string[] | null;
  status: 'active' | 'closed' | 'awarded' | 'cancelled';
  awardedAt: Date | null;
  awardedAmount: string | null;
  awardedToCompanyName: string | null;
};

export async function getOpportunityBySlug(
  slug: string,
): Promise<(OpportunityDetail & { id: string }) | null> {
  const [row] = await db
    .select({
      id: opportunities.id,
      slug: opportunities.slug,
      title: opportunities.title,
      description: opportunities.description,
      referenceNumber: opportunities.referenceNumber,
      type: opportunities.type,
      category: opportunities.category,
      subCategory: opportunities.subCategory,
      tags: opportunities.tags,
      aiSummary: opportunities.aiSummary,
      sourceUrl: opportunities.sourceUrl,
      valueEstimate: opportunities.valueEstimate,
      currency: opportunities.currency,
      valueEstimateUsd: opportunities.valueEstimateUsd,
      publishedAt: opportunities.publishedAt,
      deadlineAt: opportunities.deadlineAt,
      preBidMeetingAt: opportunities.preBidMeetingAt,
      clarificationDeadlineAt: opportunities.clarificationDeadlineAt,
      firstSeenAt: opportunities.firstSeenAt,
      status: opportunities.status,
      awardedAt: opportunities.awardedAt,
      awardedAmount: opportunities.awardedAmount,
      awardedToCompanyName: opportunities.awardedToCompanyName,
      jurisdictionSlug: jurisdictions.slug,
      jurisdictionName: jurisdictions.name,
      jurisdictionCountry: jurisdictions.countryCode,
      beneficiaryCountry: opportunities.beneficiaryCountry,
      agencyName: agencies.name,
      agencyShort: agencies.shortName,
      language: opportunities.language,
      translations: sql<OpportunityTranslations | null>`${opportunities.parsedContent}->'translations'`,
    })
    .from(opportunities)
    .innerJoin(jurisdictions, eq(jurisdictions.id, opportunities.jurisdictionId))
    .leftJoin(agencies, eq(agencies.id, opportunities.agencyId))
    // Privacy: even with a slug match, never serve a private uploaded
    // opportunity from Discover. Slugs are easy to guess.
    .where(and(eq(opportunities.slug, slug), isNull(opportunities.companyId)))
    .limit(1);

  if (!row) return null;
  return { ...row, slug: row.slug ?? '' };
}

export async function getOpportunityDocuments(opportunityId: string) {
  return db
    .select({
      id: documents.id,
      title: documents.title,
      originalUrl: documents.originalUrl,
      documentType: documents.documentType,
    })
    .from(documents)
    .where(eq(documents.opportunityId, opportunityId));
}

export async function getGlobalStats() {
  // Same active+future-deadline cut as the listing query, so the
  // headline number matches what the user sees on /opportunities.
  // Excludes private uploaded opportunities (companyId IS NOT NULL) —
  // those are tenant-scoped and shouldn't inflate public marketing copy.
  const activeAndOpen = and(
    eq(opportunities.status, 'active'),
    isNull(opportunities.companyId),
    or(gte(opportunities.deadlineAt, sql`now()`), isNull(opportunities.deadlineAt))!,
  );

  const [active] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(opportunities)
    .where(activeAndOpen);

  // Count jurisdictions that *actually* have at least one active
  // opportunity, not jurisdictions seeded as `active=true`. The
  // seed marks every supported country active so the filter dropdown
  // shows them, but the headline copy "N jurisdictions" should
  // reflect coverage of real data flowing.
  const [juris] = await db
    .select({ c: sql<number>`count(distinct ${opportunities.jurisdictionId})::int` })
    .from(opportunities)
    .where(activeAndOpen);

  return {
    activeOpportunities: active?.c ?? 0,
    jurisdictions: juris?.c ?? 0,
  };
}

export async function getFeaturedOpportunities(limit = 10) {
  const { rows } = await listOpportunities({
    sort: 'value-desc',
    perPage: limit,
    page: 1,
  });
  return rows;
}

export async function listJurisdictions() {
  return db
    .select({
      id: jurisdictions.id,
      slug: jurisdictions.slug,
      name: jurisdictions.name,
      countryCode: jurisdictions.countryCode,
      region: jurisdictions.region,
      opportunitiesCount: jurisdictions.opportunitiesCount,
      active: jurisdictions.active,
      portalName: jurisdictions.portalName,
      portalUrl: jurisdictions.portalUrl,
    })
    .from(jurisdictions)
    .orderBy(asc(jurisdictions.name));
}

export async function getJurisdictionBySlug(slug: string) {
  const [row] = await db
    .select()
    .from(jurisdictions)
    .where(eq(jurisdictions.slug, slug))
    .limit(1);
  return row ?? null;
}

export async function getAgenciesForJurisdiction(jurisdictionId: string) {
  return db
    .select({
      id: agencies.id,
      name: agencies.name,
      slug: agencies.slug,
      shortName: agencies.shortName,
      opportunitiesCount: agencies.opportunitiesCount,
    })
    .from(agencies)
    .where(eq(agencies.jurisdictionId, jurisdictionId))
    .orderBy(desc(agencies.opportunitiesCount));
}

/**
 * Distinct beneficiary-country values across all currently-public,
 * active opportunities — populates the "Beneficiary country" filter
 * dropdown on the listing page. Same partial index that backs the
 * filter (`opp_beneficiary_country_idx WHERE beneficiary_country IS
 * NOT NULL`) serves this query cheaply.
 */
export async function listBeneficiaryCountries(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ country: opportunities.beneficiaryCountry })
    .from(opportunities)
    .where(
      and(
        isNull(opportunities.companyId),
        isNotNull(opportunities.beneficiaryCountry),
        eq(opportunities.status, 'active'),
      ),
    )
    .orderBy(asc(opportunities.beneficiaryCountry));
  return rows
    .map((r) => r.country)
    .filter((c): c is string => c != null && c.length > 0);
}

/**
 * Categories that actually have ≥1 active opportunity. Returning the
 * full taxonomy seed (the prior behavior) created a false UX where
 * users could "filter by Construction" and get 0 results because
 * none of the scraped opportunities have been AI-classified yet.
 *
 * Once `services/ai-pipeline/classify` runs against new inserts, the
 * filter list grows automatically as categories get populated.
 */
export async function listActiveCategories() {
  const rows = await db
    .selectDistinct({
      slug: taxonomyCategories.slug,
      name: taxonomyCategories.name,
      parentSlug: taxonomyCategories.parentSlug,
      sortOrder: taxonomyCategories.sortOrder,
    })
    .from(taxonomyCategories)
    .innerJoin(opportunities, eq(opportunities.category, taxonomyCategories.slug))
    .where(
      and(
        eq(taxonomyCategories.active, true),
        eq(opportunities.status, 'active'),
        // Only public opportunities count toward "this category has data".
        isNull(opportunities.companyId),
      ),
    )
    .orderBy(asc(taxonomyCategories.sortOrder));
  return rows.map(({ sortOrder: _sortOrder, ...rest }) => rest);
}

export type PricingIntelFilters = {
  jurisdiction?: string;
  category?: string;
  beneficiaryCountry?: string;
  /** Limit to awards in the last N days. Default = no limit. */
  withinDays?: number;
};

export type PricingIntelByCurrency = {
  currency: string;
  awardCount: number;
  medianAmount: number | null;
  p90Amount: number | null;
  averageAmount: number | null;
  totalAmount: number | null;
};

export type PricingIntelTopWinner = {
  name: string;
  awardCount: number;
};

export type PricingIntelRecentAward = {
  slug: string | null;
  title: string;
  jurisdiction: string;
  awardedToCompanyName: string | null;
  awardedAmount: number | null;
  currency: string | null;
  awardedAt: string | null;
};

export type PricingIntelResult = {
  filterDescription: string;
  totalAwards: number;
  byCurrency: PricingIntelByCurrency[];
  topWinners: PricingIntelTopWinner[];
  recentAwards: PricingIntelRecentAward[];
};

/**
 * Aggregate past-award statistics for competitive pricing intel.
 *
 * Procurement bidders need to know what number to bid, not just what
 * was published. This rolls up awarded amounts (median + p90 + mean +
 * total) grouped by currency, plus the top 5 winning suppliers and a
 * preview of the last 5 awards. All filters are optional; no filter =
 * pricing intel across the entire awarded catalog.
 *
 * Currencies are kept separate (no FX conversion) so users see real
 * numbers in the right unit. The model can stitch together a "median
 * EU fuel award: €450K, median US fuel award: $1.2M" narrative from
 * the byCurrency rows.
 */
export async function pricingIntel(
  filters: PricingIntelFilters,
): Promise<PricingIntelResult> {
  const conds = [
    eq(opportunities.status, 'awarded'),
    isNull(opportunities.companyId),
    isNotNull(opportunities.awardedAmount),
  ];
  if (filters.jurisdiction) {
    conds.push(eq(jurisdictions.slug, filters.jurisdiction));
  }
  if (filters.category) {
    conds.push(eq(opportunities.category, filters.category));
  }
  if (filters.beneficiaryCountry) {
    conds.push(eq(opportunities.beneficiaryCountry, filters.beneficiaryCountry));
  }
  if (filters.withinDays && filters.withinDays > 0) {
    conds.push(
      gte(
        opportunities.awardedAt,
        sql`now() - interval '${sql.raw(String(filters.withinDays))} days'`,
      ),
    );
  }
  const where = and(...conds);

  // Per-currency percentile aggregation. Postgres percentile_cont() is
  // a continuous percentile from a sorted set — closest matches the
  // "what's the typical award?" question we want answered.
  const byCurrency = (await db
    .select({
      currency: opportunities.currency,
      awardCount: sql<number>`count(*)::int`,
      medianAmount: sql<string | null>`percentile_cont(0.5) within group (order by ${opportunities.awardedAmount}::numeric)::text`,
      p90Amount: sql<string | null>`percentile_cont(0.9) within group (order by ${opportunities.awardedAmount}::numeric)::text`,
      averageAmount: sql<string | null>`avg(${opportunities.awardedAmount}::numeric)::text`,
      totalAmount: sql<string | null>`sum(${opportunities.awardedAmount}::numeric)::text`,
    })
    .from(opportunities)
    .innerJoin(jurisdictions, eq(opportunities.jurisdictionId, jurisdictions.id))
    .where(where)
    .groupBy(opportunities.currency)
    .orderBy(desc(sql<number>`count(*)`))) as Array<{
    currency: string | null;
    awardCount: number;
    medianAmount: string | null;
    p90Amount: string | null;
    averageAmount: string | null;
    totalAmount: string | null;
  }>;

  const topWinners = (await db
    .select({
      name: opportunities.awardedToCompanyName,
      awardCount: sql<number>`count(*)::int`,
    })
    .from(opportunities)
    .innerJoin(jurisdictions, eq(opportunities.jurisdictionId, jurisdictions.id))
    .where(and(where, isNotNull(opportunities.awardedToCompanyName))!)
    .groupBy(opportunities.awardedToCompanyName)
    .orderBy(desc(sql<number>`count(*)`))
    .limit(5)) as Array<{ name: string | null; awardCount: number }>;

  const recentAwards = await db
    .select({
      slug: opportunities.slug,
      title: opportunities.title,
      jurisdictionName: jurisdictions.name,
      awardedToCompanyName: opportunities.awardedToCompanyName,
      awardedAmount: opportunities.awardedAmount,
      currency: opportunities.currency,
      awardedAt: opportunities.awardedAt,
    })
    .from(opportunities)
    .innerJoin(jurisdictions, eq(opportunities.jurisdictionId, jurisdictions.id))
    .where(where)
    .orderBy(desc(opportunities.awardedAt))
    .limit(5);

  const totalAwards = byCurrency.reduce((acc, c) => acc + c.awardCount, 0);

  const filterDescription = [
    filters.jurisdiction ? `jurisdiction=${filters.jurisdiction}` : null,
    filters.category ? `category=${filters.category}` : null,
    filters.beneficiaryCountry ? `country=${filters.beneficiaryCountry}` : null,
    filters.withinDays ? `last ${filters.withinDays} days` : 'all-time',
  ]
    .filter(Boolean)
    .join(', ');

  return {
    filterDescription,
    totalAwards,
    byCurrency: byCurrency
      .filter((c): c is typeof c & { currency: string } => c.currency != null)
      .map((c) => ({
        currency: c.currency,
        awardCount: c.awardCount,
        medianAmount: parseDecimal(c.medianAmount),
        p90Amount: parseDecimal(c.p90Amount),
        averageAmount: parseDecimal(c.averageAmount),
        totalAmount: parseDecimal(c.totalAmount),
      })),
    topWinners: topWinners
      .filter((w): w is typeof w & { name: string } => w.name != null)
      .map((w) => ({ name: w.name, awardCount: w.awardCount })),
    recentAwards: recentAwards.map((r) => ({
      slug: r.slug,
      title: r.title,
      jurisdiction: r.jurisdictionName,
      awardedToCompanyName: r.awardedToCompanyName ?? null,
      awardedAmount: parseDecimal(r.awardedAmount as string | null),
      currency: r.currency ?? null,
      awardedAt: r.awardedAt?.toISOString() ?? null,
    })),
  };
}

function parseDecimal(s: string | null | undefined): number | null {
  if (s == null) return null;
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : null;
}
