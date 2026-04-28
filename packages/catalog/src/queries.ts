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
  awardAwardees,
  awards,
  companies,
  companyCapabilities,
  db,
  documents,
  externalSuppliers,
  jurisdictions,
  opportunities,
  pastPerformance,
  supplierAliases,
  supplierSignals,
  taxonomyCategories,
  users,
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

export type SummarizeFilters = {
  jurisdiction?: string;
  category?: string;
  beneficiaryCountry?: string;
  scope?: OpportunityScope;
  /** Limit to opportunities posted within the last N days. */
  postedWithinDays?: number;
};

export type SummarizeGroupBy =
  | 'jurisdiction'
  | 'category'
  | 'country'
  | 'agency'
  | 'currency';

export type SummarizeBucket = {
  /** The grouping key — e.g., "United States Federal", "petroleum-fuels", "Jamaica". */
  label: string;
  count: number;
  /** Sum of valueEstimateUsd across the bucket. Null when no rows have a value. */
  totalValueUsd: number | null;
};

export type SummarizeResult = {
  filterDescription: string;
  groupBy: SummarizeGroupBy;
  totalRows: number;
  buckets: SummarizeBucket[];
};

/**
 * Aggregate the public catalog into market-sizing buckets. Used by the
 * AI assistant for "how many fuel tenders by country?", "where is the
 * most procurement happening?", "top agencies by activity" type
 * questions.
 *
 * Grouping is one-dimensional in v1 — one breakdown per call. The
 * model can chain calls if it wants two dimensions (e.g., first call
 * groupBy=country, then groupBy=category for the top country).
 *
 * Returns up to 30 buckets sorted by count desc. Empty/null group keys
 * are filtered out (a row with category=null contributes to totalRows
 * but not to any bucket).
 */
export async function summarizeCatalog(
  filters: SummarizeFilters,
  groupBy: SummarizeGroupBy,
): Promise<SummarizeResult> {
  const scope: OpportunityScope = filters.scope ?? 'open';
  const conds = [
    isNull(opportunities.companyId),
    scopeCondition(scope),
  ];
  if (filters.jurisdiction) conds.push(eq(jurisdictions.slug, filters.jurisdiction));
  if (filters.category) conds.push(eq(opportunities.category, filters.category));
  if (filters.beneficiaryCountry) {
    conds.push(eq(opportunities.beneficiaryCountry, filters.beneficiaryCountry));
  }
  if (filters.postedWithinDays && filters.postedWithinDays > 0) {
    conds.push(
      gte(
        sql`coalesce(${opportunities.publishedAt}, ${opportunities.firstSeenAt})`,
        new Date(Date.now() - filters.postedWithinDays * 24 * 60 * 60 * 1000),
      ),
    );
  }
  const where = and(...conds);

  // Pick the GROUP BY expression based on the requested dimension.
  // Each branch joins only what it needs (jurisdictions / agencies)
  // so the simpler queries don't pay for joins they wouldn't use.
  let buckets: SummarizeBucket[];
  if (groupBy === 'jurisdiction') {
    const rows = await db
      .select({
        label: jurisdictions.name,
        count: sql<number>`count(*)::int`,
        totalValueUsd: sql<string | null>`sum(${opportunities.valueEstimateUsd}::numeric)::text`,
      })
      .from(opportunities)
      .innerJoin(jurisdictions, eq(opportunities.jurisdictionId, jurisdictions.id))
      .where(where)
      .groupBy(jurisdictions.name)
      .orderBy(desc(sql<number>`count(*)`))
      .limit(30);
    buckets = rows.map((r) => ({
      label: r.label,
      count: r.count,
      totalValueUsd: parseDecimal(r.totalValueUsd),
    }));
  } else if (groupBy === 'agency') {
    const rows = await db
      .select({
        label: agencies.name,
        count: sql<number>`count(*)::int`,
        totalValueUsd: sql<string | null>`sum(${opportunities.valueEstimateUsd}::numeric)::text`,
      })
      .from(opportunities)
      .innerJoin(jurisdictions, eq(opportunities.jurisdictionId, jurisdictions.id))
      .innerJoin(agencies, eq(opportunities.agencyId, agencies.id))
      .where(where)
      .groupBy(agencies.name)
      .orderBy(desc(sql<number>`count(*)`))
      .limit(30);
    buckets = rows.map((r) => ({
      label: r.label,
      count: r.count,
      totalValueUsd: parseDecimal(r.totalValueUsd),
    }));
  } else {
    // category / country / currency — all live on the opportunities row.
    const col =
      groupBy === 'category'
        ? opportunities.category
        : groupBy === 'country'
          ? opportunities.beneficiaryCountry
          : opportunities.currency;
    const rows = await db
      .select({
        label: col,
        count: sql<number>`count(*)::int`,
        totalValueUsd: sql<string | null>`sum(${opportunities.valueEstimateUsd}::numeric)::text`,
      })
      .from(opportunities)
      .innerJoin(jurisdictions, eq(opportunities.jurisdictionId, jurisdictions.id))
      .where(and(where, isNotNull(col))!)
      .groupBy(col)
      .orderBy(desc(sql<number>`count(*)`))
      .limit(30);
    buckets = rows
      .filter((r): r is typeof r & { label: string } => r.label != null)
      .map((r) => ({
        label: r.label,
        count: r.count,
        totalValueUsd: parseDecimal(r.totalValueUsd),
      }));
  }

  const totalRows = buckets.reduce((acc, b) => acc + b.count, 0);

  const filterDescription = [
    filters.jurisdiction ? `jurisdiction=${filters.jurisdiction}` : null,
    filters.category ? `category=${filters.category}` : null,
    filters.beneficiaryCountry ? `country=${filters.beneficiaryCountry}` : null,
    filters.postedWithinDays ? `posted in last ${filters.postedWithinDays}d` : null,
    filters.scope === 'past' ? 'past awards' : null,
  ]
    .filter(Boolean)
    .join(', ') || 'all open opportunities';

  return { filterDescription, groupBy, totalRows, buckets };
}

export type CompanyProfileResult = {
  companyName: string;
  planTier: string;
  capabilities: Array<{
    name: string;
    category: string;
    description: string | null;
  }>;
  capabilityCategoryCounts: Record<string, number>;
  pastPerformanceCount: number;
  pastPerformanceSamples: Array<{
    projectName: string;
    customerName: string;
    scopeDescription: string;
    totalValue: number | null;
    currency: string | null;
    categories: string[] | null;
    naicsCodes: string[] | null;
    keywords: string[] | null;
  }>;
  /** Categories aggregated from past_performance.categories arrays —
   *  signals what kinds of work the company has actually delivered. */
  pastPerformanceTopCategories: string[];
};

/**
 * Snapshot of a company's profile for the AI assistant. Used to
 * personalize recommendations ("based on your capabilities, this
 * tender looks like a good fit") and gut-check fit ("you've delivered
 * 3 similar projects before").
 *
 * Read-only; never exposes another tenant's data — companyId is the
 * authenticated context's own.
 *
 * Caps the capability list at 50 (largest companies have ~30) and
 * past performance samples at 5 (most-recent first) to keep the
 * model context reasonable. The model can call this once per
 * conversation for context, then make many tool calls without
 * re-fetching.
 */
export async function getCompanyProfile(companyId: string): Promise<CompanyProfileResult | null> {
  const company = await db.query.companies.findFirst({
    where: eq(companies.id, companyId),
    columns: { id: true, name: true, planTier: true },
  });
  if (!company) return null;

  const caps = await db.query.companyCapabilities.findMany({
    where: eq(companyCapabilities.companyId, companyId),
    columns: { name: true, category: true, description: true },
    orderBy: (t, { asc: a }) => [a(t.category), a(t.name)],
    limit: 50,
  });

  const pastPerf = await db
    .select({
      projectName: pastPerformance.projectName,
      customerName: pastPerformance.customerName,
      scopeDescription: pastPerformance.scopeDescription,
      totalValue: pastPerformance.totalValue,
      currency: pastPerformance.currency,
      categories: pastPerformance.categories,
      naicsCodes: pastPerformance.naicsCodes,
      keywords: pastPerformance.keywords,
    })
    .from(pastPerformance)
    .where(eq(pastPerformance.companyId, companyId))
    .orderBy(desc(pastPerformance.updatedAt))
    .limit(5);

  // Count distinct past-performance count separately so the assistant
  // knows the universe size (e.g., "5 of your 47 past projects" vs
  // showing only 5 with no denominator).
  const countRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(pastPerformance)
    .where(eq(pastPerformance.companyId, companyId));
  const pastPerformanceCount = countRows[0]?.count ?? 0;

  const capabilityCategoryCounts: Record<string, number> = {};
  for (const c of caps) {
    capabilityCategoryCounts[c.category] = (capabilityCategoryCounts[c.category] ?? 0) + 1;
  }

  // Roll up the categories arrays from past performance into top
  // tags by frequency — e.g. ["fuel-supply": 6, "construction": 3].
  const categoryFreq = new Map<string, number>();
  for (const p of pastPerf) {
    for (const cat of p.categories ?? []) {
      categoryFreq.set(cat, (categoryFreq.get(cat) ?? 0) + 1);
    }
  }
  const pastPerformanceTopCategories = Array.from(categoryFreq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([cat]) => cat);

  return {
    companyName: company.name,
    planTier: company.planTier,
    capabilities: caps.map((c) => ({
      name: c.name,
      category: c.category,
      description: c.description ?? null,
    })),
    capabilityCategoryCounts,
    pastPerformanceCount,
    pastPerformanceSamples: pastPerf.map((p) => ({
      projectName: p.projectName,
      customerName: p.customerName,
      scopeDescription: p.scopeDescription.slice(0, 500),
      totalValue: parseDecimal(p.totalValue as string | null),
      currency: p.currency ?? null,
      categories: p.categories,
      naicsCodes: p.naicsCodes,
      keywords: p.keywords,
    })),
    pastPerformanceTopCategories,
  };
}

export type BriefOpportunityResult =
  | { found: false }
  | {
      found: true;
      opportunity: {
        slug: string | null;
        title: string;
        description: string | null;
        agency: string | null;
        jurisdiction: string;
        beneficiaryCountry: string | null;
        category: string | null;
        deadlineAt: string | null;
        publishedAt: string | null;
        valueEstimate: number | null;
        valueEstimateUsd: number | null;
        currency: string | null;
        status: string;
        sourceUrl: string | null;
        discoverUrl: string | null;
      };
      companyContext: {
        companyName: string;
        capabilityCategoryCounts: Record<string, number>;
        capabilitySamples: Array<{ name: string; category: string }>;
        pastPerformanceCount: number;
        pastPerformanceTopCategories: string[];
      };
      pricingContext: {
        filterDescription: string;
        totalAwards: number;
        byCurrency: PricingIntelByCurrency[];
        topWinners: PricingIntelTopWinner[];
      };
    };

/**
 * One-shot "Should We Bid" briefing payload. Combines opportunity
 * details, the company's relevant capability/past-performance context,
 * and recent pricing intel for similar past awards in the same
 * category/jurisdiction. The assistant turns this into a concrete
 * fit + price recommendation in a single response, instead of
 * chaining 4 separate tool calls.
 *
 * The pricingContext is scoped to the opportunity's own category +
 * beneficiary country (or jurisdiction when no country) so the
 * "what should we bid" anchor reflects comparable contracts. When the
 * opportunity has no category, pricing context falls back to all
 * awards in its jurisdiction.
 */
export async function briefOpportunity(
  companyId: string,
  opportunitySlug: string,
): Promise<BriefOpportunityResult> {
  const op = await getOpportunityBySlug(opportunitySlug);
  if (!op) return { found: false };

  const profile = await getCompanyProfile(companyId);

  const pricing = await pricingIntel({
    category: op.category ?? undefined,
    beneficiaryCountry: op.beneficiaryCountry ?? undefined,
    // Fall back to jurisdiction scope when the opportunity has no
    // beneficiary country tag — keeps the comparable set non-empty
    // for portals where we don't infer beneficiaryCountry.
    jurisdiction:
      !op.beneficiaryCountry && !op.category ? op.jurisdictionSlug : undefined,
    withinDays: 730, // 2 years of pricing context
  });

  return {
    found: true,
    opportunity: {
      slug: op.slug,
      title: op.title,
      description: op.description?.slice(0, 4000) ?? null,
      agency: op.agencyName ?? null,
      jurisdiction: op.jurisdictionName,
      beneficiaryCountry: op.beneficiaryCountry ?? null,
      category: op.category ?? null,
      deadlineAt: op.deadlineAt?.toISOString() ?? null,
      publishedAt: op.publishedAt?.toISOString() ?? null,
      valueEstimate: parseDecimal(
        (op.valueEstimate as unknown) as string | null,
      ),
      valueEstimateUsd: parseDecimal(
        (op.valueEstimateUsd as unknown) as string | null,
      ),
      currency: op.currency ?? null,
      status: op.status,
      sourceUrl: op.sourceUrl ?? null,
      discoverUrl: op.slug ? `https://discover.procur.app/opportunities/${op.slug}` : null,
    },
    companyContext: profile
      ? {
          companyName: profile.companyName,
          capabilityCategoryCounts: profile.capabilityCategoryCounts,
          // Send 10 sample capabilities — enough signal without
          // dumping the full list.
          capabilitySamples: profile.capabilities.slice(0, 10).map((c) => ({
            name: c.name,
            category: c.category,
          })),
          pastPerformanceCount: profile.pastPerformanceCount,
          pastPerformanceTopCategories: profile.pastPerformanceTopCategories,
        }
      : {
          companyName: 'unknown',
          capabilityCategoryCounts: {},
          capabilitySamples: [],
          pastPerformanceCount: 0,
          pastPerformanceTopCategories: [],
        },
    pricingContext: {
      filterDescription: pricing.filterDescription,
      totalAwards: pricing.totalAwards,
      byCurrency: pricing.byCurrency,
      topWinners: pricing.topWinners,
    },
  };
}

export type WhatsNewResult = {
  since: string;
  /** True when this is the user's first ever call (no prior lastAssistantSeenAt). */
  firstCall: boolean;
  totalNew: number;
  /** Counts grouped by jurisdiction so the model can summarize the
   *  shape of what's new ("12 from EU, 5 from UK, 3 from SAM"). */
  byJurisdiction: Array<{ jurisdiction: string; count: number }>;
  byCategory: Array<{ category: string; count: number }>;
  /** Top N most-recent opportunities for inline preview. */
  topNew: Array<{
    slug: string | null;
    title: string;
    jurisdiction: string;
    category: string | null;
    publishedAt: string | null;
    url: string | null;
  }>;
};

/**
 * "What's new for me" digest. Returns opportunities posted (or first
 * ingested) after the user's last_assistant_seen_at, then bumps that
 * timestamp atomically so the next call yields a fresh delta.
 *
 * On the first call (last_assistant_seen_at IS NULL), falls back to
 * a 7-day window so the user gets something useful immediately
 * instead of an empty result.
 *
 * Bumps the timestamp BEFORE serializing the response so a slow
 * client doesn't double-count rows on retry. The trade-off is that
 * a server-side error after the bump but before the user sees the
 * data could lose a delta — acceptable for a passive digest.
 */
export async function whatsNewForUser(userId: string): Promise<WhatsNewResult> {
  const userRow = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { lastAssistantSeenAt: true },
  });
  const lastSeen = userRow?.lastAssistantSeenAt ?? null;
  const firstCall = lastSeen == null;
  const since = lastSeen ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const now = new Date();

  // Bump first; on a slow / dropped response the user just sees this
  // delta on the next call instead of getting it twice.
  await db
    .update(users)
    .set({ lastAssistantSeenAt: now })
    .where(eq(users.id, userId));

  const where = and(
    isNull(opportunities.companyId),
    eq(opportunities.status, 'active'),
    gte(
      sql`coalesce(${opportunities.publishedAt}, ${opportunities.firstSeenAt})`,
      since,
    ),
  );

  const totalRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(opportunities)
    .innerJoin(jurisdictions, eq(opportunities.jurisdictionId, jurisdictions.id))
    .where(where);
  const totalNew = totalRows[0]?.count ?? 0;

  const byJurisdiction = await db
    .select({
      jurisdiction: jurisdictions.name,
      count: sql<number>`count(*)::int`,
    })
    .from(opportunities)
    .innerJoin(jurisdictions, eq(opportunities.jurisdictionId, jurisdictions.id))
    .where(where)
    .groupBy(jurisdictions.name)
    .orderBy(desc(sql<number>`count(*)`))
    .limit(10);

  const byCategory = await db
    .select({
      category: opportunities.category,
      count: sql<number>`count(*)::int`,
    })
    .from(opportunities)
    .innerJoin(jurisdictions, eq(opportunities.jurisdictionId, jurisdictions.id))
    .where(and(where, isNotNull(opportunities.category))!)
    .groupBy(opportunities.category)
    .orderBy(desc(sql<number>`count(*)`))
    .limit(10);

  const topNew = await db
    .select({
      slug: opportunities.slug,
      title: opportunities.title,
      jurisdictionName: jurisdictions.name,
      category: opportunities.category,
      publishedAt: opportunities.publishedAt,
      firstSeenAt: opportunities.firstSeenAt,
    })
    .from(opportunities)
    .innerJoin(jurisdictions, eq(opportunities.jurisdictionId, jurisdictions.id))
    .where(where)
    .orderBy(
      desc(sql`coalesce(${opportunities.publishedAt}, ${opportunities.firstSeenAt})`),
    )
    .limit(10);

  return {
    since: since.toISOString(),
    firstCall,
    totalNew,
    byJurisdiction: byJurisdiction.map((r) => ({
      jurisdiction: r.jurisdiction,
      count: r.count,
    })),
    byCategory: byCategory
      .filter((r): r is typeof r & { category: string } => r.category != null)
      .map((r) => ({ category: r.category, count: r.count })),
    topNew: topNew.map((r) => ({
      slug: r.slug,
      title: r.title,
      jurisdiction: r.jurisdictionName,
      category: r.category ?? null,
      publishedAt: (r.publishedAt ?? r.firstSeenAt)?.toISOString() ?? null,
      url: r.slug ? `https://discover.procur.app/opportunities/${r.slug}` : null,
    })),
  };
}

// ─── Supplier graph ──────────────────────────────────────────────────
//
// Three queries against the awards / award_awardees / external_suppliers /
// supplier_aliases tables. Public-domain — no companyId scoping. The
// supplier_signals branch in analyzeSupplier is currently unscoped
// because the table is empty for v1; once private behavioral data
// starts landing there it MUST be filtered by ctx.companyId. See the
// TENANT SCOPING TODO in packages/db/src/schema/supplier-signals.ts.

export interface CommodityOfferSpec {
  /** Internal taxonomy tag — e.g. 'crude-oil', 'diesel', 'jet-fuel', 'food-commodities'. */
  categoryTag: string;
  /** Optional commodity name keywords to match against commodity_description (ILIKE). */
  descriptionKeywords?: string[];
  /** Optional UNSPSC codes to require (any-match). */
  unspscCodes?: string[];
  /** Optional ISO-2 country list to filter buyer_country. Empty = all. */
  buyerCountries?: string[];
  /** How far back to look. Default: 5 years. */
  yearsLookback?: number;
  /** Minimum number of matching awards a buyer must have. Default: 2. */
  minAwards?: number;
  /** Page size. Default: 50. */
  limit?: number;
}

export interface CandidateBuyer {
  buyerName: string;
  buyerCountry: string;
  awardsCount: number;
  totalValueUsd: number | null;
  mostRecentAwardDate: string;
  agencies: string[];
  commoditiesBought: string[];
  beneficiaryCountries: string[];
  exampleAwardIds: string[];
}

/**
 * Reverse search: given a commodity offer, find public buyers who
 * have demonstrably bought that commodity in recent history. Returns
 * a ranked list ordered by recency × volume.
 *
 * This is THE function VTC runs on every supplier offer. Schema is
 * stable; the query template should not change without a deliberate
 * conversation about the strategic implication.
 */
export async function findBuyersForCommodityOffer(
  spec: CommodityOfferSpec,
): Promise<CandidateBuyer[]> {
  const yearsLookback = spec.yearsLookback ?? 5;
  const minAwards = spec.minAwards ?? 2;
  const limit = spec.limit ?? 50;

  const result = await db.execute(sql`
    WITH matching_awards AS (
      SELECT
        a.id,
        a.buyer_name,
        a.buyer_country,
        a.contract_value_usd,
        a.award_date,
        a.commodity_description,
        a.beneficiary_country,
        ag.name AS agency_name
      FROM awards a
      LEFT JOIN agencies ag ON ag.id = a.agency_id
      WHERE
        ${spec.categoryTag} = ANY(a.category_tags)
        AND a.award_date >= NOW() - (${yearsLookback}::int || ' years')::interval
        ${
          spec.descriptionKeywords && spec.descriptionKeywords.length > 0
            ? sql`AND (${sql.join(
                spec.descriptionKeywords.map(
                  (kw) => sql`a.commodity_description ILIKE ${'%' + kw + '%'}`,
                ),
                sql` OR `,
              )})`
            : sql``
        }
        ${
          spec.unspscCodes && spec.unspscCodes.length > 0
            ? sql`AND a.unspsc_codes && ${spec.unspscCodes}::text[]`
            : sql``
        }
        ${
          spec.buyerCountries && spec.buyerCountries.length > 0
            ? sql`AND a.buyer_country = ANY(${spec.buyerCountries}::text[])`
            : sql``
        }
    )
    SELECT
      buyer_name,
      buyer_country,
      COUNT(*)::int                                     AS awards_count,
      SUM(contract_value_usd)                           AS total_value_usd,
      MAX(award_date)                                   AS most_recent_award_date,
      ARRAY_AGG(DISTINCT agency_name) FILTER (WHERE agency_name IS NOT NULL) AS agencies,
      ARRAY_AGG(DISTINCT commodity_description) FILTER (WHERE commodity_description IS NOT NULL) AS commodities_bought,
      ARRAY_AGG(DISTINCT beneficiary_country) FILTER (WHERE beneficiary_country IS NOT NULL) AS beneficiary_countries,
      (ARRAY_AGG(id ORDER BY award_date DESC))[1:5]    AS example_award_ids
    FROM matching_awards
    GROUP BY buyer_name, buyer_country
    HAVING COUNT(*) >= ${minAwards}
    ORDER BY MAX(award_date) DESC, SUM(contract_value_usd) DESC NULLS LAST
    LIMIT ${limit};
  `);

  return (result.rows as Array<Record<string, unknown>>).map((r) => ({
    buyerName: String(r.buyer_name),
    buyerCountry: String(r.buyer_country),
    awardsCount: Number(r.awards_count),
    totalValueUsd:
      r.total_value_usd != null ? Number.parseFloat(String(r.total_value_usd)) : null,
    mostRecentAwardDate:
      r.most_recent_award_date instanceof Date
        ? r.most_recent_award_date.toISOString().slice(0, 10)
        : String(r.most_recent_award_date),
    agencies: (r.agencies as string[] | null) ?? [],
    commoditiesBought: (r.commodities_bought as string[] | null) ?? [],
    beneficiaryCountries: (r.beneficiary_countries as string[] | null) ?? [],
    exampleAwardIds: (r.example_award_ids as string[] | null) ?? [],
  }));
}

export interface FindSuppliersForTenderArgs {
  /** When provided, the function derives category/keywords/jurisdiction from
   *  the opportunity record (via opportunities.id lookup). Otherwise the
   *  caller passes the explicit fields below. */
  opportunityId?: string;
  categoryTag?: string;
  descriptionKeywords?: string[];
  buyerCountry?: string;
  beneficiaryCountry?: string;
  yearsLookback?: number;
  limit?: number;
}

export interface CandidateSupplier {
  supplierId: string;
  supplierName: string;
  country: string | null;
  matchingAwardsCount: number;
  totalValueUsd: number | null;
  mostRecentAwardDate: string;
  recentBuyers: string[];
  matchReasons: string[];
}

export interface FindSuppliersForTenderResult {
  /** Whether the query inputs came from the opportunity record or from explicit args. */
  derivedFrom: 'opportunity' | 'explicit_args';
  categoryTag: string | null;
  suppliers: CandidateSupplier[];
}

/**
 * Buy-side recommendation: given a tender (either by opportunity ID
 * or by explicit category/country fields), return suppliers who have
 * won similar awards in recent history and are plausible bidders.
 *
 * Inverse of findBuyersForCommodityOffer — same JOIN graph, but
 * groups by supplier instead of buyer, and the filter is the tender's
 * own category/country instead of an offer spec.
 *
 * Match-reason strings explain why a supplier ranked where it did
 * (e.g. "5 diesel awards in DO since 2023", "won similar contract for
 * Ministry of Health in 2024"). Generated rule-based for v1; learned
 * ranker is deferred.
 */
export async function findSuppliersForTender(
  _companyId: string | null,
  args: FindSuppliersForTenderArgs,
): Promise<FindSuppliersForTenderResult> {
  let categoryTag = args.categoryTag ?? null;
  let descriptionKeywords = args.descriptionKeywords;
  let buyerCountry = args.buyerCountry;
  let beneficiaryCountry = args.beneficiaryCountry;
  let derivedFrom: 'opportunity' | 'explicit_args' = 'explicit_args';

  if (args.opportunityId) {
    const opp = await db.query.opportunities.findFirst({
      where: eq(opportunities.id, args.opportunityId),
      columns: {
        category: true,
        beneficiaryCountry: true,
        jurisdictionId: true,
        title: true,
      },
    });
    if (opp) {
      derivedFrom = 'opportunity';
      categoryTag = categoryTag ?? opp.category ?? null;
      beneficiaryCountry = beneficiaryCountry ?? opp.beneficiaryCountry ?? undefined;
      // Buyer country isn't on the opportunity row directly — could be
      // resolved via jurisdiction.countryCode but skipping for v1 to
      // keep the implementation lean. Caller can still pass explicitly.
    }
  }

  if (!categoryTag) {
    return { derivedFrom, categoryTag: null, suppliers: [] };
  }

  const yearsLookback = args.yearsLookback ?? 5;
  const limit = args.limit ?? 15;

  const result = await db.execute(sql`
    WITH matching_awards AS (
      SELECT
        a.id,
        a.buyer_name,
        a.buyer_country,
        a.beneficiary_country,
        a.contract_value_usd,
        a.award_date,
        a.commodity_description,
        aa.supplier_id,
        s.organisation_name,
        s.country AS supplier_country
      FROM awards a
      JOIN award_awardees aa ON aa.award_id = a.id
      JOIN external_suppliers s ON s.id = aa.supplier_id
      WHERE
        ${categoryTag} = ANY(a.category_tags)
        AND a.award_date >= NOW() - (${yearsLookback}::int || ' years')::interval
        ${
          descriptionKeywords && descriptionKeywords.length > 0
            ? sql`AND (${sql.join(
                descriptionKeywords.map(
                  (kw) => sql`a.commodity_description ILIKE ${'%' + kw + '%'}`,
                ),
                sql` OR `,
              )})`
            : sql``
        }
    ),
    ranked AS (
      SELECT
        supplier_id,
        organisation_name,
        supplier_country,
        COUNT(*)::int AS matching_awards_count,
        SUM(contract_value_usd) AS total_value_usd,
        MAX(award_date) AS most_recent_award_date,
        (ARRAY_AGG(DISTINCT buyer_name))[1:5] AS recent_buyers,
        BOOL_OR(buyer_country = ${buyerCountry ?? ''}) AS buyer_country_match,
        BOOL_OR(beneficiary_country = ${beneficiaryCountry ?? ''}) AS beneficiary_country_match
      FROM matching_awards
      GROUP BY supplier_id, organisation_name, supplier_country
    )
    SELECT *
    FROM ranked
    ORDER BY
      -- Geography overlap first (boolean to int via CASE), then volume.
      (CASE WHEN buyer_country_match THEN 1 ELSE 0 END
        + CASE WHEN beneficiary_country_match THEN 1 ELSE 0 END) DESC,
      most_recent_award_date DESC,
      total_value_usd DESC NULLS LAST
    LIMIT ${limit};
  `);

  const suppliers: CandidateSupplier[] = (result.rows as Array<Record<string, unknown>>).map(
    (r) => {
      const matchReasons: string[] = [];
      const count = Number(r.matching_awards_count);
      matchReasons.push(`${count} ${categoryTag} award${count === 1 ? '' : 's'} in last ${yearsLookback}y`);
      if (r.buyer_country_match) {
        matchReasons.push(`previously won in ${buyerCountry}`);
      }
      if (r.beneficiary_country_match) {
        matchReasons.push(`delivered to ${beneficiaryCountry}`);
      }
      return {
        supplierId: String(r.supplier_id),
        supplierName: String(r.organisation_name),
        country: r.supplier_country == null ? null : String(r.supplier_country),
        matchingAwardsCount: count,
        totalValueUsd:
          r.total_value_usd != null ? Number.parseFloat(String(r.total_value_usd)) : null,
        mostRecentAwardDate:
          r.most_recent_award_date instanceof Date
            ? r.most_recent_award_date.toISOString().slice(0, 10)
            : String(r.most_recent_award_date),
        recentBuyers: (r.recent_buyers as string[] | null) ?? [],
        matchReasons,
      };
    },
  );

  return { derivedFrom, categoryTag, suppliers };
}

export interface CompetingSellerArgs {
  /** Internal commodity tag — same vocabulary as find_buyers_for_offer. */
  categoryTag: string;
  /** Optional ISO-2 list filtering buyer geography (i.e., where the
   *  awards landed). Omit for global. */
  buyerCountries?: string[];
  /** Window for "active". Default 12 months. */
  monthsLookback?: number;
  /** Window before that for the "ever active" pool used to derive
   *  dormant suppliers. Default 36 months. */
  dormantLookbackMonths?: number;
  /** Cap rows per group. Default 25. */
  limit?: number;
}

export interface CompetingSellerRow {
  supplierId: string;
  supplierName: string;
  country: string | null;
  awardsCount: number;
  totalValueUsd: number | null;
  avgValueUsd: number | null;
  mostRecentAwardDate: string;
  recentBuyers: string[];
}

export interface DormantSellerRow {
  supplierId: string;
  supplierName: string;
  country: string | null;
  /** Last award in the longer-lookback pool. By definition pre-window. */
  mostRecentAwardDate: string;
  /** Total awards in the longer pool — proxies "capability". */
  historicalAwardsCount: number;
  historicalTotalValueUsd: number | null;
}

export interface CompetingSellersMarketStats {
  /** Distinct active sellers in the window. */
  activeSellersCount: number;
  /** Awards in the window (denominator for "share"). */
  totalAwardsInWindow: number;
  /** Sum of contract_value_usd across the window (null if all rows null). */
  totalValueUsd: number | null;
  /** Median + p25/p75 of per-award contract_value_usd — price band proxy. */
  medianAwardValueUsd: number | null;
  p25AwardValueUsd: number | null;
  p75AwardValueUsd: number | null;
}

export interface CompetingSellersResult {
  categoryTag: string;
  marketStats: CompetingSellersMarketStats;
  activeSellers: CompetingSellerRow[];
  dormantSellers: DormantSellerRow[];
}

/**
 * Sell-side market intel: who has been winning a category in a
 * geography lately, vs who has the capability but has gone quiet.
 *
 * Distinct from `findSuppliersForTender`:
 *   - That's framed around a specific tender (existing opportunity or
 *     explicit fields) and ranks plausible bidders.
 *   - This is framed around competitive landscape — splits suppliers
 *     into ACTIVE (won in last N months) and DORMANT (won in the
 *     longer history but not in the recent window). The dormant
 *     slice is the strategically interesting one for VTC's sell-side
 *     workflow: capability + no recent wins = high responsiveness to
 *     alternative deal structures (back-to-back, off-take).
 *
 * Also returns market-level price-band stats (median + p25/p75 of
 * per-award $USD) so callers can sanity-check whether a broker offer
 * is competitive without round-tripping a separate query.
 */
export async function findCompetingSellers(
  args: CompetingSellerArgs,
): Promise<CompetingSellersResult> {
  const monthsLookback = args.monthsLookback ?? 12;
  const dormantLookbackMonths = args.dormantLookbackMonths ?? 36;
  const limit = args.limit ?? 25;

  // ACTIVE — supplier won at least one award in the recent window.
  const activeRows = await db.execute(sql`
    SELECT
      s.id                          AS supplier_id,
      s.organisation_name           AS supplier_name,
      s.country,
      COUNT(*)::int                 AS awards_count,
      SUM(a.contract_value_usd)     AS total_value_usd,
      AVG(a.contract_value_usd)     AS avg_value_usd,
      MAX(a.award_date)             AS most_recent_award_date,
      (ARRAY_AGG(DISTINCT a.buyer_name))[1:5] AS recent_buyers
    FROM awards a
    JOIN award_awardees aa ON aa.award_id = a.id
    JOIN external_suppliers s ON s.id = aa.supplier_id
    WHERE
      ${args.categoryTag} = ANY(a.category_tags)
      AND a.award_date >= NOW() - (${monthsLookback}::int || ' months')::interval
      ${
        args.buyerCountries && args.buyerCountries.length > 0
          ? sql`AND a.buyer_country = ANY(${args.buyerCountries}::text[])`
          : sql``
      }
    GROUP BY s.id, s.organisation_name, s.country
    ORDER BY MAX(a.award_date) DESC, COUNT(*) DESC
    LIMIT ${limit};
  `);

  // DORMANT — supplier won in the broader pool but not in the recent window.
  // Anti-join via NOT EXISTS keeps Postgres on a hash-anti plan.
  const dormantRows = await db.execute(sql`
    SELECT
      s.id                          AS supplier_id,
      s.organisation_name           AS supplier_name,
      s.country,
      COUNT(*)::int                 AS historical_awards_count,
      SUM(a.contract_value_usd)     AS historical_total_value_usd,
      MAX(a.award_date)             AS most_recent_award_date
    FROM awards a
    JOIN award_awardees aa ON aa.award_id = a.id
    JOIN external_suppliers s ON s.id = aa.supplier_id
    WHERE
      ${args.categoryTag} = ANY(a.category_tags)
      AND a.award_date >= NOW() - (${dormantLookbackMonths}::int || ' months')::interval
      AND a.award_date < NOW() - (${monthsLookback}::int || ' months')::interval
      ${
        args.buyerCountries && args.buyerCountries.length > 0
          ? sql`AND a.buyer_country = ANY(${args.buyerCountries}::text[])`
          : sql``
      }
      AND NOT EXISTS (
        SELECT 1
        FROM awards a2
        JOIN award_awardees aa2 ON aa2.award_id = a2.id
        WHERE
          aa2.supplier_id = s.id
          AND ${args.categoryTag} = ANY(a2.category_tags)
          AND a2.award_date >= NOW() - (${monthsLookback}::int || ' months')::interval
          ${
            args.buyerCountries && args.buyerCountries.length > 0
              ? sql`AND a2.buyer_country = ANY(${args.buyerCountries}::text[])`
              : sql``
          }
      )
    GROUP BY s.id, s.organisation_name, s.country
    ORDER BY MAX(a.award_date) DESC, COUNT(*) DESC
    LIMIT ${limit};
  `);

  // Market-level stats over the active window — single query keeps
  // the percentile pass cheap.
  const statsRows = await db.execute(sql`
    SELECT
      COUNT(DISTINCT aa.supplier_id)::int                                 AS active_sellers_count,
      COUNT(*)::int                                                       AS total_awards_in_window,
      SUM(a.contract_value_usd)                                           AS total_value_usd,
      percentile_cont(0.50) WITHIN GROUP (ORDER BY a.contract_value_usd)  AS median_award_value_usd,
      percentile_cont(0.25) WITHIN GROUP (ORDER BY a.contract_value_usd)  AS p25_award_value_usd,
      percentile_cont(0.75) WITHIN GROUP (ORDER BY a.contract_value_usd)  AS p75_award_value_usd
    FROM awards a
    JOIN award_awardees aa ON aa.award_id = a.id
    WHERE
      ${args.categoryTag} = ANY(a.category_tags)
      AND a.award_date >= NOW() - (${monthsLookback}::int || ' months')::interval
      ${
        args.buyerCountries && args.buyerCountries.length > 0
          ? sql`AND a.buyer_country = ANY(${args.buyerCountries}::text[])`
          : sql``
      };
  `);
  const stats = (statsRows.rows as Array<Record<string, unknown>>)[0] ?? {};

  return {
    categoryTag: args.categoryTag,
    marketStats: {
      activeSellersCount: Number(stats.active_sellers_count ?? 0),
      totalAwardsInWindow: Number(stats.total_awards_in_window ?? 0),
      totalValueUsd:
        stats.total_value_usd != null
          ? Number.parseFloat(String(stats.total_value_usd))
          : null,
      medianAwardValueUsd:
        stats.median_award_value_usd != null
          ? Number.parseFloat(String(stats.median_award_value_usd))
          : null,
      p25AwardValueUsd:
        stats.p25_award_value_usd != null
          ? Number.parseFloat(String(stats.p25_award_value_usd))
          : null,
      p75AwardValueUsd:
        stats.p75_award_value_usd != null
          ? Number.parseFloat(String(stats.p75_award_value_usd))
          : null,
    },
    activeSellers: (activeRows.rows as Array<Record<string, unknown>>).map((r) => ({
      supplierId: String(r.supplier_id),
      supplierName: String(r.supplier_name),
      country: r.country == null ? null : String(r.country),
      awardsCount: Number(r.awards_count),
      totalValueUsd:
        r.total_value_usd != null ? Number.parseFloat(String(r.total_value_usd)) : null,
      avgValueUsd:
        r.avg_value_usd != null ? Number.parseFloat(String(r.avg_value_usd)) : null,
      mostRecentAwardDate:
        r.most_recent_award_date instanceof Date
          ? r.most_recent_award_date.toISOString().slice(0, 10)
          : String(r.most_recent_award_date),
      recentBuyers: (r.recent_buyers as string[] | null) ?? [],
    })),
    dormantSellers: (dormantRows.rows as Array<Record<string, unknown>>).map((r) => ({
      supplierId: String(r.supplier_id),
      supplierName: String(r.supplier_name),
      country: r.country == null ? null : String(r.country),
      historicalAwardsCount: Number(r.historical_awards_count),
      historicalTotalValueUsd:
        r.historical_total_value_usd != null
          ? Number.parseFloat(String(r.historical_total_value_usd))
          : null,
      mostRecentAwardDate:
        r.most_recent_award_date instanceof Date
          ? r.most_recent_award_date.toISOString().slice(0, 10)
          : String(r.most_recent_award_date),
    })),
  };
}

export type AnalyzeSupplierArgs = {
  supplierId?: string;
  supplierName?: string;
  yearsLookback?: number;
};

export type SupplierAnalysisDisambig = {
  kind: 'disambiguation_needed';
  candidates: Array<{
    supplierId: string;
    canonicalName: string;
    country: string | null;
    totalAwards: number;
    similarityScore: number;
  }>;
};

export type SupplierAnalysisNotFound = {
  kind: 'not_found';
};

export type SupplierAnalysisProfile = {
  kind: 'profile';
  supplier: {
    id: string;
    canonicalName: string;
    country: string | null;
    aliases: string[];
  };
  summary: {
    totalAwards: number;
    totalValueUsd: number | null;
    firstAwardDate: string | null;
    mostRecentAwardDate: string | null;
    awardsByCategory: Record<string, number>;
    buyerCountries: string[];
    beneficiaryCountries: string[];
  };
  topBuyers: Array<{ buyerName: string; awardsCount: number; totalValueUsd: number | null }>;
  recentAwards: Array<{
    awardDate: string;
    buyerName: string;
    buyerCountry: string;
    title: string | null;
    contractValueUsd: number | null;
  }>;
  signals: Array<{ signalType: string; signalValue: unknown; observedAt: string }>;
};

export type SupplierAnalysisResult =
  | SupplierAnalysisDisambig
  | SupplierAnalysisNotFound
  | SupplierAnalysisProfile;

/**
 * Drilldown for a single supplier. Resolves either by ID directly or
 * by fuzzy name via supplier_aliases (trigram similarity > 0.55).
 *
 * Disambiguation: if multiple candidates clear the threshold and no
 * single one dominates by similarity, returns the candidate list and
 * lets the caller (LLM) pick. Don't auto-select highest match —
 * "Total" matches multiple TotalEnergies entities and silently
 * picking one is worse than asking.
 *
 * SIGNALS NOTE: For v1 the supplier_signals branch is unscoped (table
 * is empty in production). Once private behavioral data starts
 * landing there, this query MUST filter by the caller's companyId —
 * see TENANT SCOPING TODO in packages/db/src/schema/supplier-signals.ts.
 */
export async function analyzeSupplier(
  args: AnalyzeSupplierArgs,
): Promise<SupplierAnalysisResult> {
  const yearsLookback = args.yearsLookback ?? 10;

  let resolvedSupplierId = args.supplierId ?? null;

  // Fuzzy resolution path
  if (!resolvedSupplierId && args.supplierName) {
    const normalized = normalizeSupplierName(args.supplierName);
    const candidates = await db.execute(sql`
      WITH alias_matches AS (
        SELECT
          sa.supplier_id,
          MAX(similarity(sa.alias_normalized, ${normalized})) AS sim
        FROM supplier_aliases sa
        WHERE sa.alias_normalized % ${normalized}
        GROUP BY sa.supplier_id
      )
      SELECT
        s.id AS supplier_id,
        s.organisation_name AS canonical_name,
        s.country,
        am.sim AS similarity_score,
        COALESCE(COUNT(aa.award_id), 0)::int AS total_awards
      FROM alias_matches am
      JOIN external_suppliers s ON s.id = am.supplier_id
      LEFT JOIN award_awardees aa ON aa.supplier_id = s.id
      WHERE am.sim >= 0.55
      GROUP BY s.id, s.organisation_name, s.country, am.sim
      ORDER BY am.sim DESC, total_awards DESC
      LIMIT 5;
    `);

    const rows = candidates.rows as Array<Record<string, unknown>>;
    if (rows.length === 0) {
      // Trigram similarity required pg_trgm and a populated aliases
      // table; one cold-start fallback is to direct-match on
      // organisation_name in case nothing's been aliased yet.
      const nameMatch = await db.query.externalSuppliers.findFirst({
        where: eq(externalSuppliers.organisationName, args.supplierName),
        columns: { id: true },
      });
      if (!nameMatch) return { kind: 'not_found' };
      resolvedSupplierId = nameMatch.id;
    } else if (rows.length === 1 || Number(rows[0]!.similarity_score) >= 0.85) {
      resolvedSupplierId = String(rows[0]!.supplier_id);
    } else {
      return {
        kind: 'disambiguation_needed',
        candidates: rows.map((r) => ({
          supplierId: String(r.supplier_id),
          canonicalName: String(r.canonical_name),
          country: r.country == null ? null : String(r.country),
          totalAwards: Number(r.total_awards),
          similarityScore: Number.parseFloat(String(r.similarity_score)),
        })),
      };
    }
  }

  if (!resolvedSupplierId) return { kind: 'not_found' };

  const supplier = await db.query.externalSuppliers.findFirst({
    where: eq(externalSuppliers.id, resolvedSupplierId),
    columns: { id: true, organisationName: true, country: true },
  });
  if (!supplier) return { kind: 'not_found' };

  const aliasRows = await db
    .select({ alias: supplierAliases.alias })
    .from(supplierAliases)
    .where(eq(supplierAliases.supplierId, resolvedSupplierId))
    .limit(20);

  // Summary roll-up — direct over awards (not the materialized view)
  // so the function works before the nightly refresh has run.
  const summaryRows = await db.execute(sql`
    SELECT
      COUNT(*)::int AS total_awards,
      SUM(a.contract_value_usd) AS total_value_usd,
      MIN(a.award_date) AS first_award_date,
      MAX(a.award_date) AS most_recent_award_date,
      ARRAY_AGG(DISTINCT a.buyer_country) AS buyer_countries,
      ARRAY_AGG(DISTINCT a.beneficiary_country) FILTER (WHERE a.beneficiary_country IS NOT NULL)
        AS beneficiary_countries,
      jsonb_object_agg(tag, cnt) AS awards_by_category
    FROM awards a
    JOIN award_awardees aa ON aa.award_id = a.id
    LEFT JOIN LATERAL (
      SELECT unnest(a.category_tags) AS tag
    ) tags ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS cnt
      FROM awards a2
      JOIN award_awardees aa2 ON aa2.award_id = a2.id
      WHERE aa2.supplier_id = aa.supplier_id
        AND tags.tag = ANY(a2.category_tags)
    ) cat_counts ON TRUE
    WHERE aa.supplier_id = ${resolvedSupplierId}
      AND a.award_date >= NOW() - (${yearsLookback}::int || ' years')::interval
    GROUP BY aa.supplier_id;
  `);
  const summaryRow = (summaryRows.rows as Array<Record<string, unknown>>)[0];

  const topBuyersRows = await db.execute(sql`
    SELECT
      a.buyer_name,
      COUNT(*)::int AS awards_count,
      SUM(a.contract_value_usd) AS total_value_usd
    FROM awards a
    JOIN award_awardees aa ON aa.award_id = a.id
    WHERE aa.supplier_id = ${resolvedSupplierId}
      AND a.award_date >= NOW() - (${yearsLookback}::int || ' years')::interval
    GROUP BY a.buyer_name
    ORDER BY COUNT(*) DESC, SUM(a.contract_value_usd) DESC NULLS LAST
    LIMIT 10;
  `);

  const recentAwardsRows = await db.execute(sql`
    SELECT
      a.award_date,
      a.buyer_name,
      a.buyer_country,
      a.title,
      a.contract_value_usd
    FROM awards a
    JOIN award_awardees aa ON aa.award_id = a.id
    WHERE aa.supplier_id = ${resolvedSupplierId}
    ORDER BY a.award_date DESC
    LIMIT 5;
  `);

  // SIGNALS — currently public/unscoped (table is empty in v1).
  // TENANT SCOPING TODO: filter by ctx.companyId when private signal
  // data starts landing here. See packages/db/src/schema/supplier-signals.ts.
  const signalRows = await db
    .select({
      signalType: supplierSignals.signalType,
      signalValue: supplierSignals.signalValue,
      observedAt: supplierSignals.observedAt,
    })
    .from(supplierSignals)
    .where(eq(supplierSignals.supplierId, resolvedSupplierId))
    .orderBy(desc(supplierSignals.observedAt))
    .limit(20);

  const awardsByCategory: Record<string, number> = {};
  if (summaryRow?.awards_by_category && typeof summaryRow.awards_by_category === 'object') {
    for (const [k, v] of Object.entries(summaryRow.awards_by_category as Record<string, unknown>)) {
      awardsByCategory[k] = Number(v);
    }
  }

  return {
    kind: 'profile',
    supplier: {
      id: supplier.id,
      canonicalName: supplier.organisationName,
      country: supplier.country ?? null,
      aliases: aliasRows.map((r) => r.alias),
    },
    summary: {
      totalAwards: summaryRow?.total_awards != null ? Number(summaryRow.total_awards) : 0,
      totalValueUsd:
        summaryRow?.total_value_usd != null
          ? Number.parseFloat(String(summaryRow.total_value_usd))
          : null,
      firstAwardDate:
        summaryRow?.first_award_date instanceof Date
          ? summaryRow.first_award_date.toISOString().slice(0, 10)
          : summaryRow?.first_award_date != null
            ? String(summaryRow.first_award_date)
            : null,
      mostRecentAwardDate:
        summaryRow?.most_recent_award_date instanceof Date
          ? summaryRow.most_recent_award_date.toISOString().slice(0, 10)
          : summaryRow?.most_recent_award_date != null
            ? String(summaryRow.most_recent_award_date)
            : null,
      awardsByCategory,
      buyerCountries: (summaryRow?.buyer_countries as string[] | null) ?? [],
      beneficiaryCountries: (summaryRow?.beneficiary_countries as string[] | null) ?? [],
    },
    topBuyers: (topBuyersRows.rows as Array<Record<string, unknown>>).map((r) => ({
      buyerName: String(r.buyer_name),
      awardsCount: Number(r.awards_count),
      totalValueUsd:
        r.total_value_usd != null ? Number.parseFloat(String(r.total_value_usd)) : null,
    })),
    recentAwards: (recentAwardsRows.rows as Array<Record<string, unknown>>).map((r) => ({
      awardDate:
        r.award_date instanceof Date
          ? r.award_date.toISOString().slice(0, 10)
          : String(r.award_date),
      buyerName: String(r.buyer_name),
      buyerCountry: String(r.buyer_country),
      title: r.title == null ? null : String(r.title),
      contractValueUsd:
        r.contract_value_usd != null
          ? Number.parseFloat(String(r.contract_value_usd))
          : null,
    })),
    signals: signalRows.map((s) => ({
      signalType: s.signalType,
      signalValue: s.signalValue,
      observedAt: s.observedAt.toISOString(),
    })),
  };
}

/**
 * Lowercase, strip common corporate suffixes, collapse whitespace.
 * Matches the convention the ingestion pipeline uses to populate
 * `supplier_aliases.alias_normalized`.
 *
 * Exported so the assistant tool layer (or future ingestion code)
 * can normalize the same way before fuzzy-matching.
 */
export function normalizeSupplierName(name: string): string {
  return name
    .toLowerCase()
    .replace(
      /\b(s\.?\s?a\.?(\s?s)?|s\.?\s?r\.?\s?l\.?|llc|l\.?l\.?c\.?|inc|inc\.|incorporated|corp|corp\.|corporation|ltd|ltd\.|limited|gmbh|n\.?v\.?|b\.?v\.?|p\.?l\.?c\.?|plc|s\.?p\.?a\.?)\b/g,
      ' ',
    )
    .replace(/[.,&]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Intelligence views (leaderboards + time-series) ─────────────

export interface IntelligenceFilters {
  /** Category tag — required. Use 'all' to skip the category filter. */
  categoryTag: string;
  /** Optional ISO-2 country filter on buyer_country. */
  buyerCountry?: string;
  /** Default 12 months. */
  monthsLookback?: number;
}

export interface TopBuyerRow {
  buyerName: string;
  buyerCountry: string;
  awardsCount: number;
  totalValueUsd: number | null;
  mostRecentAwardDate: string;
}

/**
 * Leaderboard: top N buyers in a category over the lookback window,
 * ranked by awards count then total $USD.
 */
export async function getTopBuyersByCategory(
  filters: IntelligenceFilters,
  limit = 10,
): Promise<TopBuyerRow[]> {
  const monthsLookback = filters.monthsLookback ?? 12;
  const result = await db.execute(sql`
    SELECT
      a.buyer_name,
      a.buyer_country,
      COUNT(*)::int                  AS awards_count,
      SUM(a.contract_value_usd)      AS total_value_usd,
      MAX(a.award_date)              AS most_recent_award_date
    FROM awards a
    WHERE
      a.award_date >= NOW() - (${monthsLookback}::int || ' months')::interval
      ${
        filters.categoryTag === 'all'
          ? sql``
          : sql`AND ${filters.categoryTag} = ANY(a.category_tags)`
      }
      ${
        filters.buyerCountry
          ? sql`AND a.buyer_country = ${filters.buyerCountry}`
          : sql``
      }
    GROUP BY a.buyer_name, a.buyer_country
    ORDER BY COUNT(*) DESC, SUM(a.contract_value_usd) DESC NULLS LAST
    LIMIT ${limit};
  `);
  return (result.rows as Array<Record<string, unknown>>).map((r) => ({
    buyerName: String(r.buyer_name),
    buyerCountry: String(r.buyer_country),
    awardsCount: Number(r.awards_count),
    totalValueUsd:
      r.total_value_usd != null ? Number.parseFloat(String(r.total_value_usd)) : null,
    mostRecentAwardDate:
      r.most_recent_award_date instanceof Date
        ? r.most_recent_award_date.toISOString().slice(0, 10)
        : String(r.most_recent_award_date),
  }));
}

export interface TopSupplierRow {
  supplierId: string;
  supplierName: string;
  country: string | null;
  awardsCount: number;
  totalValueUsd: number | null;
  mostRecentAwardDate: string;
}

/**
 * Leaderboard: top N suppliers winning a category over the lookback
 * window. Returns supplier_id so rows can deep-link to the profile.
 */
export async function getTopSuppliersByCategory(
  filters: IntelligenceFilters,
  limit = 10,
): Promise<TopSupplierRow[]> {
  const monthsLookback = filters.monthsLookback ?? 12;
  const result = await db.execute(sql`
    SELECT
      s.id                    AS supplier_id,
      s.organisation_name     AS supplier_name,
      s.country,
      COUNT(*)::int           AS awards_count,
      SUM(a.contract_value_usd) AS total_value_usd,
      MAX(a.award_date)       AS most_recent_award_date
    FROM awards a
    JOIN award_awardees aa ON aa.award_id = a.id
    JOIN external_suppliers s ON s.id = aa.supplier_id
    WHERE
      a.award_date >= NOW() - (${monthsLookback}::int || ' months')::interval
      ${
        filters.categoryTag === 'all'
          ? sql``
          : sql`AND ${filters.categoryTag} = ANY(a.category_tags)`
      }
      ${
        filters.buyerCountry
          ? sql`AND a.buyer_country = ${filters.buyerCountry}`
          : sql``
      }
    GROUP BY s.id, s.organisation_name, s.country
    ORDER BY COUNT(*) DESC, SUM(a.contract_value_usd) DESC NULLS LAST
    LIMIT ${limit};
  `);
  return (result.rows as Array<Record<string, unknown>>).map((r) => ({
    supplierId: String(r.supplier_id),
    supplierName: String(r.supplier_name),
    country: r.country == null ? null : String(r.country),
    awardsCount: Number(r.awards_count),
    totalValueUsd:
      r.total_value_usd != null ? Number.parseFloat(String(r.total_value_usd)) : null,
    mostRecentAwardDate:
      r.most_recent_award_date instanceof Date
        ? r.most_recent_award_date.toISOString().slice(0, 10)
        : String(r.most_recent_award_date),
  }));
}

export interface MonthlyAwardsBucket {
  month: string; // YYYY-MM
  awardsCount: number;
  totalValueUsd: number | null;
}

/**
 * Time-series: per-month award counts + total $USD. Covers the
 * lookback window plus enough past months to make a sparkline render
 * with consistent baseline (renders empty months as 0).
 */
export async function getMonthlyAwardsVolume(
  filters: IntelligenceFilters,
): Promise<MonthlyAwardsBucket[]> {
  const monthsLookback = filters.monthsLookback ?? 12;
  const result = await db.execute(sql`
    WITH series AS (
      SELECT generate_series(
        date_trunc('month', NOW() - (${monthsLookback}::int || ' months')::interval),
        date_trunc('month', NOW()),
        '1 month'::interval
      ) AS month
    ),
    buckets AS (
      SELECT
        date_trunc('month', a.award_date)::date AS month,
        COUNT(*)::int AS awards_count,
        SUM(a.contract_value_usd) AS total_value_usd
      FROM awards a
      WHERE
        a.award_date >= NOW() - (${monthsLookback}::int || ' months')::interval
        ${
          filters.categoryTag === 'all'
            ? sql``
            : sql`AND ${filters.categoryTag} = ANY(a.category_tags)`
        }
        ${
          filters.buyerCountry
            ? sql`AND a.buyer_country = ${filters.buyerCountry}`
            : sql``
        }
      GROUP BY date_trunc('month', a.award_date)
    )
    SELECT
      to_char(s.month, 'YYYY-MM') AS month,
      COALESCE(b.awards_count, 0) AS awards_count,
      b.total_value_usd
    FROM series s
    LEFT JOIN buckets b ON b.month = s.month
    ORDER BY s.month ASC;
  `);
  return (result.rows as Array<Record<string, unknown>>).map((r) => ({
    month: String(r.month),
    awardsCount: Number(r.awards_count),
    totalValueUsd:
      r.total_value_usd != null ? Number.parseFloat(String(r.total_value_usd)) : null,
  }));
}

export interface NewBuyerRow {
  buyerName: string;
  buyerCountry: string;
  awardsCount: number;
  firstAwardDate: string;
}

/**
 * Diff: buyers active in the recent window who weren't active in the
 * comparison window before that. The "found a new customer" view.
 *
 * Defaults: recent = last 90 days; comparison = the 90 days before
 * that. Symmetric windows so the diff is meaningful even as the
 * underlying data slides forward over time.
 */
export async function getNewBuyers(
  filters: IntelligenceFilters,
  daysWindow = 90,
  limit = 25,
): Promise<NewBuyerRow[]> {
  const result = await db.execute(sql`
    WITH recent AS (
      SELECT
        a.buyer_name,
        a.buyer_country,
        COUNT(*)::int     AS awards_count,
        MIN(a.award_date) AS first_award_date
      FROM awards a
      WHERE
        a.award_date >= NOW() - (${daysWindow}::int || ' days')::interval
        ${
          filters.categoryTag === 'all'
            ? sql``
            : sql`AND ${filters.categoryTag} = ANY(a.category_tags)`
        }
        ${
          filters.buyerCountry
            ? sql`AND a.buyer_country = ${filters.buyerCountry}`
            : sql``
        }
      GROUP BY a.buyer_name, a.buyer_country
    ),
    prior AS (
      SELECT DISTINCT a.buyer_name, a.buyer_country
      FROM awards a
      WHERE
        a.award_date < NOW() - (${daysWindow}::int || ' days')::interval
        AND a.award_date >= NOW() - (${daysWindow * 2}::int || ' days')::interval
        ${
          filters.categoryTag === 'all'
            ? sql``
            : sql`AND ${filters.categoryTag} = ANY(a.category_tags)`
        }
        ${
          filters.buyerCountry
            ? sql`AND a.buyer_country = ${filters.buyerCountry}`
            : sql``
        }
    )
    SELECT r.*
    FROM recent r
    LEFT JOIN prior p
      ON p.buyer_name = r.buyer_name AND p.buyer_country = r.buyer_country
    WHERE p.buyer_name IS NULL
    ORDER BY r.awards_count DESC, r.first_award_date DESC
    LIMIT ${limit};
  `);
  return (result.rows as Array<Record<string, unknown>>).map((r) => ({
    buyerName: String(r.buyer_name),
    buyerCountry: String(r.buyer_country),
    awardsCount: Number(r.awards_count),
    firstAwardDate:
      r.first_award_date instanceof Date
        ? r.first_award_date.toISOString().slice(0, 10)
        : String(r.first_award_date),
  }));
}

export interface ToolCallStat {
  toolName: string;
  totalCalls: number;
  zeroResultCalls: number;
  errorCalls: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
}

/**
 * Adoption + coverage-gap analytics for the assistant tool surface.
 * Uses tool_call_logs (added in 0034). companyId-scoped.
 */
export async function getToolCallStats(
  companyId: string,
  daysLookback = 30,
): Promise<ToolCallStat[]> {
  const result = await db.execute(sql`
    SELECT
      tool_name,
      COUNT(*)::int                                              AS total_calls,
      SUM(CASE WHEN result_count = 0 THEN 1 ELSE 0 END)::int     AS zero_result_calls,
      SUM(CASE WHEN success = false THEN 1 ELSE 0 END)::int      AS error_calls,
      AVG(latency_ms)::int                                       AS avg_latency_ms,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)::int AS p95_latency_ms
    FROM tool_call_logs
    WHERE company_id = ${companyId}
      AND created_at >= NOW() - (${daysLookback}::int || ' days')::interval
    GROUP BY tool_name
    ORDER BY COUNT(*) DESC;
  `);
  return (result.rows as Array<Record<string, unknown>>).map((r) => ({
    toolName: String(r.tool_name),
    totalCalls: Number(r.total_calls),
    zeroResultCalls: Number(r.zero_result_calls ?? 0),
    errorCalls: Number(r.error_calls ?? 0),
    avgLatencyMs: Number(r.avg_latency_ms ?? 0),
    p95LatencyMs: Number(r.p95_latency_ms ?? 0),
  }));
}

// ─── Customs flows (Eurostat Comext + future sources) ───────────

export interface CustomsFlowFilters {
  /** ISO-2 country of origin. e.g. 'LY' for Libya. */
  partnerCountry: string;
  /** HS code (2/4/6/8 digits). e.g. '2709' for crude petroleum. */
  productCode: string;
  /** Default 12 months. */
  monthsLookback?: number;
  /** Filter to a single reporter country (omit for all importers). */
  reporterCountry?: string;
}

export interface TopImporterRow {
  reporterCountry: string;
  totalQuantityKg: number | null;
  totalValueUsd: number | null;
  totalValueEur: number | null;
  monthsActive: number;
  mostRecentPeriod: string;
}

/**
 * Country-level leaderboard: which countries imported the most of
 * `productCode` from `partnerCountry` over the lookback window?
 *
 * Sample question this answers: "Which EU countries imported the most
 * crude petroleum from Libya in the last 12 months?"
 *
 * Source filtered to 'eurostat-comext' for v1; once UN Comtrade or
 * other sources are wired in, the query unions across them.
 */
export async function getTopImportersByPartner(
  filters: CustomsFlowFilters,
  limit = 25,
): Promise<TopImporterRow[]> {
  const monthsLookback = filters.monthsLookback ?? 12;
  // Dedup across sources: same reporter+period appearing in both
  // Eurostat AND UN Comtrade would double-count under a naive SUM.
  // Use ROW_NUMBER over (reporter, period) with priority: EU
  // reporters → prefer Eurostat (more granular, less lagged); non-EU
  // → prefer UN Comtrade. Aggregation runs over rank=1 only.
  const result = await db.execute(sql`
    WITH ranked AS (
      SELECT
        reporter_country,
        period,
        quantity_kg,
        value_usd,
        value_native,
        value_currency,
        source,
        ROW_NUMBER() OVER (
          PARTITION BY reporter_country, period
          ORDER BY
            CASE
              WHEN reporter_country IN ('AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE')
                AND source = 'eurostat-comext' THEN 1
              WHEN source = 'un-comtrade' THEN 2
              ELSE 3
            END
        ) AS rn
      FROM customs_imports
      WHERE
        partner_country = ${filters.partnerCountry}
        AND product_code = ${filters.productCode}
        AND flow_direction = 'import'
        AND period >= (NOW() - (${monthsLookback}::int || ' months')::interval)::date
        ${filters.reporterCountry ? sql`AND reporter_country = ${filters.reporterCountry}` : sql``}
    )
    SELECT
      reporter_country,
      SUM(quantity_kg)            AS total_quantity_kg,
      SUM(value_usd)              AS total_value_usd,
      SUM(CASE WHEN value_currency = 'EUR' THEN value_native END) AS total_value_eur,
      COUNT(DISTINCT period)::int AS months_active,
      MAX(period)                 AS most_recent_period
    FROM ranked
    WHERE rn = 1
    GROUP BY reporter_country
    ORDER BY SUM(value_usd) DESC NULLS LAST, SUM(quantity_kg) DESC NULLS LAST
    LIMIT ${limit};
  `);
  return (result.rows as Array<Record<string, unknown>>).map((r) => ({
    reporterCountry: String(r.reporter_country),
    totalQuantityKg:
      r.total_quantity_kg != null
        ? Number.parseFloat(String(r.total_quantity_kg))
        : null,
    totalValueUsd:
      r.total_value_usd != null ? Number.parseFloat(String(r.total_value_usd)) : null,
    totalValueEur:
      r.total_value_eur != null ? Number.parseFloat(String(r.total_value_eur)) : null,
    monthsActive: Number(r.months_active ?? 0),
    mostRecentPeriod:
      r.most_recent_period instanceof Date
        ? r.most_recent_period.toISOString().slice(0, 7)
        : String(r.most_recent_period).slice(0, 7),
  }));
}

export interface MonthlyFlowBucket {
  period: string; // YYYY-MM
  quantityKg: number | null;
  valueUsd: number | null;
  valueEur: number | null;
}

/**
 * Time series: monthly flow of `productCode` from `partnerCountry`
 * (optionally filtered to a single reporter). Empty months render as
 * zero so a sparkline / bar chart has a consistent baseline.
 */
export async function getMonthlyImportFlow(
  filters: CustomsFlowFilters,
): Promise<MonthlyFlowBucket[]> {
  const monthsLookback = filters.monthsLookback ?? 12;
  const result = await db.execute(sql`
    WITH series AS (
      SELECT generate_series(
        date_trunc('month', NOW() - (${monthsLookback}::int || ' months')::interval),
        date_trunc('month', NOW()),
        '1 month'::interval
      )::date AS period
    ),
    ranked AS (
      SELECT
        period,
        reporter_country,
        quantity_kg,
        value_usd,
        value_native,
        value_currency,
        source,
        ROW_NUMBER() OVER (
          PARTITION BY reporter_country, period
          ORDER BY
            CASE
              WHEN reporter_country IN ('AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE')
                AND source = 'eurostat-comext' THEN 1
              WHEN source = 'un-comtrade' THEN 2
              ELSE 3
            END
        ) AS rn
      FROM customs_imports
      WHERE
        partner_country = ${filters.partnerCountry}
        AND product_code = ${filters.productCode}
        AND flow_direction = 'import'
        ${filters.reporterCountry ? sql`AND reporter_country = ${filters.reporterCountry}` : sql``}
    ),
    buckets AS (
      SELECT
        period,
        SUM(quantity_kg)                                           AS quantity_kg,
        SUM(value_usd)                                             AS value_usd,
        SUM(CASE WHEN value_currency = 'EUR' THEN value_native END) AS value_eur
      FROM ranked
      WHERE rn = 1
        AND period IS NOT NULL
      GROUP BY period
    )
    SELECT
      to_char(s.period, 'YYYY-MM') AS period,
      b.quantity_kg,
      b.value_usd,
      b.value_eur
    FROM series s
    LEFT JOIN buckets b ON b.period = s.period
    ORDER BY s.period ASC;
  `);
  return (result.rows as Array<Record<string, unknown>>).map((r) => ({
    period: String(r.period),
    quantityKg: r.quantity_kg != null ? Number.parseFloat(String(r.quantity_kg)) : null,
    valueUsd: r.value_usd != null ? Number.parseFloat(String(r.value_usd)) : null,
    valueEur: r.value_eur != null ? Number.parseFloat(String(r.value_eur)) : null,
  }));
}

// ─── Supplier-side pivot of customs flows ─────────────────────────

export interface SourcesForReporterFilters {
  /** ISO-2 country buying / importing. e.g. 'IT' for Italy. */
  reporterCountry: string;
  /** HS code (2/4/6/8 digits). e.g. '2709' for crude petroleum. */
  productCode: string;
  /** Default 12 months. */
  monthsLookback?: number;
  /** Filter to a single source country (omit for all). */
  partnerCountry?: string;
}

export interface TopSourceRow {
  partnerCountry: string;
  totalQuantityKg: number | null;
  totalValueUsd: number | null;
  monthsActive: number;
  mostRecentPeriod: string;
}

/**
 * Supplier-side pivot of the customs-flows data: which countries does
 * reporter X import `productCode` FROM?
 *
 * Inverse framing of getTopImportersByPartner. Same underlying table,
 * different result perspective. Use when sourcing supply for a tender
 * response: "Italy's diesel tender — which countries currently supply
 * Italy with diesel?"
 *
 * Same source-priority dedup as the import-side query (Eurostat for
 * EU reporters, UN Comtrade for the rest).
 */
export async function getTopSourcesForReporter(
  filters: SourcesForReporterFilters,
  limit = 25,
): Promise<TopSourceRow[]> {
  const monthsLookback = filters.monthsLookback ?? 12;
  const result = await db.execute(sql`
    WITH ranked AS (
      SELECT
        partner_country,
        period,
        quantity_kg,
        value_usd,
        source,
        ROW_NUMBER() OVER (
          PARTITION BY partner_country, period
          ORDER BY
            CASE
              WHEN ${filters.reporterCountry} IN ('AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE')
                AND source = 'eurostat-comext' THEN 1
              WHEN source = 'un-comtrade' THEN 2
              ELSE 3
            END
        ) AS rn
      FROM customs_imports
      WHERE
        reporter_country = ${filters.reporterCountry}
        AND product_code = ${filters.productCode}
        AND flow_direction = 'import'
        AND period >= (NOW() - (${monthsLookback}::int || ' months')::interval)::date
        ${filters.partnerCountry ? sql`AND partner_country = ${filters.partnerCountry}` : sql``}
    )
    SELECT
      partner_country,
      SUM(quantity_kg)            AS total_quantity_kg,
      SUM(value_usd)              AS total_value_usd,
      COUNT(DISTINCT period)::int AS months_active,
      MAX(period)                 AS most_recent_period
    FROM ranked
    WHERE rn = 1
    GROUP BY partner_country
    ORDER BY SUM(value_usd) DESC NULLS LAST, SUM(quantity_kg) DESC NULLS LAST
    LIMIT ${limit};
  `);
  return (result.rows as Array<Record<string, unknown>>).map((r) => ({
    partnerCountry: String(r.partner_country),
    totalQuantityKg:
      r.total_quantity_kg != null
        ? Number.parseFloat(String(r.total_quantity_kg))
        : null,
    totalValueUsd:
      r.total_value_usd != null ? Number.parseFloat(String(r.total_value_usd)) : null,
    monthsActive: Number(r.months_active ?? 0),
    mostRecentPeriod:
      r.most_recent_period instanceof Date
        ? r.most_recent_period.toISOString().slice(0, 7)
        : String(r.most_recent_period).slice(0, 7),
  }));
}

// ─── Known entities (analyst-curated rolodex) ───────────────────

export interface KnownEntityFilters {
  /** Filter to entities whose categories[] array contains this value. */
  categoryTag?: string;
  /** ISO-2 country filter. */
  country?: string;
  /** Free-text role filter ('refiner' | 'trader' | 'producer' | 'state-buyer'). */
  role?: string;
  /** Free-text tag filter — exact match against any element of tags[]. */
  tag?: string;
  /** Default 100, hard cap 500 to keep the page render bounded. */
  limit?: number;
}

export interface KnownEntityRow {
  id: string;
  slug: string;
  name: string;
  country: string;
  role: string;
  categories: string[];
  notes: string | null;
  contactEntity: string | null;
  aliases: string[];
  tags: string[];
  metadata: Record<string, unknown> | null;
  latitude: number | null;
  longitude: number | null;
}

/**
 * Query the analyst-curated known_entities rolodex. Distinct from the
 * supplier-graph queries (those operate on awards). Use when the user
 * wants candidate buyers/sellers that may not have public-tender
 * activity — most Mediterranean refiners and major trading houses fall
 * in this bucket.
 */
export async function lookupKnownEntities(
  filters: KnownEntityFilters,
): Promise<KnownEntityRow[]> {
  const limit = Math.min(filters.limit ?? 100, 5000);
  const result = await db.execute(sql`
    SELECT
      id, slug, name, country, role, categories, notes,
      contact_entity, aliases, tags, metadata, latitude, longitude
    FROM known_entities
    WHERE 1=1
      ${
        filters.categoryTag
          ? sql`AND ${filters.categoryTag} = ANY(categories)`
          : sql``
      }
      ${filters.country ? sql`AND country = ${filters.country}` : sql``}
      ${filters.role ? sql`AND role = ${filters.role}` : sql``}
      ${filters.tag ? sql`AND ${filters.tag} = ANY(tags)` : sql``}
    ORDER BY country ASC, name ASC
    LIMIT ${limit};
  `);
  return (result.rows as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    slug: String(r.slug),
    name: String(r.name),
    country: String(r.country),
    role: String(r.role),
    categories: (r.categories as string[] | null) ?? [],
    notes: r.notes == null ? null : String(r.notes),
    contactEntity: r.contact_entity == null ? null : String(r.contact_entity),
    aliases: (r.aliases as string[] | null) ?? [],
    tags: (r.tags as string[] | null) ?? [],
    metadata: r.metadata as Record<string, unknown> | null,
    latitude: r.latitude != null ? Number.parseFloat(String(r.latitude)) : null,
    longitude: r.longitude != null ? Number.parseFloat(String(r.longitude)) : null,
  }));
}

// ─── Pricing analytics — delta-vs-benchmark ───────────────────────

export interface SupplierPricingProfile {
  supplierId: string;
  awardCount: number;
  /** Average per-bbl delta (positive = priced above benchmark). */
  avgDeltaUsdPerBbl: number | null;
  avgDeltaPct: number | null;
  /** Median per-bbl delta — robust to outliers. */
  medianDeltaUsdPerBbl: number | null;
  /** Standard deviation of per-bbl delta. High = inconsistent pricing. */
  stddevDeltaUsdPerBbl: number | null;
  /** Most-recent award sample for narrative context. */
  recentSamples: Array<{
    awardId: string;
    awardDate: string;
    buyerCountry: string;
    categoryTags: string[];
    unitPriceUsdPerBbl: number;
    benchmarkPriceUsdPerBbl: number;
    deltaUsdPerBbl: number;
    deltaPct: number;
    confidence: number;
  }>;
}

/**
 * Per-supplier pricing profile vs. their relevant benchmarks. Filters
 * to confidence ≥ 0.6 by default — anything lower is too noisy to
 * trust. Used by analyze_supplier_pricing chat tool.
 */
export async function analyzeSupplierPricing(filters: {
  supplierId: string;
  /** Minimum overall_confidence. Default 0.6. */
  minConfidence?: number;
  /** Lookback window in days. Default 1095 (~3y). */
  daysBack?: number;
}): Promise<SupplierPricingProfile> {
  const minConfidence = filters.minConfidence ?? 0.6;
  const daysBack = filters.daysBack ?? 1095;
  const result = await db.execute(sql`
    WITH window_rows AS (
      SELECT *
      FROM award_price_deltas
      WHERE supplier_id = ${filters.supplierId}::uuid
        AND overall_confidence >= ${minConfidence}::numeric
        AND award_date >= CURRENT_DATE - (${daysBack}::int * INTERVAL '1 day')
        AND delta_usd_per_bbl IS NOT NULL
    )
    SELECT
      (SELECT COUNT(*) FROM window_rows)::int AS award_count,
      (SELECT AVG(delta_usd_per_bbl) FROM window_rows) AS avg_delta_usd,
      (SELECT AVG(delta_pct) FROM window_rows) AS avg_delta_pct,
      (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY delta_usd_per_bbl)
         FROM window_rows) AS median_delta_usd,
      (SELECT STDDEV(delta_usd_per_bbl) FROM window_rows) AS stddev_delta_usd,
      (SELECT json_agg(row_to_json(s) ORDER BY s.award_date DESC)
         FROM (
           SELECT award_id, award_date, buyer_country, category_tags,
                  unit_price_usd_per_bbl, benchmark_price_usd_per_bbl,
                  delta_usd_per_bbl, delta_pct, overall_confidence
           FROM window_rows
           ORDER BY award_date DESC LIMIT 5
         ) s) AS recent_samples;
  `);
  const row = (result.rows as Array<Record<string, unknown>>)[0] ?? {};
  type Sample = {
    award_id: string;
    award_date: string;
    buyer_country: string;
    category_tags: string[] | null;
    unit_price_usd_per_bbl: number | string;
    benchmark_price_usd_per_bbl: number | string;
    delta_usd_per_bbl: number | string;
    delta_pct: number | string;
    overall_confidence: number | string;
  };
  const samples = (row.recent_samples as Sample[] | null) ?? [];
  return {
    supplierId: filters.supplierId,
    awardCount: Number(row.award_count ?? 0),
    avgDeltaUsdPerBbl:
      row.avg_delta_usd != null ? Number.parseFloat(String(row.avg_delta_usd)) : null,
    avgDeltaPct:
      row.avg_delta_pct != null ? Number.parseFloat(String(row.avg_delta_pct)) : null,
    medianDeltaUsdPerBbl:
      row.median_delta_usd != null
        ? Number.parseFloat(String(row.median_delta_usd))
        : null,
    stddevDeltaUsdPerBbl:
      row.stddev_delta_usd != null
        ? Number.parseFloat(String(row.stddev_delta_usd))
        : null,
    recentSamples: samples.map((s) => ({
      awardId: String(s.award_id),
      awardDate: String(s.award_date).slice(0, 10),
      buyerCountry: String(s.buyer_country),
      categoryTags: s.category_tags ?? [],
      unitPriceUsdPerBbl: Number.parseFloat(String(s.unit_price_usd_per_bbl)),
      benchmarkPriceUsdPerBbl: Number.parseFloat(
        String(s.benchmark_price_usd_per_bbl),
      ),
      deltaUsdPerBbl: Number.parseFloat(String(s.delta_usd_per_bbl)),
      deltaPct: Number.parseFloat(String(s.delta_pct)),
      confidence: Number.parseFloat(String(s.overall_confidence)),
    })),
  };
}

export interface BuyerPricingProfile {
  country: string;
  category: string;
  awardCount: number;
  /** Distribution of per-bbl deltas paid by this buyer pool. */
  avgDeltaUsdPerBbl: number | null;
  medianDeltaUsdPerBbl: number | null;
  /** P25 / P75 — empirical pricing band. */
  p25DeltaUsdPerBbl: number | null;
  p75DeltaUsdPerBbl: number | null;
  /** Typical premium paid above benchmark, expressed as % of benchmark. */
  avgDeltaPct: number | null;
}

/**
 * Per-(buyer_country × category) pricing profile. The empirical
 * "Caribbean diesel premium over NY Harbor" answer.
 */
export async function analyzeBuyerPricing(filters: {
  buyerCountry: string;
  categoryTag: string;
  minConfidence?: number;
  daysBack?: number;
}): Promise<BuyerPricingProfile> {
  const minConfidence = filters.minConfidence ?? 0.6;
  const daysBack = filters.daysBack ?? 1095;
  const result = await db.execute(sql`
    WITH window_rows AS (
      SELECT *
      FROM award_price_deltas
      WHERE buyer_country = ${filters.buyerCountry}
        AND ${filters.categoryTag} = ANY(category_tags)
        AND overall_confidence >= ${minConfidence}::numeric
        AND award_date >= CURRENT_DATE - (${daysBack}::int * INTERVAL '1 day')
        AND delta_usd_per_bbl IS NOT NULL
    )
    SELECT
      COUNT(*)::int AS award_count,
      AVG(delta_usd_per_bbl) AS avg_delta_usd,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY delta_usd_per_bbl) AS median_delta_usd,
      percentile_cont(0.25) WITHIN GROUP (ORDER BY delta_usd_per_bbl) AS p25_delta_usd,
      percentile_cont(0.75) WITHIN GROUP (ORDER BY delta_usd_per_bbl) AS p75_delta_usd,
      AVG(delta_pct) AS avg_delta_pct
    FROM window_rows;
  `);
  const row = (result.rows as Array<Record<string, unknown>>)[0] ?? {};
  return {
    country: filters.buyerCountry,
    category: filters.categoryTag,
    awardCount: Number(row.award_count ?? 0),
    avgDeltaUsdPerBbl:
      row.avg_delta_usd != null ? Number.parseFloat(String(row.avg_delta_usd)) : null,
    medianDeltaUsdPerBbl:
      row.median_delta_usd != null
        ? Number.parseFloat(String(row.median_delta_usd))
        : null,
    p25DeltaUsdPerBbl:
      row.p25_delta_usd != null ? Number.parseFloat(String(row.p25_delta_usd)) : null,
    p75DeltaUsdPerBbl:
      row.p75_delta_usd != null ? Number.parseFloat(String(row.p75_delta_usd)) : null,
    avgDeltaPct:
      row.avg_delta_pct != null ? Number.parseFloat(String(row.avg_delta_pct)) : null,
  };
}

export interface OfferEvaluation {
  buyerCountry: string;
  categoryTag: string;
  offerPriceUsdPerBbl: number;
  /** Matching benchmark slug + current spot. NULL if not yet ingested. */
  benchmarkSlug: string | null;
  benchmarkSpotUsdPerBbl: number | null;
  /** Expected delta from the buyer-pool's empirical distribution. */
  expectedDeltaUsdPerBbl: number | null;
  /** Implied price the buyer's history would predict. */
  expectedPriceUsdPerBbl: number | null;
  /** How many standard deviations off from the historical mean. */
  zScore: number | null;
  /** Above / below / inside band, p25–p75 the historical spread. */
  verdict: 'inside-band' | 'above-band' | 'below-band' | 'no-history' | 'no-benchmark';
  historyAwardCount: number;
}

/**
 * "Is this offer competitive?" — given a buyer + category + offer
 * price, score it against the empirical distribution of deltas. Uses
 * the analyzeBuyerPricing distribution and current benchmark spot.
 */
export async function evaluateOfferAgainstHistory(input: {
  buyerCountry: string;
  categoryTag: string;
  offerPriceUsdPerBbl: number;
  minConfidence?: number;
  daysBack?: number;
}): Promise<OfferEvaluation> {
  const buyerProfile = await analyzeBuyerPricing(input);

  // Resolve current benchmark spot (most recent commodity_prices row).
  const benchResult = await db.execute(sql`
    SELECT
      cbm.benchmark_slug,
      cp.price::numeric AS price,
      cp.unit AS unit,
      COALESCE(cbm.benchmark_adjustment_usd_bbl, 0)::numeric AS adj
    FROM commodity_benchmark_mappings cbm
    LEFT JOIN LATERAL (
      SELECT price, unit FROM commodity_prices
      WHERE series_slug = cbm.benchmark_slug AND contract_type = 'spot'
      ORDER BY price_date DESC LIMIT 1
    ) cp ON TRUE
    WHERE cbm.category_tag = ${input.categoryTag}
      AND (cbm.country_code = ${input.buyerCountry} OR cbm.country_code = 'GLOBAL')
      AND cbm.grade IS NULL
    ORDER BY (cbm.country_code = ${input.buyerCountry}) DESC
    LIMIT 1;
  `);
  const benchRow = (benchResult.rows as Array<Record<string, unknown>>)[0];
  const benchmarkSlug = benchRow?.benchmark_slug == null ? null : String(benchRow.benchmark_slug);
  const rawPrice = benchRow?.price != null ? Number.parseFloat(String(benchRow.price)) : null;
  const unit = benchRow?.unit == null ? null : String(benchRow.unit);
  const adj = benchRow?.adj != null ? Number.parseFloat(String(benchRow.adj)) : 0;
  const benchmarkSpotUsdPerBbl =
    rawPrice == null || unit == null
      ? null
      : (unit === 'usd-gal' ? rawPrice * 42 : rawPrice) + adj;

  if (benchmarkSpotUsdPerBbl == null) {
    return {
      buyerCountry: input.buyerCountry,
      categoryTag: input.categoryTag,
      offerPriceUsdPerBbl: input.offerPriceUsdPerBbl,
      benchmarkSlug,
      benchmarkSpotUsdPerBbl: null,
      expectedDeltaUsdPerBbl: null,
      expectedPriceUsdPerBbl: null,
      zScore: null,
      verdict: 'no-benchmark',
      historyAwardCount: buyerProfile.awardCount,
    };
  }

  if (buyerProfile.awardCount === 0 || buyerProfile.medianDeltaUsdPerBbl == null) {
    return {
      buyerCountry: input.buyerCountry,
      categoryTag: input.categoryTag,
      offerPriceUsdPerBbl: input.offerPriceUsdPerBbl,
      benchmarkSlug,
      benchmarkSpotUsdPerBbl,
      expectedDeltaUsdPerBbl: null,
      expectedPriceUsdPerBbl: null,
      zScore: null,
      verdict: 'no-history',
      historyAwardCount: buyerProfile.awardCount,
    };
  }

  const expectedDelta = buyerProfile.medianDeltaUsdPerBbl;
  const expectedPrice = benchmarkSpotUsdPerBbl + expectedDelta;
  const offerDelta = input.offerPriceUsdPerBbl - benchmarkSpotUsdPerBbl;

  // Z-score using the buyer's historical mean + p25/p75 (proxy for std).
  const p25 = buyerProfile.p25DeltaUsdPerBbl;
  const p75 = buyerProfile.p75DeltaUsdPerBbl;
  const iqrSigma =
    p25 != null && p75 != null ? (p75 - p25) / 1.349 : null; // IQR → σ approx
  const z =
    iqrSigma != null && iqrSigma > 0
      ? (offerDelta - expectedDelta) / iqrSigma
      : null;

  let verdict: OfferEvaluation['verdict'] = 'inside-band';
  if (p25 != null && p75 != null) {
    if (offerDelta < p25) verdict = 'below-band';
    else if (offerDelta > p75) verdict = 'above-band';
  }

  return {
    buyerCountry: input.buyerCountry,
    categoryTag: input.categoryTag,
    offerPriceUsdPerBbl: input.offerPriceUsdPerBbl,
    benchmarkSlug,
    benchmarkSpotUsdPerBbl,
    expectedDeltaUsdPerBbl: expectedDelta,
    expectedPriceUsdPerBbl: expectedPrice,
    zScore: z,
    verdict,
    historyAwardCount: buyerProfile.awardCount,
  };
}

/**
 * Histogram of per-bbl deltas for a (country × category) — bucketed
 * for an SVG histogram on the intelligence dashboard. Empty buckets
 * are excluded; caller fills gaps for the visualization.
 */
export async function getPriceDeltaHistogram(filters: {
  buyerCountry?: string;
  categoryTag?: string;
  minConfidence?: number;
  monthsLookback?: number;
  /** Bucket size in $/bbl. Default 5. */
  bucketUsd?: number;
  /** Trim outliers beyond ±$max. Default 80. */
  maxAbsUsd?: number;
}): Promise<Array<{ bucketStart: number; bucketEnd: number; awardsCount: number }>> {
  const minConfidence = filters.minConfidence ?? 0.6;
  const monthsLookback = filters.monthsLookback ?? 12;
  const bucket = filters.bucketUsd ?? 5;
  const maxAbs = filters.maxAbsUsd ?? 80;

  const result = await db.execute(sql`
    WITH window_rows AS (
      SELECT delta_usd_per_bbl
      FROM award_price_deltas
      WHERE overall_confidence >= ${minConfidence}::numeric
        AND award_date >= NOW() - (${monthsLookback}::int || ' months')::interval
        AND delta_usd_per_bbl IS NOT NULL
        AND delta_usd_per_bbl >= ${-maxAbs}::numeric
        AND delta_usd_per_bbl <= ${maxAbs}::numeric
        ${filters.buyerCountry ? sql`AND buyer_country = ${filters.buyerCountry}` : sql``}
        ${filters.categoryTag ? sql`AND ${filters.categoryTag} = ANY(category_tags)` : sql``}
    ),
    bucketed AS (
      SELECT
        FLOOR(delta_usd_per_bbl / ${bucket}::numeric)::int * ${bucket}::int AS bucket_start,
        COUNT(*)::int AS awards_count
      FROM window_rows
      GROUP BY 1
    )
    SELECT bucket_start, awards_count FROM bucketed ORDER BY bucket_start ASC;
  `);
  return (result.rows as Array<Record<string, unknown>>).map((r) => {
    const start = Number(r.bucket_start);
    return {
      bucketStart: start,
      bucketEnd: start + bucket,
      awardsCount: Number(r.awards_count),
    };
  });
}

/**
 * Monthly avg + median delta vs benchmark — input for line chart.
 */
export async function getMonthlyAvgDelta(filters: {
  buyerCountry?: string;
  categoryTag?: string;
  minConfidence?: number;
  monthsLookback?: number;
}): Promise<
  Array<{
    month: string;
    avgDeltaUsdPerBbl: number | null;
    medianDeltaUsdPerBbl: number | null;
    awardsCount: number;
  }>
> {
  const minConfidence = filters.minConfidence ?? 0.6;
  const monthsLookback = filters.monthsLookback ?? 12;
  const result = await db.execute(sql`
    WITH series AS (
      SELECT generate_series(
        date_trunc('month', NOW() - (${monthsLookback}::int || ' months')::interval),
        date_trunc('month', NOW()),
        '1 month'::interval
      ) AS month
    ),
    buckets AS (
      SELECT
        date_trunc('month', award_date)::date AS month,
        AVG(delta_usd_per_bbl) AS avg_delta,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY delta_usd_per_bbl) AS median_delta,
        COUNT(*)::int AS awards_count
      FROM award_price_deltas
      WHERE overall_confidence >= ${minConfidence}::numeric
        AND award_date >= NOW() - (${monthsLookback}::int || ' months')::interval
        AND delta_usd_per_bbl IS NOT NULL
        ${filters.buyerCountry ? sql`AND buyer_country = ${filters.buyerCountry}` : sql``}
        ${filters.categoryTag ? sql`AND ${filters.categoryTag} = ANY(category_tags)` : sql``}
      GROUP BY 1
    )
    SELECT
      to_char(s.month, 'YYYY-MM') AS month,
      b.avg_delta,
      b.median_delta,
      COALESCE(b.awards_count, 0) AS awards_count
    FROM series s
    LEFT JOIN buckets b ON b.month = s.month
    ORDER BY s.month ASC;
  `);
  return (result.rows as Array<Record<string, unknown>>).map((r) => ({
    month: String(r.month),
    avgDeltaUsdPerBbl:
      r.avg_delta != null ? Number.parseFloat(String(r.avg_delta)) : null,
    medianDeltaUsdPerBbl:
      r.median_delta != null ? Number.parseFloat(String(r.median_delta)) : null,
    awardsCount: Number(r.awards_count ?? 0),
  }));
}

/**
 * Lightweight ticker — most-recent spot price for a list of series
 * + 30-day pct change. Used for the price strip on dashboards.
 */
export async function getCommodityTicker(
  seriesSlugs: string[],
): Promise<
  Array<{
    seriesSlug: string;
    latestPrice: number | null;
    latestDate: string | null;
    unit: string | null;
    pctChange30d: number | null;
  }>
> {
  if (seriesSlugs.length === 0) return [];
  const result = await db.execute(sql`
    WITH latest AS (
      SELECT DISTINCT ON (series_slug)
        series_slug, price::numeric AS price, unit, price_date
      FROM commodity_prices
      WHERE series_slug = ANY(${seriesSlugs}::text[])
        AND contract_type = 'spot'
      ORDER BY series_slug, price_date DESC
    ),
    earlier AS (
      SELECT DISTINCT ON (series_slug)
        series_slug, price::numeric AS price
      FROM commodity_prices
      WHERE series_slug = ANY(${seriesSlugs}::text[])
        AND contract_type = 'spot'
        AND price_date <= NOW() - INTERVAL '30 days'
      ORDER BY series_slug, price_date DESC
    )
    SELECT
      l.series_slug, l.price AS latest_price, l.unit, l.price_date AS latest_date,
      e.price AS earlier_price
    FROM latest l
    LEFT JOIN earlier e ON e.series_slug = l.series_slug;
  `);
  return (result.rows as Array<Record<string, unknown>>).map((r) => {
    const latest =
      r.latest_price != null ? Number.parseFloat(String(r.latest_price)) : null;
    const earlier =
      r.earlier_price != null ? Number.parseFloat(String(r.earlier_price)) : null;
    return {
      seriesSlug: String(r.series_slug),
      latestPrice: latest,
      latestDate: r.latest_date == null ? null : String(r.latest_date).slice(0, 10),
      unit: r.unit == null ? null : String(r.unit),
      pctChange30d:
        latest != null && earlier != null && earlier !== 0
          ? ((latest - earlier) / earlier) * 100
          : null,
    };
  });
}

/**
 * Buyer-side + supplier-side concentration for the selected
 * (category × country × window). Returns Herfindahl-Hirschman Index
 * (sum of squared market shares, 0–10,000) for each side plus the
 * top-3 cumulative share so the dashboard can show "the top 3 buyers
 * control 68% of spend" alongside the raw HHI.
 *
 * Reads:
 *   HHI < 1500           — unconcentrated
 *   1500 ≤ HHI < 2500    — moderately concentrated
 *   HHI ≥ 2500           — highly concentrated
 *
 * Buyer share: contract_value_usd grouped by buyer_name.
 * Supplier share: contract_value_usd grouped by award_awardees.supplier_id.
 */
export async function getMarketConcentration(filters: {
  categoryTag?: string;
  buyerCountry?: string;
  monthsLookback?: number;
}): Promise<{
  buyerHhi: number | null;
  supplierHhi: number | null;
  top3BuyerSharePct: number | null;
  top3SupplierSharePct: number | null;
  totalValueUsd: number | null;
  buyerCount: number;
  supplierCount: number;
}> {
  const monthsLookback = filters.monthsLookback ?? 12;
  const result = await db.execute(sql`
    WITH base AS (
      SELECT
        a.id, a.buyer_name, a.contract_value_usd::numeric AS v, aa.supplier_id
      FROM awards a
      LEFT JOIN award_awardees aa ON aa.award_id = a.id
      WHERE a.award_date >= NOW() - (${monthsLookback}::int || ' months')::interval
        AND a.contract_value_usd IS NOT NULL
        AND a.contract_value_usd > 0
        ${
          filters.categoryTag && filters.categoryTag !== 'all'
            ? sql`AND ${filters.categoryTag} = ANY(a.category_tags)`
            : sql``
        }
        ${filters.buyerCountry ? sql`AND a.buyer_country = ${filters.buyerCountry}` : sql``}
    ),
    totals AS (
      SELECT SUM(v) AS total_v FROM base
    ),
    buyer_shares AS (
      SELECT buyer_name,
        SUM(v) / NULLIF((SELECT total_v FROM totals), 0) * 100 AS pct
      FROM base
      GROUP BY buyer_name
    ),
    supplier_shares AS (
      SELECT supplier_id,
        SUM(v) / NULLIF((SELECT total_v FROM totals), 0) * 100 AS pct
      FROM base
      WHERE supplier_id IS NOT NULL
      GROUP BY supplier_id
    ),
    buyer_top3 AS (
      SELECT SUM(pct) AS top3_pct FROM (
        SELECT pct FROM buyer_shares ORDER BY pct DESC LIMIT 3
      ) t
    ),
    supplier_top3 AS (
      SELECT SUM(pct) AS top3_pct FROM (
        SELECT pct FROM supplier_shares ORDER BY pct DESC LIMIT 3
      ) t
    )
    SELECT
      (SELECT total_v FROM totals)                       AS total_v,
      (SELECT SUM(POWER(pct, 2)) FROM buyer_shares)      AS buyer_hhi,
      (SELECT SUM(POWER(pct, 2)) FROM supplier_shares)   AS supplier_hhi,
      (SELECT top3_pct FROM buyer_top3)                  AS buyer_top3,
      (SELECT top3_pct FROM supplier_top3)               AS supplier_top3,
      (SELECT COUNT(*) FROM buyer_shares)::int           AS buyer_count,
      (SELECT COUNT(*) FROM supplier_shares)::int        AS supplier_count;
  `);
  const row = (result.rows as Array<Record<string, unknown>>)[0] ?? {};
  const num = (k: string): number | null =>
    row[k] != null ? Number.parseFloat(String(row[k])) : null;
  return {
    buyerHhi: num('buyer_hhi'),
    supplierHhi: num('supplier_hhi'),
    top3BuyerSharePct: num('buyer_top3'),
    top3SupplierSharePct: num('supplier_top3'),
    totalValueUsd: num('total_v'),
    buyerCount: Number(row.buyer_count ?? 0),
    supplierCount: Number(row.supplier_count ?? 0),
  };
}

/**
 * Time series of the spread between two commodity series. Used by
 * the Intelligence dashboard to plot Brent–WTI (or any pair) over
 * the selected window.
 *
 * Joins on common price_date so the spread is well-defined; days
 * where one series is missing are dropped. Returns most-recent N
 * dates ordered ascending for charting.
 */
export async function getCommoditySpreadHistory(
  baseSlug: string,
  targetSlug: string,
  monthsLookback = 12,
): Promise<
  Array<{
    priceDate: string;
    basePrice: number;
    targetPrice: number;
    spread: number;
  }>
> {
  const result = await db.execute(sql`
    SELECT
      base.price_date,
      base.price::numeric AS base_price,
      target.price::numeric AS target_price,
      (base.price::numeric - target.price::numeric) AS spread
    FROM commodity_prices base
    JOIN commodity_prices target
      ON base.price_date = target.price_date
      AND target.series_slug = ${targetSlug}
      AND target.contract_type = 'spot'
    WHERE base.series_slug = ${baseSlug}
      AND base.contract_type = 'spot'
      AND base.price_date >= NOW() - (${monthsLookback}::int || ' months')::interval
    ORDER BY base.price_date ASC;
  `);
  return (result.rows as Array<Record<string, unknown>>).map((r) => ({
    priceDate: String(r.price_date).slice(0, 10),
    basePrice: Number.parseFloat(String(r.base_price)),
    targetPrice: Number.parseFloat(String(r.target_price)),
    spread: Number.parseFloat(String(r.spread)),
  }));
}

/**
 * Histogram of award contract values (USD) — log-bucketed because
 * award sizes span 4-5 orders of magnitude (small fleet refuels at
 * $5k vs. national tenders at $10M+). Buckets are powers of 10
 * starting at $1k: [1k–10k, 10k–100k, 100k–1M, 1M–10M, 10M+].
 *
 * Replaces the per-bbl price-delta histogram on the intelligence
 * dashboard since most awards lack quantity in the description.
 */
export async function getAwardValueHistogram(filters: {
  buyerCountry?: string;
  categoryTag?: string;
  monthsLookback?: number;
}): Promise<Array<{ bucketLabel: string; bucketLowUsd: number; awardsCount: number }>> {
  const monthsLookback = filters.monthsLookback ?? 12;
  const result = await db.execute(sql`
    WITH window_rows AS (
      SELECT contract_value_usd::numeric AS v
      FROM awards
      WHERE award_date >= NOW() - (${monthsLookback}::int || ' months')::interval
        AND contract_value_usd IS NOT NULL
        AND contract_value_usd > 0
        ${
          filters.categoryTag && filters.categoryTag !== 'all'
            ? sql`AND ${filters.categoryTag} = ANY(category_tags)`
            : sql``
        }
        ${filters.buyerCountry ? sql`AND buyer_country = ${filters.buyerCountry}` : sql``}
    ),
    bucketed AS (
      SELECT
        CASE
          WHEN v < 1000 THEN 0
          WHEN v < 10000 THEN 1
          WHEN v < 100000 THEN 2
          WHEN v < 1000000 THEN 3
          WHEN v < 10000000 THEN 4
          ELSE 5
        END AS bucket_idx,
        COUNT(*)::int AS awards_count
      FROM window_rows
      GROUP BY 1
    )
    SELECT bucket_idx, awards_count FROM bucketed ORDER BY bucket_idx ASC;
  `);
  const labels = ['<$1k', '$1k–10k', '$10k–100k', '$100k–1M', '$1M–10M', '$10M+'];
  const lows = [0, 1000, 10000, 100000, 1_000_000, 10_000_000];
  // Fill in zero-count buckets so the chart x-axis is consistent.
  const counts = new Map<number, number>();
  for (const r of result.rows as Array<Record<string, unknown>>) {
    counts.set(Number(r.bucket_idx), Number(r.awards_count));
  }
  return labels.map((label, i) => ({
    bucketLabel: label,
    bucketLowUsd: lows[i]!,
    awardsCount: counts.get(i) ?? 0,
  }));
}

/**
 * Monthly average + median award value (USD). Replaces the per-bbl
 * delta line chart with a signal that doesn't depend on quantity
 * extraction. Useful for spotting deal-size shifts (concentration
 * into bigger awards = consolidation; smaller spread = retail-style
 * fragmentation).
 */
export async function getMonthlyAvgAwardValue(filters: {
  buyerCountry?: string;
  categoryTag?: string;
  monthsLookback?: number;
}): Promise<
  Array<{
    month: string;
    avgValueUsd: number | null;
    medianValueUsd: number | null;
    awardsCount: number;
  }>
> {
  const monthsLookback = filters.monthsLookback ?? 12;
  const result = await db.execute(sql`
    WITH series AS (
      SELECT generate_series(
        date_trunc('month', NOW() - (${monthsLookback}::int || ' months')::interval),
        date_trunc('month', NOW()),
        '1 month'::interval
      ) AS month
    ),
    buckets AS (
      SELECT
        date_trunc('month', award_date)::date AS month,
        AVG(contract_value_usd) AS avg_v,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY contract_value_usd) AS median_v,
        COUNT(*)::int AS awards_count
      FROM awards
      WHERE award_date >= NOW() - (${monthsLookback}::int || ' months')::interval
        AND contract_value_usd IS NOT NULL
        AND contract_value_usd > 0
        ${
          filters.categoryTag && filters.categoryTag !== 'all'
            ? sql`AND ${filters.categoryTag} = ANY(category_tags)`
            : sql``
        }
        ${filters.buyerCountry ? sql`AND buyer_country = ${filters.buyerCountry}` : sql``}
      GROUP BY 1
    )
    SELECT
      to_char(s.month, 'YYYY-MM') AS month,
      b.avg_v,
      b.median_v,
      COALESCE(b.awards_count, 0) AS awards_count
    FROM series s
    LEFT JOIN buckets b ON b.month = s.month
    ORDER BY s.month ASC;
  `);
  return (result.rows as Array<Record<string, unknown>>).map((r) => ({
    month: String(r.month),
    avgValueUsd: r.avg_v != null ? Number.parseFloat(String(r.avg_v)) : null,
    medianValueUsd: r.median_v != null ? Number.parseFloat(String(r.median_v)) : null,
    awardsCount: Number(r.awards_count ?? 0),
  }));
}

// ─── Vessel intelligence — port-call inference ────────────────────

export interface PortCallRow {
  mmsi: string;
  vesselName: string | null;
  imo: string | null;
  shipTypeLabel: string | null;
  flagCountry: string | null;
  portSlug: string;
  portName: string;
  portCountry: string;
  portType: string;
  /** Earliest position match in the geofence within the lookback window. */
  arrivalAt: string;
  /** Latest position match in the geofence within the lookback window. */
  lastSeenAt: string;
  /** Slowest speed observed during the call — moored vessels read ~0. */
  minSpeedKnots: number | null;
  /** Number of position reports inside the geofence — confidence proxy. */
  positionCount: number;
}

/**
 * Find vessels seen at one or more ports in the last N days. Lazy
 * inference — derived directly from vessel_positions + ports rather
 * than a materialized port_calls table. A "call" is any cluster of
 * positions from the same MMSI inside the port's geofence with
 * min_speed < 2 knots (slow enough to be moored or anchored).
 *
 * Geofence math: equirectangular approximation done in-Postgres for
 * speed. Acceptable error <0.5 nm at typical port latitudes (30°-50°),
 * well inside the 1.5–5 nm radius envelope each port carries.
 *
 * Pair with lookup_known_entities to map a refinery port-call back
 * to the buyer entity.
 */
export async function findRecentPortCalls(filters: {
  portSlug?: string;
  country?: string;
  portType?: 'crude-loading' | 'refinery' | 'transshipment' | 'mixed';
  /** Lookback in days. Default 30. */
  daysBack?: number;
  /** Cap rows. Default 50, max 500. */
  limit?: number;
}): Promise<PortCallRow[]> {
  const daysBack = filters.daysBack ?? 30;
  const limit = Math.min(filters.limit ?? 50, 500);

  const result = await db.execute(sql`
    WITH selected_ports AS (
      SELECT slug, name, country, port_type,
             lat::numeric AS lat, lng::numeric AS lng,
             geofence_radius_nm::numeric AS radius_nm
      FROM ports
      WHERE 1=1
        ${filters.portSlug ? sql`AND slug = ${filters.portSlug}` : sql``}
        ${filters.country ? sql`AND country = ${filters.country}` : sql``}
        ${filters.portType ? sql`AND port_type = ${filters.portType}` : sql``}
    ),
    matches AS (
      SELECT
        p.mmsi,
        sp.slug    AS port_slug,
        sp.name    AS port_name,
        sp.country AS port_country,
        sp.port_type,
        p.timestamp,
        p.speed_knots
      FROM vessel_positions p
      JOIN selected_ports sp
        ON SQRT(
             POW((p.lat::numeric - sp.lat) * 60, 2) +
             POW((p.lng::numeric - sp.lng) * 60 * COS(RADIANS(sp.lat)), 2)
           ) <= sp.radius_nm
      WHERE p.timestamp >= NOW() - (${daysBack}::int * INTERVAL '1 day')
        AND (p.speed_knots IS NULL OR p.speed_knots::numeric < 2)
    ),
    aggregated AS (
      SELECT
        m.mmsi,
        m.port_slug,
        MIN(m.port_name)    AS port_name,
        MIN(m.port_country) AS port_country,
        MIN(m.port_type)    AS port_type,
        MIN(m.timestamp)    AS arrival_at,
        MAX(m.timestamp)    AS last_seen_at,
        MIN(m.speed_knots::numeric) AS min_speed,
        COUNT(*)::int       AS position_count
      FROM matches m
      GROUP BY m.mmsi, m.port_slug
    )
    SELECT
      a.mmsi,
      v.name AS vessel_name,
      v.imo,
      v.ship_type_label,
      v.flag_country,
      a.port_slug, a.port_name, a.port_country, a.port_type,
      a.arrival_at, a.last_seen_at, a.min_speed, a.position_count
    FROM aggregated a
    LEFT JOIN vessels v ON v.mmsi = a.mmsi
    ORDER BY a.last_seen_at DESC
    LIMIT ${limit};
  `);

  return (result.rows as Array<Record<string, unknown>>).map((r) => ({
    mmsi: String(r.mmsi),
    vesselName: r.vessel_name == null ? null : String(r.vessel_name),
    imo: r.imo == null ? null : String(r.imo),
    shipTypeLabel: r.ship_type_label == null ? null : String(r.ship_type_label),
    flagCountry: r.flag_country == null ? null : String(r.flag_country),
    portSlug: String(r.port_slug),
    portName: String(r.port_name),
    portCountry: String(r.port_country),
    portType: String(r.port_type),
    arrivalAt: new Date(r.arrival_at as string).toISOString(),
    lastSeenAt: new Date(r.last_seen_at as string).toISOString(),
    minSpeedKnots:
      r.min_speed == null ? null : Number.parseFloat(String(r.min_speed)),
    positionCount: Number(r.position_count ?? 0),
  }));
}

// ─── Commodity price context ──────────────────────────────────────

export interface CommodityPriceContext {
  seriesSlug: string;
  unit: string;
  latest: { date: string; price: number } | null;
  movingAverage: number | null;
  windowLow: { date: string; price: number } | null;
  windowHigh: { date: string; price: number } | null;
  pctChangeOverWindow: number | null;
  windowDays: number;
  /** True when commodity_prices has zero rows for this series — caller
      should explain the data gap rather than fabricate numbers. */
  noData: boolean;
}

/**
 * Current price + recent context for a commodity series. Used by the
 * get_commodity_price_context chat tool — the assistant can thread
 * "Brent today: $82.40, +2.1% on the week" into any reverse-search
 * or pitch response.
 *
 * Series must already be ingested. See ingest-fred-prices (Brent +
 * WTI) and ingest-eia-prices (refined products).
 */
export async function getCommodityPriceContext(
  seriesSlug: string,
  windowDays = 30,
): Promise<CommodityPriceContext> {
  const result = await db.execute(sql`
    WITH window_rows AS (
      SELECT price_date, price::numeric AS price, unit
      FROM commodity_prices
      WHERE series_slug = ${seriesSlug}
        AND contract_type = 'spot'
        AND price_date >= CURRENT_DATE - ${windowDays}::int
      ORDER BY price_date DESC
    ),
    latest AS (
      SELECT price_date, price, unit FROM commodity_prices
      WHERE series_slug = ${seriesSlug} AND contract_type = 'spot'
      ORDER BY price_date DESC LIMIT 1
    ),
    earliest_in_window AS (
      SELECT price FROM window_rows ORDER BY price_date ASC LIMIT 1
    ),
    high AS (
      SELECT price_date, price FROM window_rows ORDER BY price DESC, price_date DESC LIMIT 1
    ),
    low AS (
      SELECT price_date, price FROM window_rows ORDER BY price ASC, price_date DESC LIMIT 1
    )
    SELECT
      (SELECT price_date FROM latest) AS latest_date,
      (SELECT price      FROM latest) AS latest_price,
      (SELECT unit       FROM latest) AS unit,
      (SELECT AVG(price) FROM window_rows) AS moving_avg,
      (SELECT price FROM earliest_in_window) AS earliest_price,
      (SELECT price_date FROM high) AS high_date,
      (SELECT price      FROM high) AS high_price,
      (SELECT price_date FROM low)  AS low_date,
      (SELECT price      FROM low)  AS low_price;
  `);
  const row = (result.rows as Array<Record<string, unknown>>)[0];
  if (!row || row.latest_price == null) {
    return {
      seriesSlug,
      unit: 'usd-bbl',
      latest: null,
      movingAverage: null,
      windowLow: null,
      windowHigh: null,
      pctChangeOverWindow: null,
      windowDays,
      noData: true,
    };
  }
  const latestPrice = Number.parseFloat(String(row.latest_price));
  const earliestPrice =
    row.earliest_price != null ? Number.parseFloat(String(row.earliest_price)) : null;
  const pctChange =
    earliestPrice != null && earliestPrice !== 0
      ? ((latestPrice - earliestPrice) / earliestPrice) * 100
      : null;
  return {
    seriesSlug,
    unit: row.unit == null ? 'usd-bbl' : String(row.unit),
    latest: { date: String(row.latest_date), price: latestPrice },
    movingAverage:
      row.moving_avg != null ? Number.parseFloat(String(row.moving_avg)) : null,
    windowHigh:
      row.high_price != null
        ? {
            date: String(row.high_date),
            price: Number.parseFloat(String(row.high_price)),
          }
        : null,
    windowLow:
      row.low_price != null
        ? {
            date: String(row.low_date),
            price: Number.parseFloat(String(row.low_price)),
          }
        : null,
    pctChangeOverWindow: pctChange,
    windowDays,
    noData: false,
  };
}

/**
 * Spread between two series, both at their most-recent observation.
 * E.g. Brent–WTI or Brent–Urals. The result's asOfDate is the earlier
 * of the two latest dates so the caller knows the comparison window.
 */
export async function getCommoditySpread(
  baseSlug: string,
  targetSlug: string,
): Promise<{
  baseSlug: string;
  targetSlug: string;
  spread: number | null;
  basePrice: number | null;
  targetPrice: number | null;
  asOfDate: string | null;
}> {
  const result = await db.execute(sql`
    WITH base AS (
      SELECT price_date, price::numeric AS price
      FROM commodity_prices
      WHERE series_slug = ${baseSlug} AND contract_type = 'spot'
      ORDER BY price_date DESC LIMIT 1
    ),
    target AS (
      SELECT price_date, price::numeric AS price
      FROM commodity_prices
      WHERE series_slug = ${targetSlug} AND contract_type = 'spot'
      ORDER BY price_date DESC LIMIT 1
    )
    SELECT
      (SELECT price FROM base)   AS base_price,
      (SELECT price FROM target) AS target_price,
      LEAST(
        (SELECT price_date FROM base),
        (SELECT price_date FROM target)
      ) AS as_of_date;
  `);
  const row = (result.rows as Array<Record<string, unknown>>)[0];
  const basePrice =
    row?.base_price != null ? Number.parseFloat(String(row.base_price)) : null;
  const targetPrice =
    row?.target_price != null ? Number.parseFloat(String(row.target_price)) : null;
  return {
    baseSlug,
    targetSlug,
    basePrice,
    targetPrice,
    spread: basePrice != null && targetPrice != null ? basePrice - targetPrice : null,
    asOfDate: row?.as_of_date == null ? null : String(row.as_of_date),
  };
}

// ─── Crude grades + refinery slate compatibility ──────────────────

export interface CrudeGradeRow {
  slug: string;
  name: string;
  originCountry: string | null;
  region: string | null;
  apiGravity: number | null;
  sulfurPct: number | null;
  tan: number | null;
  characterization: string | null;
  isMarker: boolean;
  loadingCountry: string | null;
  notes: string | null;
}

/**
 * List crude grades from the reference table. Optionally filter by
 * region or origin country. Used to drive grade pickers and also as
 * input to refinery-slate compatibility queries.
 */
export async function listCrudeGrades(filters?: {
  region?: string;
  originCountry?: string;
}): Promise<CrudeGradeRow[]> {
  const result = await db.execute(sql`
    SELECT
      slug, name, origin_country, region, api_gravity, sulfur_pct, tan,
      characterization, is_marker, loading_country, notes
    FROM crude_grades
    WHERE 1=1
      ${filters?.region ? sql`AND region = ${filters.region}` : sql``}
      ${filters?.originCountry ? sql`AND origin_country = ${filters.originCountry}` : sql``}
    ORDER BY is_marker DESC, region, name;
  `);
  return (result.rows as Array<Record<string, unknown>>).map((r) => ({
    slug: String(r.slug),
    name: String(r.name),
    originCountry: r.origin_country == null ? null : String(r.origin_country),
    region: r.region == null ? null : String(r.region),
    apiGravity: r.api_gravity == null ? null : Number.parseFloat(String(r.api_gravity)),
    sulfurPct: r.sulfur_pct == null ? null : Number.parseFloat(String(r.sulfur_pct)),
    tan: r.tan == null ? null : Number.parseFloat(String(r.tan)),
    characterization: r.characterization == null ? null : String(r.characterization),
    isMarker: Boolean(r.is_marker),
    loadingCountry: r.loading_country == null ? null : String(r.loading_country),
    notes: r.notes == null ? null : String(r.notes),
  }));
}

export interface RefineryCompatibilityRow {
  slug: string;
  name: string;
  country: string;
  capacityBpd: number | null;
  operator: string | null;
  notes: string | null;
  matchSource: 'tag' | 'slate-window';
  /** Free-form notes from the refinery's slate metadata (analyst). */
  slateNotes: string | null;
}

/**
 * Find refineries that can run a given crude grade.
 *
 * Two match paths, unioned:
 *   1. Explicit tag — the refinery is tagged `compatible:<grade-slug>`.
 *      Highest confidence; analyst-curated.
 *   2. Slate-window — the grade's API + sulfur fits inside the
 *      refinery's `metadata.slate` window. Lower confidence, but
 *      catches refineries that haven't been individually annotated.
 *
 * Tagged matches always win (matchSource = 'tag') so the chat tool can
 * surface them first.
 */
export async function lookupRefineriesByGrade(
  gradeSlug: string,
  filters?: { country?: string; limit?: number },
): Promise<RefineryCompatibilityRow[]> {
  const limit = Math.min(filters?.limit ?? 50, 500);
  const tag = `compatible:${gradeSlug}`;

  // Pull the grade's API + sulfur for the slate-window fallback.
  const gradeRows = await db.execute(sql`
    SELECT api_gravity, sulfur_pct FROM crude_grades WHERE slug = ${gradeSlug} LIMIT 1;
  `);
  const grade = (gradeRows.rows as Array<Record<string, unknown>>)[0];
  const apiNum = grade?.api_gravity != null ? Number.parseFloat(String(grade.api_gravity)) : null;
  const sulfurNum = grade?.sulfur_pct != null ? Number.parseFloat(String(grade.sulfur_pct)) : null;

  const result = await db.execute(sql`
    WITH tagged AS (
      SELECT slug, name, country, metadata, notes,
             'tag'::text AS match_source
      FROM known_entities
      WHERE role = 'refiner'
        AND ${tag} = ANY(tags)
        ${filters?.country ? sql`AND country = ${filters.country}` : sql``}
    ),
    windowed AS (
      SELECT slug, name, country, metadata, notes,
             'slate-window'::text AS match_source
      FROM known_entities
      WHERE role = 'refiner'
        AND metadata ? 'slate'
        AND NOT (${tag} = ANY(COALESCE(tags, ARRAY[]::text[])))
        ${
          apiNum != null
            ? sql`AND (metadata->'slate'->>'min_api')::numeric <= ${apiNum}
                  AND (metadata->'slate'->>'max_api')::numeric >= ${apiNum}`
            : sql``
        }
        ${
          sulfurNum != null
            ? sql`AND (metadata->'slate'->>'max_sulfur_pct')::numeric >= ${sulfurNum}`
            : sql``
        }
        ${filters?.country ? sql`AND country = ${filters.country}` : sql``}
    )
    SELECT * FROM tagged
    UNION ALL
    SELECT * FROM windowed
    LIMIT ${limit};
  `);

  return (result.rows as Array<Record<string, unknown>>).map((r) => {
    const meta = (r.metadata as Record<string, unknown> | null) ?? {};
    const slate = (meta.slate as Record<string, unknown> | undefined) ?? {};
    return {
      slug: String(r.slug),
      name: String(r.name),
      country: String(r.country),
      capacityBpd: typeof meta.capacity_bpd === 'number' ? meta.capacity_bpd : null,
      operator:
        typeof meta.operator === 'string'
          ? meta.operator
          : Array.isArray(meta.operators) && typeof meta.operators[0] === 'string'
            ? (meta.operators[0] as string)
            : null,
      notes: r.notes == null ? null : String(r.notes),
      matchSource: r.match_source === 'tag' ? 'tag' : 'slate-window',
      slateNotes:
        typeof slate.source_notes === 'string' ? (slate.source_notes as string) : null,
    };
  });
}

// ─── Entity ownership chain ───────────────────────────────────────

export interface OwnershipNode {
  /** GEM entity ID (E1xxxxxxxxxxx) */
  gemId: string;
  name: string;
  /** Share % the parent owns of this entity (in the chain). Null at the root. */
  sharePct: number | null;
  /** True if the share value was imputed by GEM rather than directly published. */
  shareImputed: boolean;
  /** Source URLs (comma-joined verbatim from GEM). */
  sourceUrls: string | null;
}

/**
 * Walk the ownership chain upward from `entityName`. Returns a list
 * starting at the queried entity and ending at its ultimate parent
 * (or the deepest ancestor reached within `maxDepth` hops).
 *
 * Lookup is fuzzy on subject_name (trigram similarity ≥ 0.55) for
 * the initial match — callers don't typically have GEM IDs. Once
 * the chain is rooted, traversal uses GEM IDs (exact joins).
 *
 * Returns empty array if the entity isn't in entity_ownership at all.
 *
 * Use case: given a refinery's operator (e.g., "Eni S.p.A."), surface
 * who ultimately controls that operator (Italian government / public /
 * NOC / etc.). Pair with known_entities.metadata.operator on the
 * profile page to render "Ultimately X% state-owned" labels.
 */
export async function getOwnershipChain(
  entityName: string,
  maxDepth = 5,
): Promise<OwnershipNode[]> {
  const chain: OwnershipNode[] = [];
  const seen = new Set<string>();

  // Initial fuzzy match: find the best subject_name match.
  const seedRows = await runOwnershipQuery(() =>
    db.execute(sql`
      SELECT
        subject_gem_id, subject_name, parent_gem_id, parent_name,
        share_pct, share_imputed, source_urls,
        similarity(subject_name, ${entityName}) AS sim
      FROM entity_ownership
      WHERE subject_name % ${entityName}
      ORDER BY sim DESC, share_pct DESC NULLS LAST
      LIMIT 1;
    `),
  );
  if (!seedRows) return chain;

  const seed = (seedRows.rows as Array<Record<string, unknown>>)[0];
  if (!seed) return chain;

  let currentSubjectId = String(seed.subject_gem_id);
  chain.push({
    gemId: currentSubjectId,
    name: String(seed.subject_name),
    sharePct: null,
    shareImputed: false,
    sourceUrls: null,
  });

  // Walk upward: subject → parent (highest-share parent first).
  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (seen.has(currentSubjectId)) break; // cycle guard
    seen.add(currentSubjectId);

    const upRows = await runOwnershipQuery(() =>
      db.execute(sql`
        SELECT
          parent_gem_id, parent_name, share_pct, share_imputed, source_urls
        FROM entity_ownership
        WHERE subject_gem_id = ${currentSubjectId}
        ORDER BY share_pct DESC NULLS LAST
        LIMIT 1;
      `),
    );
    if (!upRows) break;
    const up = (upRows.rows as Array<Record<string, unknown>>)[0];
    if (!up) break;

    chain.push({
      gemId: String(up.parent_gem_id),
      name: String(up.parent_name),
      sharePct:
        up.share_pct != null ? Number.parseFloat(String(up.share_pct)) : null,
      shareImputed: Boolean(up.share_imputed),
      sourceUrls: up.source_urls == null ? null : String(up.source_urls),
    });
    currentSubjectId = String(up.parent_gem_id);
  }

  return chain;
}

/**
 * Get the FULL ownership of an entity — every parent that owns ANY
 * share of it. Ordered by share descending. Useful for cases like
 * "Eni S.p.A. is 30% Italian govt + 70% public" (multiple parents
 * at the same level).
 */
export async function getDirectOwners(entityName: string): Promise<OwnershipNode[]> {
  const result = await runOwnershipQuery(() =>
    db.execute(sql`
      SELECT
        parent_gem_id, parent_name, share_pct, share_imputed, source_urls,
        similarity(subject_name, ${entityName}) AS sim
      FROM entity_ownership
      WHERE subject_name % ${entityName}
        AND similarity(subject_name, ${entityName}) >= 0.55
      ORDER BY sim DESC, share_pct DESC NULLS LAST
      LIMIT 20;
    `),
  );
  if (!result) return [];
  return (result.rows as Array<Record<string, unknown>>).map((r) => ({
    gemId: String(r.parent_gem_id),
    name: String(r.parent_name),
    sharePct: r.share_pct != null ? Number.parseFloat(String(r.share_pct)) : null,
    shareImputed: Boolean(r.share_imputed),
    sourceUrls: r.source_urls == null ? null : String(r.source_urls),
  }));
}

/**
 * Wrap an entity_ownership query so a missing-table error returns null
 * instead of crashing the caller. Local environments that haven't run
 * `pnpm --filter @procur/db ingest-gem-ownership` yet won't have the
 * table — surface "no ownership data" instead of a 500.
 *
 * Postgres SQLSTATE 42P01 = undefined_table.
 */
async function runOwnershipQuery<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    const code = (err as { code?: string }).code;
    const message = (err as { message?: string }).message ?? '';
    const isMissingTable =
      code === '42P01' || /relation .* does not exist/i.test(message);
    if (isMissingTable) {
      // Log once-ish so it's discoverable but not noisy.
      if (!loggedMissingOwnership) {
        console.warn(
          '[catalog] entity_ownership table not present — ownership lookups will return empty. ' +
            'Run `pnpm --filter @procur/db ingest-gem-ownership <path>` to populate.',
        );
        loggedMissingOwnership = true;
      }
      return null;
    }
    throw err;
  }
}

let loggedMissingOwnership = false;

// ─── Unified entity profile (cross-table lookup) ──────────────────

export interface EntityProfileResult {
  /** Canonical id used in the URL — the known_entities.slug if curated,
   *  the external_suppliers.id if portal-only. */
  canonicalKey: string;
  /** 'known_entity' (curated/Wikidata source) | 'supplier' (portal-scraped). */
  primarySource: 'known_entity' | 'supplier' | 'not_found';
  name: string;
  country: string | null;
  role: string | null;
  categories: string[];
  aliases: string[];
  tags: string[];
  notes: string | null;
  /** From known_entities.metadata + Wikidata enrichment. */
  capabilities: {
    capacityBpd: number | null;
    operator: string | null;
    owner: string | null;
    inceptionYear: number | null;
    status: string | null;
    wikidataId: string | null;
  };
  /** Resolved external_suppliers.id if this entity has portal-scraped
   *  presence. Null when known-entity-only. */
  matchedSupplierId: string | null;
  /** Public-tender history; null if no matchedSupplierId. */
  publicTenderActivity: {
    totalAwards: number;
    totalValueUsd: number | null;
    firstAwardDate: string | null;
    mostRecentAwardDate: string | null;
    awardsByCategory: Record<string, number>;
    topBuyers: Array<{ buyerName: string; awardsCount: number; totalValueUsd: number | null }>;
    recentAwards: Array<{
      awardDate: string;
      buyerName: string;
      buyerCountry: string;
      title: string | null;
      contractValueUsd: number | null;
    }>;
  } | null;
}

/**
 * Unified entity profile resolver.
 *
 * Accepts EITHER a known_entities.slug OR an external_suppliers.id (UUID)
 * and merges available data across both tables plus the supplier-graph
 * (awards). Designed for the /entities/[slug] page and as a profileUrl
 * destination from chat tool responses.
 *
 * Resolution flow:
 *   1. UUID input → look up external_suppliers, then try fuzzy match
 *      to known_entities by name
 *   2. slug input → look up known_entities, then try fuzzy match to
 *      external_suppliers (via supplier_aliases trigram) for portal
 *      presence
 *   3. Pulls awards data via whichever supplier_id was resolved
 */
export async function getEntityProfile(
  slugOrId: string,
): Promise<EntityProfileResult> {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    slugOrId,
  );

  let knownEntity: {
    slug: string;
    name: string;
    country: string;
    role: string;
    categories: string[];
    notes: string | null;
    aliases: string[];
    tags: string[];
    metadata: Record<string, unknown> | null;
  } | null = null;
  let supplierId: string | null = null;
  let supplierName: string | null = null;
  let supplierCountry: string | null = null;

  if (isUuid) {
    // External-supplier path: resolve by id, then look for a curated overlay.
    supplierId = slugOrId;
    const supRows = await db.execute(sql`
      SELECT id, organisation_name, country
      FROM external_suppliers
      WHERE id = ${slugOrId}
      LIMIT 1;
    `);
    const sup = (supRows.rows as Array<Record<string, unknown>>)[0];
    if (sup) {
      supplierName = String(sup.organisation_name);
      supplierCountry = sup.country == null ? null : String(sup.country);
      // Try to find an overlay in known_entities by alias/name match.
      const keRows = await db.execute(sql`
        SELECT slug, name, country, role, categories, notes, aliases, tags, metadata
        FROM known_entities
        WHERE ${supplierName} = ANY(aliases) OR name = ${supplierName}
        LIMIT 1;
      `);
      const ke = (keRows.rows as Array<Record<string, unknown>>)[0];
      if (ke) knownEntity = mapKnownEntityRow(ke);
    }
  } else {
    // Slug path: resolve known_entities first, then look for portal presence.
    const keRows = await db.execute(sql`
      SELECT slug, name, country, role, categories, notes, aliases, tags, metadata
      FROM known_entities
      WHERE slug = ${slugOrId}
      LIMIT 1;
    `);
    const ke = (keRows.rows as Array<Record<string, unknown>>)[0];
    if (ke) {
      knownEntity = mapKnownEntityRow(ke);
      // Best-effort match into external_suppliers via the canonical
      // name and any aliases. Uses ILIKE to tolerate corporate
      // suffix variation.
      const candidates = [knownEntity.name, ...knownEntity.aliases];
      const matchClauses = candidates.map(
        (c) => sql`LOWER(s.organisation_name) LIKE LOWER(${`%${c.split(/\s+/)[0]}%`})`,
      );
      const matchSql = sql.join(matchClauses, sql` OR `);
      const supRows = await db.execute(sql`
        SELECT s.id, s.organisation_name, s.country
        FROM external_suppliers s
        WHERE ${matchSql}
        ORDER BY similarity(s.organisation_name, ${knownEntity.name}) DESC
        LIMIT 1;
      `);
      const sup = (supRows.rows as Array<Record<string, unknown>>)[0];
      if (sup) {
        supplierId = String(sup.id);
        supplierName = String(sup.organisation_name);
        supplierCountry = sup.country == null ? null : String(sup.country);
      }
    }
  }

  if (!knownEntity && !supplierId) {
    return notFoundProfile(slugOrId);
  }

  // Public-tender activity — only if we resolved a supplier_id.
  let publicTenderActivity: EntityProfileResult['publicTenderActivity'] = null;
  if (supplierId) {
    const summary = await db.execute(sql`
      SELECT
        COUNT(*)::int            AS total_awards,
        SUM(a.contract_value_usd) AS total_value_usd,
        MIN(a.award_date)        AS first_award_date,
        MAX(a.award_date)        AS most_recent_award_date
      FROM awards a
      JOIN award_awardees aa ON aa.award_id = a.id
      WHERE aa.supplier_id = ${supplierId};
    `);
    const summaryRow = (summary.rows as Array<Record<string, unknown>>)[0] ?? {};

    const totalAwards = Number(summaryRow.total_awards ?? 0);
    if (totalAwards > 0) {
      const buyersRows = await db.execute(sql`
        SELECT a.buyer_name, COUNT(*)::int AS awards_count,
               SUM(a.contract_value_usd) AS total_value_usd
        FROM awards a
        JOIN award_awardees aa ON aa.award_id = a.id
        WHERE aa.supplier_id = ${supplierId}
        GROUP BY a.buyer_name
        ORDER BY COUNT(*) DESC, SUM(a.contract_value_usd) DESC NULLS LAST
        LIMIT 5;
      `);

      const recentRows = await db.execute(sql`
        SELECT a.award_date, a.buyer_name, a.buyer_country, a.title, a.contract_value_usd
        FROM awards a
        JOIN award_awardees aa ON aa.award_id = a.id
        WHERE aa.supplier_id = ${supplierId}
        ORDER BY a.award_date DESC
        LIMIT 5;
      `);

      const categoryRows = await db.execute(sql`
        SELECT tag, COUNT(*)::int AS cnt
        FROM (
          SELECT unnest(a.category_tags) AS tag
          FROM awards a
          JOIN award_awardees aa ON aa.award_id = a.id
          WHERE aa.supplier_id = ${supplierId}
        ) t
        GROUP BY tag ORDER BY cnt DESC;
      `);

      const awardsByCategory: Record<string, number> = {};
      for (const row of categoryRows.rows as Array<Record<string, unknown>>) {
        awardsByCategory[String(row.tag)] = Number(row.cnt);
      }

      publicTenderActivity = {
        totalAwards,
        totalValueUsd:
          summaryRow.total_value_usd != null
            ? Number.parseFloat(String(summaryRow.total_value_usd))
            : null,
        firstAwardDate: dateOrNull(summaryRow.first_award_date),
        mostRecentAwardDate: dateOrNull(summaryRow.most_recent_award_date),
        awardsByCategory,
        topBuyers: (buyersRows.rows as Array<Record<string, unknown>>).map((r) => ({
          buyerName: String(r.buyer_name),
          awardsCount: Number(r.awards_count),
          totalValueUsd:
            r.total_value_usd != null ? Number.parseFloat(String(r.total_value_usd)) : null,
        })),
        recentAwards: (recentRows.rows as Array<Record<string, unknown>>).map((r) => ({
          awardDate: dateOrNull(r.award_date) ?? '',
          buyerName: String(r.buyer_name),
          buyerCountry: String(r.buyer_country),
          title: r.title == null ? null : String(r.title),
          contractValueUsd:
            r.contract_value_usd != null
              ? Number.parseFloat(String(r.contract_value_usd))
              : null,
        })),
      };
    }
  }

  // Compose the result, preferring known_entity values when present.
  const meta = knownEntity?.metadata ?? {};
  const canonicalKey = knownEntity?.slug ?? supplierId ?? slugOrId;
  const primarySource: EntityProfileResult['primarySource'] = knownEntity
    ? 'known_entity'
    : supplierId
      ? 'supplier'
      : 'not_found';

  return {
    canonicalKey,
    primarySource,
    name: knownEntity?.name ?? supplierName ?? 'UNKNOWN',
    country: knownEntity?.country ?? supplierCountry ?? null,
    role: knownEntity?.role ?? null,
    categories: knownEntity?.categories ?? [],
    aliases: knownEntity?.aliases ?? (supplierName ? [supplierName] : []),
    tags: knownEntity?.tags ?? [],
    notes: knownEntity?.notes ?? null,
    capabilities: {
      capacityBpd: numberOrNull(meta.capacity_bpd),
      operator: stringOrNull(meta.operator),
      owner: stringOrNull(meta.owner),
      inceptionYear: numberOrNull(meta.inception_year),
      status: stringOrNull(meta.status),
      wikidataId: stringOrNull(meta.wikidata_id),
    },
    matchedSupplierId: supplierId,
    publicTenderActivity,
  };
}

function mapKnownEntityRow(r: Record<string, unknown>): {
  slug: string;
  name: string;
  country: string;
  role: string;
  categories: string[];
  notes: string | null;
  aliases: string[];
  tags: string[];
  metadata: Record<string, unknown> | null;
} {
  return {
    slug: String(r.slug),
    name: String(r.name),
    country: String(r.country),
    role: String(r.role),
    categories: (r.categories as string[] | null) ?? [],
    notes: r.notes == null ? null : String(r.notes),
    aliases: (r.aliases as string[] | null) ?? [],
    tags: (r.tags as string[] | null) ?? [],
    metadata: (r.metadata as Record<string, unknown> | null) ?? null,
  };
}

function notFoundProfile(slugOrId: string): EntityProfileResult {
  return {
    canonicalKey: slugOrId,
    primarySource: 'not_found',
    name: 'Not found',
    country: null,
    role: null,
    categories: [],
    aliases: [],
    tags: [],
    notes: null,
    capabilities: {
      capacityBpd: null,
      operator: null,
      owner: null,
      inceptionYear: null,
      status: null,
      wikidataId: null,
    },
    matchedSupplierId: null,
    publicTenderActivity: null,
  };
}

function numberOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function stringOrNull(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

function dateOrNull(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

/**
 * Build the canonical profile URL for an entity. Uses slug for
 * known_entities (stable, human-readable) and UUID for external_suppliers
 * (no slug; UUID is the canonical id).
 */
export function buildEntityProfileUrl(
  options:
    | { kind: 'known_entity'; slug: string }
    | { kind: 'supplier'; id: string },
): string {
  return `/entities/${options.kind === 'known_entity' ? options.slug : options.id}`;
}

// ─── Drill-down queries (for the supplier profile + buyer pages) ──

export interface BuyerAwardRow {
  awardId: string;
  awardDate: string;
  title: string | null;
  commodityDescription: string | null;
  categoryTags: string[];
  contractValueNative: number | null;
  contractCurrency: string | null;
  contractValueUsd: number | null;
  status: string;
  supplierId: string;
  supplierName: string;
  supplierCountry: string | null;
  sourceUrl: string | null;
  sourcePortal: string;
}

export interface BuyerAwardHistoryArgs {
  buyerName: string;
  buyerCountry: string;
  /** Optional category filter — restricts to awards whose category_tags include this value. */
  categoryTag?: string;
  /** Default 10 years back. */
  yearsLookback?: number;
  /** Default 200; uncapped pagination is deferred. */
  limit?: number;
}

/**
 * Drill-down query: full award history for a single buyer.
 *
 * Buyers are identified by (buyerName, buyerCountry) — the same
 * composite the reverse-search aggregations use. Returns one row per
 * (award, supplier) pair so consortium awards show each member.
 *
 * Joins awards → award_awardees → external_suppliers so the response
 * carries supplier_id for linking to the supplier-profile page.
 */
export async function getBuyerAwardHistory(
  args: BuyerAwardHistoryArgs,
): Promise<BuyerAwardRow[]> {
  const yearsLookback = args.yearsLookback ?? 10;
  const limit = args.limit ?? 200;

  const result = await db.execute(sql`
    SELECT
      a.id                    AS award_id,
      a.award_date,
      a.title,
      a.commodity_description,
      a.category_tags,
      a.contract_value_native,
      a.contract_currency,
      a.contract_value_usd,
      a.status,
      a.source_url,
      a.source_portal,
      s.id                    AS supplier_id,
      s.organisation_name     AS supplier_name,
      s.country               AS supplier_country
    FROM awards a
    JOIN award_awardees aa ON aa.award_id = a.id
    JOIN external_suppliers s ON s.id = aa.supplier_id
    WHERE
      a.buyer_name = ${args.buyerName}
      AND a.buyer_country = ${args.buyerCountry}
      AND a.award_date >= NOW() - (${yearsLookback}::int || ' years')::interval
      ${
        args.categoryTag
          ? sql`AND ${args.categoryTag} = ANY(a.category_tags)`
          : sql``
      }
    ORDER BY a.award_date DESC, a.contract_value_usd DESC NULLS LAST
    LIMIT ${limit};
  `);

  return (result.rows as Array<Record<string, unknown>>).map((r) => ({
    awardId: String(r.award_id),
    awardDate:
      r.award_date instanceof Date
        ? r.award_date.toISOString().slice(0, 10)
        : String(r.award_date),
    title: r.title == null ? null : String(r.title),
    commodityDescription:
      r.commodity_description == null ? null : String(r.commodity_description),
    categoryTags: (r.category_tags as string[] | null) ?? [],
    contractValueNative:
      r.contract_value_native != null
        ? Number.parseFloat(String(r.contract_value_native))
        : null,
    contractCurrency: r.contract_currency == null ? null : String(r.contract_currency),
    contractValueUsd:
      r.contract_value_usd != null
        ? Number.parseFloat(String(r.contract_value_usd))
        : null,
    status: String(r.status ?? 'active'),
    supplierId: String(r.supplier_id),
    supplierName: String(r.supplier_name),
    supplierCountry: r.supplier_country == null ? null : String(r.supplier_country),
    sourceUrl: r.source_url == null ? null : String(r.source_url),
    sourcePortal: String(r.source_portal),
  }));
}

/**
 * Aggregated stats for a buyer over the lookback window. Cheap
 * roll-up that mirrors the reverse-search response shape so the
 * buyer-drilldown page can render the same headline numbers without
 * the caller having to scan the full row list.
 */
export interface BuyerStats {
  totalAwards: number;
  totalValueUsd: number | null;
  firstAwardDate: string | null;
  mostRecentAwardDate: string | null;
  topSupplier: { supplierId: string; supplierName: string; awardsCount: number } | null;
  awardsByCategory: Record<string, number>;
}

export async function getBuyerStats(
  args: Omit<BuyerAwardHistoryArgs, 'limit'>,
): Promise<BuyerStats> {
  const yearsLookback = args.yearsLookback ?? 10;

  const summaryRows = await db.execute(sql`
    SELECT
      COUNT(*)::int                                  AS total_awards,
      SUM(a.contract_value_usd)                      AS total_value_usd,
      MIN(a.award_date)                              AS first_award_date,
      MAX(a.award_date)                              AS most_recent_award_date
    FROM awards a
    WHERE
      a.buyer_name = ${args.buyerName}
      AND a.buyer_country = ${args.buyerCountry}
      AND a.award_date >= NOW() - (${yearsLookback}::int || ' years')::interval
      ${
        args.categoryTag
          ? sql`AND ${args.categoryTag} = ANY(a.category_tags)`
          : sql``
      };
  `);

  const summary = (summaryRows.rows as Array<Record<string, unknown>>)[0];

  const topSupplierRows = await db.execute(sql`
    SELECT
      s.id                AS supplier_id,
      s.organisation_name AS supplier_name,
      COUNT(*)::int       AS awards_count
    FROM awards a
    JOIN award_awardees aa ON aa.award_id = a.id
    JOIN external_suppliers s ON s.id = aa.supplier_id
    WHERE
      a.buyer_name = ${args.buyerName}
      AND a.buyer_country = ${args.buyerCountry}
      AND a.award_date >= NOW() - (${yearsLookback}::int || ' years')::interval
      ${
        args.categoryTag
          ? sql`AND ${args.categoryTag} = ANY(a.category_tags)`
          : sql``
      }
    GROUP BY s.id, s.organisation_name
    ORDER BY COUNT(*) DESC
    LIMIT 1;
  `);
  const topSupplier = (topSupplierRows.rows as Array<Record<string, unknown>>)[0];

  const categoryRows = await db.execute(sql`
    SELECT tag, COUNT(*)::int AS cnt
    FROM (
      SELECT unnest(a.category_tags) AS tag
      FROM awards a
      WHERE
        a.buyer_name = ${args.buyerName}
        AND a.buyer_country = ${args.buyerCountry}
        AND a.award_date >= NOW() - (${yearsLookback}::int || ' years')::interval
    ) t
    GROUP BY tag
    ORDER BY cnt DESC;
  `);

  const awardsByCategory: Record<string, number> = {};
  for (const row of categoryRows.rows as Array<Record<string, unknown>>) {
    awardsByCategory[String(row.tag)] = Number(row.cnt);
  }

  return {
    totalAwards: summary?.total_awards != null ? Number(summary.total_awards) : 0,
    totalValueUsd:
      summary?.total_value_usd != null
        ? Number.parseFloat(String(summary.total_value_usd))
        : null,
    firstAwardDate:
      summary?.first_award_date instanceof Date
        ? summary.first_award_date.toISOString().slice(0, 10)
        : summary?.first_award_date != null
          ? String(summary.first_award_date)
          : null,
    mostRecentAwardDate:
      summary?.most_recent_award_date instanceof Date
        ? summary.most_recent_award_date.toISOString().slice(0, 10)
        : summary?.most_recent_award_date != null
          ? String(summary.most_recent_award_date)
          : null,
    topSupplier: topSupplier
      ? {
          supplierId: String(topSupplier.supplier_id),
          supplierName: String(topSupplier.supplier_name),
          awardsCount: Number(topSupplier.awards_count),
        }
      : null,
    awardsByCategory,
  };
}

/**
 * Thin wrapper around analyzeSupplier — fixes the supplierId-only path
 * for the supplier-profile page. The richer fuzzy-name resolution lives
 * in analyzeSupplier itself; pages that already have a UUID just call
 * this.
 */
export async function getSupplierProfile(
  supplierId: string,
  yearsLookback?: number,
): Promise<SupplierAnalysisResult> {
  return analyzeSupplier({ supplierId, yearsLookback });
}

