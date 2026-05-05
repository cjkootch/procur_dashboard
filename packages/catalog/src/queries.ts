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
  crudeAssayCuts,
  crudeAssays,
  crudeGrades,
  db,
  documents,
  externalSuppliers,
  jurisdictions,
  entityNewsEvents,
  entitySanctionsScreens,
  knownEntities,
  matchQueue,
  opportunities,
  pastPerformance,
  supplierAliases,
  supplierApprovals,
  supplierSignals,
  taxonomyCategories,
  users,
  type SupplierApproval,
  type SupplierApprovalStatus,
} from '@procur/db';
import {
  countriesInRegion,
  tradeRegionForCountry,
  type TradeRegion,
} from './trade-regions';

/**
 * Build a properly-cast Postgres array literal from a JS array.
 *
 * The bare `${arr}::text[]` template form goes through Drizzle's
 * Neon-HTTP serialization as a JSON record literal, which Postgres
 * rejects with "cannot cast type record to text[]" (error 42846).
 * Depending on where the template lives that surfaces as either a
 * 500 with empty body (route handler) or silently dropped rows
 * (background job that swallows the error). Either way the cure is
 * to inline the values into an explicit ARRAY[...] literal that
 * casts cleanly.
 *
 * Use this whenever a JS array needs to land in a `= ANY(...)` or
 * `&& ...` clause typed as text[] / uuid[].
 */
function pgArray(values: readonly string[], elemType: 'text' | 'uuid' = 'text') {
  if (values.length === 0) {
    return sql`ARRAY[]::${sql.raw(elemType)}[]`;
  }
  return sql`ARRAY[${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )}]::${sql.raw(elemType)}[]`;
}

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
  /**
   * Trading-economics preferences. Each field is null when the
   * company hasn't set a desk-level default; the calculator falls
   * back to its hard-coded defaults in that case. The assistant
   * should still mention these when answering economics questions
   * so the user knows which numbers came from their settings vs the
   * calculator default.
   */
  tradingPreferences: {
    defaultSourcingRegion: string | null;
    targetGrossMarginPct: number | null;
    targetNetMarginPerUsg: number | null;
    monthlyFixedOverheadUsdDefault: number | null;
  };
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
    columns: {
      id: true,
      name: true,
      planTier: true,
      defaultSourcingRegion: true,
      targetGrossMarginPct: true,
      targetNetMarginPerUsg: true,
      monthlyFixedOverheadUsdDefault: true,
    },
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
    tradingPreferences: {
      defaultSourcingRegion: company.defaultSourcingRegion ?? null,
      targetGrossMarginPct: parseDecimal(
        company.targetGrossMarginPct as string | null,
      ),
      targetNetMarginPerUsg: parseDecimal(
        company.targetNetMarginPerUsg as string | null,
      ),
      monthlyFixedOverheadUsdDefault:
        company.monthlyFixedOverheadUsdDefault ?? null,
    },
  };
}

export type CompanyDealDefaultsRow = {
  defaultSourcingRegion: string | null;
  targetGrossMarginPct: number | null;
  targetNetMarginPerUsg: number | null;
  monthlyFixedOverheadUsdDefault: number | null;
};

/**
 * Fetch the company's trading-economics preferences for use as
 * defaults in compose_deal_economics. All fields nullable — the
 * calculator falls back to its hard-coded defaults when a column is
 * NULL. Returns null when the company row doesn't exist.
 *
 * Numeric columns come back as strings from drizzle's numeric type;
 * we parse them to numbers here so the calculator gets the shape it
 * expects without each caller re-parsing.
 */
export async function getCompanyDealDefaults(
  companyId: string,
): Promise<CompanyDealDefaultsRow | null> {
  const row = await db.query.companies.findFirst({
    where: eq(companies.id, companyId),
    columns: {
      defaultSourcingRegion: true,
      targetGrossMarginPct: true,
      targetNetMarginPerUsg: true,
      monthlyFixedOverheadUsdDefault: true,
    },
  });
  if (!row) return null;
  return {
    defaultSourcingRegion: row.defaultSourcingRegion ?? null,
    targetGrossMarginPct: parseDecimal(row.targetGrossMarginPct as string | null),
    targetNetMarginPerUsg: parseDecimal(row.targetNetMarginPerUsg as string | null),
    monthlyFixedOverheadUsdDefault: row.monthlyFixedOverheadUsdDefault ?? null,
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
            ? sql`AND a.unspsc_codes && ${pgArray(spec.unspscCodes)}`
            : sql``
        }
        ${
          spec.buyerCountries && spec.buyerCountries.length > 0
            ? sql`AND a.buyer_country = ANY(${pgArray(spec.buyerCountries)})`
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
  /**
   * Optional geographic bias. When set, candidates are re-ranked by
   *   adjustedScore = baseRank + proximityFactor * weightFactor
   * where proximityFactor = max(0, 1 - distanceFromBiasNm / 6000).
   * Distance is from the bias point to the supplier's country
   *   centroid (averaged from known_entities lat/lng for that country).
   * Suppliers with no country or no centroid coverage get
   *   proximityFactor = 0 (no boost, no penalty).
   *
   * weightFactor is a multiplier on the [0..1] proximityFactor —
   * pass e.g. 5 to make a 0-distance country worth 5 ranks of base
   * rank. Caller's responsibility to choose a value that makes sense
   * for the candidate-pool size.
   */
  originBias?: {
    lat: number;
    lon: number;
    weightFactor: number;
  };
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
  /** Set when originBias was applied. Distance from bias point to
   *  the supplier's country centroid in nautical miles. Null when the
   *  supplier had no country or the centroid was unknown. */
  distanceFromBiasNm?: number | null;
  /** Set when originBias was applied. The proximity component of the
   *  re-ranked score, in [0, weightFactor]. */
  proximityBoost?: number;
  /** True when the supplier's country sits in the same trade region
   *  as the buyer (per `tradeRegionForCountry`). False when supplier
   *  is in a different region. Null when buyer region or supplier
   *  country is unknown. Surfaced so the chat tool can flag
   *  cross-region candidates ("only out-of-region suppliers in the
   *  data — coverage gap"). */
  regionMatch?: boolean | null;
}

export interface FindSuppliersForTenderResult {
  /** Whether the query inputs came from the opportunity record or from explicit args. */
  derivedFrom: 'opportunity' | 'explicit_args';
  categoryTag: string | null;
  suppliers: CandidateSupplier[];
  /** Surfaced when the buyer's trade region is known and NONE of the
   *  returned suppliers sit in that region. Tells the chat tool /
   *  caller to frame this as a coverage gap, not a recommendation. */
  coverageNote?: string;
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

  // Resolve the buyer's trade region (e.g. PL → europe-west). When
  // resolved, suppliers in the same region get a boost in the SQL
  // ORDER BY — preventing the "Honduran gas station for a Polish
  // tender" pattern that the prior version produced when no supplier
  // had a buyer-country match. The fallback ranking (most recent +
  // value) still kicks in among same-tier candidates.
  const buyerRegion: TradeRegion | null = tradeRegionForCountry(buyerCountry);
  const buyerRegionCountries: string[] = buyerRegion
    ? countriesInRegion(buyerRegion)
    : [];

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
        BOOL_OR(beneficiary_country = ${beneficiaryCountry ?? ''}) AS beneficiary_country_match,
        ${
          buyerRegionCountries.length > 0
            ? sql`(supplier_country = ANY(${pgArray(buyerRegionCountries)}))`
            : sql`FALSE`
        } AS supplier_region_match
      FROM matching_awards
      GROUP BY supplier_id, organisation_name, supplier_country
    )
    SELECT *
    FROM ranked
    ORDER BY
      -- Geography overlap first (weighted): buyer-country (4) >
      -- beneficiary-country (2) > same-trade-region (1). Score blend
      -- means a same-region supplier beats out an out-of-region
      -- supplier even when neither has a country match — preventing
      -- the Honduran-supplier-for-Polish-tender false positive.
      (CASE WHEN buyer_country_match THEN 4 ELSE 0 END
        + CASE WHEN beneficiary_country_match THEN 2 ELSE 0 END
        + CASE WHEN supplier_region_match THEN 1 ELSE 0 END) DESC,
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
      const supplierCountry = r.supplier_country == null ? null : String(r.supplier_country);
      // regionMatch is null when buyer region or supplier country is
      // unknown — chat tool reads null as "can't tell," not as "no."
      const regionMatch: boolean | null =
        buyerRegion == null || supplierCountry == null
          ? null
          : Boolean(r.supplier_region_match);
      if (regionMatch === true && !r.buyer_country_match) {
        matchReasons.push(`same trade region as ${buyerCountry} (${buyerRegion})`);
      }
      return {
        supplierId: String(r.supplier_id),
        supplierName: String(r.organisation_name),
        country: supplierCountry,
        matchingAwardsCount: count,
        totalValueUsd:
          r.total_value_usd != null ? Number.parseFloat(String(r.total_value_usd)) : null,
        mostRecentAwardDate:
          r.most_recent_award_date instanceof Date
            ? r.most_recent_award_date.toISOString().slice(0, 10)
            : String(r.most_recent_award_date),
        recentBuyers: (r.recent_buyers as string[] | null) ?? [],
        matchReasons,
        regionMatch,
      };
    },
  );

  // Coverage note: when buyer region is known and not a single
  // returned supplier sits in that region, surface the gap. Chat tool
  // is instructed to lead with this rather than presenting the
  // out-of-region candidates as a real shortlist.
  let coverageNote: string | undefined;
  if (
    buyerRegion != null &&
    suppliers.length > 0 &&
    suppliers.every((s) => s.regionMatch !== true)
  ) {
    coverageNote =
      `No suppliers in ${buyerRegion} have public-tender history for this category. ` +
      `Showing closest-matching out-of-region candidates by recency + volume — ` +
      `treat this as a coverage gap, not a recommendation.`;
  }

  const baseResult: FindSuppliersForTenderResult = {
    derivedFrom,
    categoryTag,
    suppliers,
    ...(coverageNote ? { coverageNote } : {}),
  };

  if (args.originBias) {
    const ranked = await applyOriginBias(suppliers, args.originBias);
    return { ...baseResult, suppliers: ranked };
  }
  return baseResult;
}

/**
 * Re-rank suppliers by geographic proximity to a bias point.
 *
 * Country centroids are computed dynamically from known_entities
 * (average lat/lng across all rows for each country). A supplier
 * whose country has no centroid coverage gets proximityFactor = 0.
 *
 * Score model: keeps the original SQL ranking as `baseRank`
 * (descending position → 0..N), adds proximityBoost in
 * [0, weightFactor]. We then sort by (baseRank + proximityBoost)
 * descending. weightFactor of 5 means a 0-distance country gets a
 * 5-rank boost — calibrate to candidate-pool size.
 */
async function applyOriginBias(
  suppliers: CandidateSupplier[],
  bias: { lat: number; lon: number; weightFactor: number },
): Promise<CandidateSupplier[]> {
  if (suppliers.length === 0) return suppliers;
  const countries = Array.from(
    new Set(suppliers.map((s) => s.country).filter((c): c is string => c != null)),
  );
  if (countries.length === 0) {
    return suppliers.map((s, i) => ({
      ...s,
      distanceFromBiasNm: null,
      proximityBoost: 0,
      // Preserve original order — no centroid data to bias on.
      _originalRank: suppliers.length - i,
    })) as CandidateSupplier[];
  }

  // Single query for all unique supplier countries.
  const centroidResult = await db.execute(sql`
    SELECT country,
      avg(latitude::float8) AS lat,
      avg(longitude::float8) AS lon
    FROM known_entities
    WHERE country = ANY(${pgArray(countries)})
      AND latitude IS NOT NULL
      AND longitude IS NOT NULL
    GROUP BY country
  `);
  const centroidByCountry = new Map<string, { lat: number; lon: number }>();
  for (const row of centroidResult.rows as Array<Record<string, unknown>>) {
    centroidByCountry.set(String(row.country), {
      lat: Number.parseFloat(String(row.lat)),
      lon: Number.parseFloat(String(row.lon)),
    });
  }

  // Score each supplier. baseRank is its current 1-indexed position
  // from the bottom (so the top supplier gets the largest baseRank).
  const N = suppliers.length;
  const scored = suppliers.map((s, i) => {
    const baseRank = N - i;
    let distanceFromBiasNm: number | null = null;
    let proximityBoost = 0;
    if (s.country) {
      const centroid = centroidByCountry.get(s.country);
      if (centroid) {
        distanceFromBiasNm = haversineNm(bias.lat, bias.lon, centroid.lat, centroid.lon);
        const proximityFactor = Math.max(0, 1 - distanceFromBiasNm / 6000);
        proximityBoost = proximityFactor * bias.weightFactor;
      }
    }
    return {
      ...s,
      distanceFromBiasNm,
      proximityBoost,
      _adjustedScore: baseRank + proximityBoost,
    };
  });

  scored.sort((a, b) => b._adjustedScore - a._adjustedScore);

  return scored.map(({ _adjustedScore: _adj, ...rest }) => rest);
}

function haversineNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R_NM = 3440.065;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R_NM * 2 * Math.asin(Math.sqrt(a));
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
          ? sql`AND a.buyer_country = ANY(${pgArray(args.buyerCountries)})`
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
          ? sql`AND a.buyer_country = ANY(${pgArray(args.buyerCountries)})`
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
              ? sql`AND a2.buyer_country = ANY(${pgArray(args.buyerCountries)})`
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
          ? sql`AND a.buyer_country = ANY(${pgArray(args.buyerCountries)})`
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
  /** Case-insensitive name match. Searches name, aliases[], AND slug
   *  with ILIKE '%query%'. Useful for "do we have X in the rolodex"
   *  questions where the user types a fragment of a company name. */
  name?: string;
  /** When provided, joins supplier_approvals for this company so each
   *  row includes the company's approvalStatus + approvedAt + expiresAt.
   *  Required for the `approvalStatus` filter to work. */
  companyId?: string;
  /** Filter rows by their approval status (relative to companyId).
   *   - 'approved'  — approved_with_kyc OR approved_without_kyc
   *   - 'pending'   — pending OR kyc_in_progress
   *   - 'rejected'  — rejected
   *   - 'expired'   — expired (KYC lapsed)
   *   - 'none'      — no approval row exists yet
   *  No-op when companyId is omitted. */
  approvalStatus?: 'approved' | 'pending' | 'rejected' | 'expired' | 'none';
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
  /** Per-tenant approval state. Populated only when KnownEntityFilters
   *  was called with companyId. Null = no approval row for this entity. */
  approvalStatus: SupplierApprovalStatusValue | null;
  /** ISO-8601. When the row's status moved into approved_*. */
  approvalApprovedAt: string | null;
  /** ISO-8601. KYC re-cert date, when set. */
  approvalExpiresAt: string | null;
}

/** Mirrors SupplierApprovalStatus in @procur/db; duplicated here to
 *  avoid a cross-package import on the public query shape. Keep in
 *  sync with packages/db/src/schema/supplier-approvals.ts. */
export type SupplierApprovalStatusValue =
  | 'pending'
  | 'kyc_in_progress'
  | 'approved_without_kyc'
  | 'approved_with_kyc'
  | 'rejected'
  | 'expired';

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
  // Default keeps small-result-set callers tight; ceiling raised to
  // 50k so the rolodex page can pull the full universe without
  // tripping the "capped" UI for normal browsing. The query is a
  // single indexed `WHERE role / country / tag` scan — even at 50k
  // it returns in <500 ms on Neon HTTP.
  const limit = Math.min(filters.limit ?? 100, 50_000);
  const companyId = filters.companyId ?? null;
  // Approval-status filter is a no-op without companyId — without
  // the join there's nothing to filter on. Returning [] would silently
  // hide every entity; passing through (filter ignored) matches the
  // existing "filter unmet, return rows" pattern of the other params.
  const approvalFilter = companyId ? filters.approvalStatus : undefined;
  const result = await db.execute(sql`
    SELECT
      ke.id, ke.slug, ke.name, ke.country, ke.role, ke.categories, ke.notes,
      ke.contact_entity, ke.aliases, ke.tags, ke.metadata,
      ke.latitude, ke.longitude,
      ${companyId ? sql`sa.status` : sql`NULL::text`} AS approval_status,
      ${companyId ? sql`sa.approved_at` : sql`NULL::timestamptz`} AS approval_approved_at,
      ${companyId ? sql`sa.expires_at` : sql`NULL::timestamptz`} AS approval_expires_at
    FROM known_entities ke
    ${
      companyId
        ? sql`LEFT JOIN supplier_approvals sa
            ON sa.entity_slug = ke.slug AND sa.company_id = ${companyId}::uuid`
        : sql``
    }
    WHERE 1=1
      ${
        filters.categoryTag
          ? sql`AND ${filters.categoryTag} = ANY(ke.categories)`
          : sql``
      }
      ${filters.country ? sql`AND ke.country = ${filters.country}` : sql``}
      ${filters.role ? sql`AND ke.role = ${filters.role}` : sql``}
      ${filters.tag ? sql`AND ${filters.tag} = ANY(ke.tags)` : sql``}
      ${
        filters.name
          ? sql`AND (
              ke.name ILIKE ${`%${filters.name}%`}
              OR ke.slug ILIKE ${`%${filters.name.toLowerCase().replace(/\s+/g, '-')}%`}
              OR EXISTS (
                SELECT 1 FROM unnest(ke.aliases) AS a
                WHERE a ILIKE ${`%${filters.name}%`}
              )
            )`
          : sql``
      }
      ${
        approvalFilter === 'approved'
          ? sql`AND sa.status IN ('approved_with_kyc','approved_without_kyc')`
          : approvalFilter === 'pending'
            ? sql`AND sa.status IN ('pending','kyc_in_progress')`
            : approvalFilter === 'rejected'
              ? sql`AND sa.status = 'rejected'`
              : approvalFilter === 'expired'
                ? sql`AND sa.status = 'expired'`
                : approvalFilter === 'none'
                  ? sql`AND sa.status IS NULL`
                  : sql``
      }
    ORDER BY ke.country ASC, ke.name ASC
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
    approvalStatus: (r.approval_status as SupplierApprovalStatusValue | null) ?? null,
    approvalApprovedAt:
      r.approval_approved_at instanceof Date
        ? r.approval_approved_at.toISOString()
        : r.approval_approved_at == null
          ? null
          : String(r.approval_approved_at),
    approvalExpiresAt:
      r.approval_expires_at instanceof Date
        ? r.approval_expires_at.toISOString()
        : r.approval_expires_at == null
          ? null
          : String(r.approval_expires_at),
  }));
}

export interface ProximityEntityRow extends KnownEntityRow {
  /** Great-circle distance from the query point in nautical miles. */
  distanceNm: number;
}

/**
 * known_entities filtered by haversine distance from a query point.
 * Powers /intelligence/proximity-suppliers — vex's tender-sourcing
 * scout uses this to surface candidate suppliers within shipping
 * range of a buyer's destination port.
 *
 * 3440.065 = Earth's radius in nautical miles. Computing inside SQL
 * keeps the LIMIT honest (otherwise we'd over-fetch + filter in JS).
 *
 * Excludes entities where latitude IS NULL (run backfill-entity-coords
 * to populate). The `roles` filter is OR'd; `categoryTag` is AND'd
 * against the categories array; both are optional.
 */
export async function findEntitiesNearLocation(filters: {
  destinationLat: number;
  destinationLon: number;
  /** Maximum distance in nautical miles. */
  radiusNm: number;
  /** Optional role filter (refiner, producer, terminal, port, trader, state-buyer). */
  roles?: string[];
  /** Optional category tag — must appear in entity's categories array. */
  categoryTag?: string;
  /** Optional tag filter — must appear in entity's tags array. */
  tag?: string;
  limit?: number;
}): Promise<ProximityEntityRow[]> {
  const lat = filters.destinationLat;
  const lon = filters.destinationLon;
  const limit = Math.min(filters.limit ?? 50, 500);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error('destinationLat / destinationLon must be finite numbers');
  }
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    throw new Error('destinationLat / destinationLon out of range');
  }

  const roleFilter = filters.roles && filters.roles.length > 0
    ? sql`AND role = ANY(${pgArray(filters.roles)})`
    : sql``;
  const categoryFilter = filters.categoryTag
    ? sql`AND ${filters.categoryTag} = ANY(categories)`
    : sql``;
  const tagFilter = filters.tag
    ? sql`AND ${filters.tag} = ANY(tags)`
    : sql``;

  const result = await db.execute(sql`
    WITH scored AS (
      SELECT
        id, slug, name, country, role, categories, notes,
        contact_entity, aliases, tags, metadata, latitude, longitude,
        3440.065 * 2 * asin(sqrt(
          power(sin(radians((latitude::float8 - ${lat}) / 2)), 2) +
          cos(radians(${lat})) * cos(radians(latitude::float8)) *
          power(sin(radians((longitude::float8 - ${lon}) / 2)), 2)
        )) AS distance_nm
      FROM known_entities
      WHERE latitude IS NOT NULL
        AND longitude IS NOT NULL
        ${roleFilter}
        ${categoryFilter}
        ${tagFilter}
    )
    SELECT *
    FROM scored
    WHERE distance_nm <= ${filters.radiusNm}
    ORDER BY distance_nm ASC
    LIMIT ${limit}
  `);

  return (result.rows as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    slug: String(r.slug),
    name: String(r.name),
    country: String(r.country),
    role: String(r.role),
    categories: (r.categories as string[]) ?? [],
    notes: r.notes != null ? String(r.notes) : null,
    contactEntity: r.contact_entity != null ? String(r.contact_entity) : null,
    aliases: (r.aliases as string[]) ?? [],
    tags: (r.tags as string[]) ?? [],
    metadata: (r.metadata as Record<string, unknown> | null) ?? null,
    latitude: r.latitude != null ? Number.parseFloat(String(r.latitude)) : null,
    longitude: r.longitude != null ? Number.parseFloat(String(r.longitude)) : null,
    distanceNm: Number.parseFloat(String(r.distance_nm)),
    // Approval state isn't fetched in this proximity query — callers
    // who need it should use lookupKnownEntities with companyId.
    approvalStatus: null,
    approvalApprovedAt: null,
    approvalExpiresAt: null,
  }));
}

/**
 * Recent past awards in a similar (buyer_country × category) bucket.
 * Used by the deal-composition workflow as price anchors — *"the last
 * 5 DR diesel awards averaged $X with these suppliers"* gives the
 * analyst a defensible bid range.
 *
 * Distinct from `findCompetingSellers` (which surfaces supplier-side
 * landscape) and `analyzeSupplier` (which deep-dives one entity).
 * This is the "what did this market just pay" snapshot.
 */
export async function findRecentSimilarAwards(filters: {
  buyerCountry?: string;
  categoryTag?: string;
  daysBack?: number;
  limit?: number;
}): Promise<
  Array<{
    awardId: string;
    awardDate: string;
    buyerName: string;
    buyerCountry: string;
    title: string | null;
    commodityDescription: string | null;
    contractValueUsd: number | null;
    supplierName: string | null;
    supplierId: string | null;
  }>
> {
  const daysBack = filters.daysBack ?? 365;
  const limit = Math.min(filters.limit ?? 10, 50);
  const result = await db.execute(sql`
    SELECT
      a.id, a.award_date, a.buyer_name, a.buyer_country,
      a.title, a.commodity_description, a.contract_value_usd,
      s.organisation_name AS supplier_name, aa.supplier_id
    FROM awards a
    LEFT JOIN award_awardees aa ON aa.award_id = a.id
    LEFT JOIN external_suppliers s ON s.id = aa.supplier_id
    WHERE a.award_date >= NOW() - (${daysBack}::int || ' days')::interval
      AND a.contract_value_usd IS NOT NULL
      AND a.contract_value_usd > 0
      ${
        filters.categoryTag && filters.categoryTag !== 'all'
          ? sql`AND ${filters.categoryTag} = ANY(a.category_tags)`
          : sql``
      }
      ${filters.buyerCountry ? sql`AND a.buyer_country = ${filters.buyerCountry}` : sql``}
    ORDER BY a.award_date DESC, a.contract_value_usd DESC
    LIMIT ${limit};
  `);
  return (result.rows as Array<Record<string, unknown>>).map((r) => ({
    awardId: String(r.id),
    awardDate: String(r.award_date).slice(0, 10),
    buyerName: String(r.buyer_name),
    buyerCountry: String(r.buyer_country),
    title: r.title == null ? null : String(r.title),
    commodityDescription:
      r.commodity_description == null ? null : String(r.commodity_description),
    contractValueUsd:
      r.contract_value_usd != null
        ? Number.parseFloat(String(r.contract_value_usd))
        : null,
    supplierName: r.supplier_name == null ? null : String(r.supplier_name),
    supplierId: r.supplier_id == null ? null : String(r.supplier_id),
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
    /** Last ~30 daily prices for a sparkline. Oldest → newest. */
    spark: number[];
  }>
> {
  if (seriesSlugs.length === 0) return [];
  // Drizzle's neon-http handles `inArray` cleanly; the prior
  // `ANY(${arr}::text[])` template form serialized arrays in a way
  // that Neon's wire protocol rejected silently and dropped the
  // ticker rows entirely. Use a hand-built IN list against an
  // unrolled SQL placeholder list.
  const inFragment = sql.join(
    seriesSlugs.map((s) => sql`${s}`),
    sql`, `,
  );
  const result = await db.execute(sql`
    WITH latest AS (
      SELECT DISTINCT ON (series_slug)
        series_slug, price::numeric AS price, unit, price_date
      FROM commodity_prices
      WHERE series_slug IN (${inFragment})
        AND contract_type = 'spot'
      ORDER BY series_slug, price_date DESC
    ),
    earlier AS (
      SELECT DISTINCT ON (series_slug)
        series_slug, price::numeric AS price
      FROM commodity_prices
      WHERE series_slug IN (${inFragment})
        AND contract_type = 'spot'
        AND price_date <= NOW() - INTERVAL '30 days'
      ORDER BY series_slug, price_date DESC
    ),
    spark AS (
      SELECT series_slug,
        json_agg(price::numeric ORDER BY price_date ASC) AS prices
      FROM (
        SELECT series_slug, price, price_date
        FROM commodity_prices
        WHERE series_slug IN (${inFragment})
          AND contract_type = 'spot'
          AND price_date >= NOW() - INTERVAL '45 days'
        ORDER BY series_slug, price_date ASC
      ) sub
      GROUP BY series_slug
    )
    SELECT
      l.series_slug, l.price AS latest_price, l.unit, l.price_date AS latest_date,
      e.price AS earlier_price,
      s.prices AS spark
    FROM latest l
    LEFT JOIN earlier e ON e.series_slug = l.series_slug
    LEFT JOIN spark   s ON s.series_slug = l.series_slug;
  `);
  return (result.rows as Array<Record<string, unknown>>).map((r) => {
    const latest =
      r.latest_price != null ? Number.parseFloat(String(r.latest_price)) : null;
    const earlier =
      r.earlier_price != null ? Number.parseFloat(String(r.earlier_price)) : null;
    const sparkRaw = (r.spark as Array<number | string> | null) ?? [];
    const spark = sparkRaw
      .map((v) => Number.parseFloat(String(v)))
      .filter((v) => Number.isFinite(v));
    return {
      seriesSlug: String(r.series_slug),
      latestPrice: latest,
      latestDate: r.latest_date == null ? null : String(r.latest_date).slice(0, 10),
      unit: r.unit == null ? null : String(r.unit),
      pctChange30d:
        latest != null && earlier != null && earlier !== 0
          ? ((latest - earlier) / earlier) * 100
          : null,
      spark,
    };
  });
}

/**
 * Top suppliers × top buyer countries award-count matrix. Reveals
 * geographic specialization — "Vitol sells almost exclusively into
 * IT/ES, Glencore is more diversified, Trafigura concentrated on IN".
 *
 * Returns a flat list of (supplier, buyerCountry, awardCount) cells
 * for the top N suppliers (by total awards in window) × top M buyer
 * countries (by total awards in window). Caller renders as a heatmap.
 */
export async function getSupplierBuyerMatrix(filters: {
  categoryTag?: string;
  monthsLookback?: number;
  topSuppliers?: number;
  topBuyerCountries?: number;
}): Promise<{
  suppliers: Array<{ supplierId: string; supplierName: string; total: number }>;
  buyerCountries: Array<{ country: string; total: number }>;
  cells: Array<{ supplierId: string; buyerCountry: string; awardCount: number }>;
}> {
  const monthsLookback = filters.monthsLookback ?? 12;
  const topSuppliers = filters.topSuppliers ?? 10;
  const topCountries = filters.topBuyerCountries ?? 10;

  const result = await db.execute(sql`
    WITH base AS (
      SELECT
        a.id, a.buyer_country, aa.supplier_id, s.organisation_name AS supplier_name
      FROM awards a
      JOIN award_awardees aa ON aa.award_id = a.id
      JOIN external_suppliers s ON s.id = aa.supplier_id
      WHERE a.award_date >= NOW() - (${monthsLookback}::int || ' months')::interval
        AND aa.supplier_id IS NOT NULL
        ${
          filters.categoryTag && filters.categoryTag !== 'all'
            ? sql`AND ${filters.categoryTag} = ANY(a.category_tags)`
            : sql``
        }
    ),
    top_suppliers AS (
      SELECT supplier_id, MIN(supplier_name) AS supplier_name, COUNT(*) AS total
      FROM base
      GROUP BY supplier_id
      ORDER BY total DESC
      LIMIT ${topSuppliers}
    ),
    top_countries AS (
      SELECT buyer_country, COUNT(*) AS total
      FROM base
      GROUP BY buyer_country
      ORDER BY total DESC
      LIMIT ${topCountries}
    ),
    cells AS (
      SELECT b.supplier_id, b.buyer_country, COUNT(*)::int AS award_count
      FROM base b
      WHERE b.supplier_id IN (SELECT supplier_id FROM top_suppliers)
        AND b.buyer_country IN (SELECT buyer_country FROM top_countries)
      GROUP BY b.supplier_id, b.buyer_country
    )
    SELECT
      (SELECT json_agg(t ORDER BY t.total DESC) FROM (
        SELECT supplier_id, supplier_name, total FROM top_suppliers
      ) t) AS suppliers,
      (SELECT json_agg(t ORDER BY t.total DESC) FROM (
        SELECT buyer_country, total FROM top_countries
      ) t) AS countries,
      (SELECT json_agg(t) FROM cells t) AS cells;
  `);
  const row = (result.rows as Array<Record<string, unknown>>)[0] ?? {};
  type SupplierRow = {
    supplier_id: string;
    supplier_name: string;
    total: number | string;
  };
  type CountryRow = { buyer_country: string; total: number | string };
  type CellRow = {
    supplier_id: string;
    buyer_country: string;
    award_count: number;
  };
  const suppliers = ((row.suppliers as SupplierRow[] | null) ?? []).map((s) => ({
    supplierId: String(s.supplier_id),
    supplierName: String(s.supplier_name ?? ''),
    total: Number(s.total),
  }));
  const buyerCountries = ((row.countries as CountryRow[] | null) ?? []).map(
    (c) => ({ country: String(c.buyer_country), total: Number(c.total) }),
  );
  const cells = ((row.cells as CellRow[] | null) ?? []).map((c) => ({
    supplierId: String(c.supplier_id),
    buyerCountry: String(c.buyer_country),
    awardCount: Number(c.award_count),
  }));
  return { suppliers, buyerCountries, cells };
}

/**
 * Rolodex coverage stats for a country — how much analyst-curated
 * data depth is there for the selected jurisdiction. Surfaces the
 * "should I trust this dashboard" question with a simple read:
 * lots of refineries with slate metadata = high confidence; few
 * known entities = thin data, treat conclusions cautiously.
 */
export async function getRolodexCoverage(
  country: string,
): Promise<{
  total: number;
  byRole: Record<string, number>;
  withCoords: number;
  withSlate: number;
}> {
  const result = await db.execute(sql`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE latitude IS NOT NULL)::int AS with_coords,
      COUNT(*) FILTER (WHERE metadata ? 'slate')::int AS with_slate,
      role,
      COUNT(*)::int AS role_count
    FROM known_entities
    WHERE country = ${country}
    GROUP BY GROUPING SETS ((role), ());
  `);
  const rows = result.rows as Array<Record<string, unknown>>;
  let total = 0;
  let withCoords = 0;
  let withSlate = 0;
  const byRole: Record<string, number> = {};
  for (const r of rows) {
    if (r.role == null) {
      // The rollup row.
      total = Number(r.total ?? 0);
      withCoords = Number(r.with_coords ?? 0);
      withSlate = Number(r.with_slate ?? 0);
    } else {
      byRole[String(r.role)] = Number(r.role_count ?? 0);
    }
  }
  return { total, byRole, withCoords, withSlate };
}

/**
 * Every country that has award data, with the count, optionally
 * scoped to a category. Drives the dashboard's country picker —
 * we don't want a hand-edited 10-country strip; the picker lists
 * everything the data actually has, with counts so the analyst
 * sees depth before filtering.
 */
export async function getCountriesWithAwards(filters?: {
  categoryTag?: string;
  monthsLookback?: number;
}): Promise<Array<{ country: string; awardCount: number }>> {
  const monthsLookback = filters?.monthsLookback ?? 36;
  const result = await db.execute(sql`
    SELECT a.buyer_country AS country, COUNT(*)::int AS award_count
    FROM awards a
    WHERE a.award_date >= NOW() - (${monthsLookback}::int || ' months')::interval
      AND a.buyer_country IS NOT NULL
      AND a.buyer_country <> ''
      ${
        filters?.categoryTag && filters.categoryTag !== 'all'
          ? sql`AND ${filters.categoryTag} = ANY(a.category_tags)`
          : sql``
      }
    GROUP BY a.buyer_country
    ORDER BY award_count DESC, country ASC;
  `);
  return (result.rows as Array<Record<string, unknown>>).map((r) => ({
    country: String(r.country),
    awardCount: Number(r.award_count ?? 0),
  }));
}

/**
 * Period-over-period KPIs for the Intelligence dashboard top strip.
 * Computes current-window totals + prior-window totals so the UI
 * can render a delta badge ("$156M, +8% vs prior 12m").
 */
export async function getIntelligenceKpis(filters: {
  categoryTag?: string;
  buyerCountry?: string;
  monthsLookback?: number;
}): Promise<{
  awardsCurrent: number;
  awardsPrior: number;
  totalUsdCurrent: number | null;
  totalUsdPrior: number | null;
  uniqueBuyers: number;
  uniqueSuppliers: number;
  topBuyerName: string | null;
  topBuyerSharePct: number | null;
}> {
  const monthsLookback = filters.monthsLookback ?? 12;
  const result = await db.execute(sql`
    WITH base AS (
      SELECT
        a.id, a.buyer_name, a.contract_value_usd::numeric AS v,
        a.award_date, aa.supplier_id
      FROM awards a
      LEFT JOIN award_awardees aa ON aa.award_id = a.id
      WHERE a.award_date >= NOW() - (${monthsLookback * 2}::int || ' months')::interval
        ${
          filters.categoryTag && filters.categoryTag !== 'all'
            ? sql`AND ${filters.categoryTag} = ANY(a.category_tags)`
            : sql``
        }
        ${filters.buyerCountry ? sql`AND a.buyer_country = ${filters.buyerCountry}` : sql``}
    ),
    cur AS (
      SELECT * FROM base
      WHERE award_date >= NOW() - (${monthsLookback}::int || ' months')::interval
    ),
    prior AS (
      SELECT * FROM base
      WHERE award_date < NOW() - (${monthsLookback}::int || ' months')::interval
    ),
    cur_buyer_share AS (
      SELECT buyer_name, SUM(v) AS s
      FROM cur WHERE v IS NOT NULL
      GROUP BY buyer_name
      ORDER BY s DESC
      LIMIT 1
    ),
    cur_total AS (
      SELECT SUM(v) AS s FROM cur WHERE v IS NOT NULL
    )
    SELECT
      (SELECT COUNT(*) FROM cur)::int                                    AS awards_current,
      (SELECT COUNT(*) FROM prior)::int                                  AS awards_prior,
      (SELECT SUM(v) FROM cur)                                           AS total_usd_current,
      (SELECT SUM(v) FROM prior)                                         AS total_usd_prior,
      (SELECT COUNT(DISTINCT buyer_name) FROM cur)::int                  AS unique_buyers,
      (SELECT COUNT(DISTINCT supplier_id) FROM cur
        WHERE supplier_id IS NOT NULL)::int                              AS unique_suppliers,
      (SELECT buyer_name FROM cur_buyer_share)                           AS top_buyer_name,
      (SELECT (s / NULLIF((SELECT s FROM cur_total), 0)) * 100
        FROM cur_buyer_share)                                            AS top_buyer_share;
  `);
  const row = (result.rows as Array<Record<string, unknown>>)[0] ?? {};
  const num = (k: string): number | null =>
    row[k] != null ? Number.parseFloat(String(row[k])) : null;
  return {
    awardsCurrent: Number(row.awards_current ?? 0),
    awardsPrior: Number(row.awards_prior ?? 0),
    totalUsdCurrent: num('total_usd_current'),
    totalUsdPrior: num('total_usd_prior'),
    uniqueBuyers: Number(row.unique_buyers ?? 0),
    uniqueSuppliers: Number(row.unique_suppliers ?? 0),
    topBuyerName: row.top_buyer_name == null ? null : String(row.top_buyer_name),
    topBuyerSharePct: num('top_buyer_share'),
  };
}

/**
 * Data-freshness probe — last update across the major signal layers.
 * Drives the "as-of" status strip at the top of the dashboard.
 */
export async function getDataFreshness(): Promise<{
  awards: { latest: string | null; count: number };
  commodityPrices: { latest: string | null; count: number };
  vesselPositions: { latest: string | null; count: number };
  customsImports: { latest: string | null; count: number };
}> {
  const result = await db.execute(sql`
    SELECT
      (SELECT MAX(scraped_at) FROM awards)                               AS awards_latest,
      (SELECT COUNT(*) FROM awards)::bigint                              AS awards_count,
      (SELECT MAX(price_date) FROM commodity_prices)                     AS prices_latest,
      (SELECT COUNT(*) FROM commodity_prices)::bigint                    AS prices_count,
      (SELECT MAX(timestamp) FROM vessel_positions)                      AS positions_latest,
      (SELECT COUNT(*) FROM vessel_positions)::bigint                    AS positions_count,
      (SELECT MAX(period::date) FROM customs_imports)                    AS customs_latest,
      (SELECT COUNT(*) FROM customs_imports)::bigint                     AS customs_count;
  `);
  const row = (result.rows as Array<Record<string, unknown>>)[0] ?? {};
  const ts = (k: string): string | null => {
    const v = row[k];
    return v == null ? null : new Date(String(v)).toISOString();
  };
  return {
    awards: { latest: ts('awards_latest'), count: Number(row.awards_count ?? 0) },
    commodityPrices: { latest: ts('prices_latest'), count: Number(row.prices_count ?? 0) },
    vesselPositions: {
      latest: ts('positions_latest'),
      count: Number(row.positions_count ?? 0),
    },
    customsImports: { latest: ts('customs_latest'), count: Number(row.customs_count ?? 0) },
  };
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
        -- Slate keys are camelCase per the RefinerySlateCapability
        -- schema (@procur/catalog/slate-capability.ts). Older rows
        -- with snake_case keys are migrated by re-running
        -- seed-refinery-slate after this PR lands; queries assume
        -- camelCase.
        ${
          apiNum != null
            ? sql`AND (metadata->'slate'->>'apiMin')::numeric <= ${apiNum}
                  AND (metadata->'slate'->>'apiMax')::numeric >= ${apiNum}`
            : sql``
        }
        ${
          sulfurNum != null
            ? sql`AND (metadata->'slate'->>'sulfurMaxPct')::numeric >= ${sulfurNum}`
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
        typeof slate.notes === 'string'
          ? (slate.notes as string)
          : typeof slate.source_notes === 'string'
            ? (slate.source_notes as string)
            : null,
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
  /** WGS84 decimal degrees. Populated for physical-asset entities
   *  (refineries, terminals, ports). Null when no canonical
   *  location is known (multinational trading houses, etc.). */
  latitude: number | null;
  longitude: number | null;
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
    latitude: number | null;
    longitude: number | null;
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
        SELECT slug, name, country, role, categories, notes, aliases, tags, metadata,
               latitude, longitude
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
      SELECT slug, name, country, role, categories, notes, aliases, tags, metadata,
             latitude, longitude
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
    latitude: knownEntity?.latitude ?? null,
    longitude: knownEntity?.longitude ?? null,
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
  latitude: number | null;
  longitude: number | null;
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
    latitude: r.latitude == null ? null : Number.parseFloat(String(r.latitude)),
    longitude: r.longitude == null ? null : Number.parseFloat(String(r.longitude)),
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
    latitude: null,
    longitude: null,
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
 * Canonical host for entity profile pages — the authenticated main
 * app. Entity profiles only live there; Discover doesn't have an
 * `/entities/[slug]` route, so links built from the Discover widget
 * MUST be absolute URLs pointing at the main app or the user gets
 * a 404 on `discover.procur.app/entities/...` (real chat trace,
 * 2026-Q2).
 *
 * Override via `NEXT_PUBLIC_APP_URL` for staging / local-dev.
 */
const ENTITY_PROFILE_BASE =
  process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.procur.app';

/**
 * Build the canonical profile URL for an entity. Uses slug for
 * known_entities (stable, human-readable) and UUID for external_suppliers
 * (no slug; UUID is the canonical id).
 *
 * Returns an ABSOLUTE URL anchored on the main app's host so links
 * surfaced through chat work regardless of whether the chat lives
 * on app.procur.app or discover.procur.app — Discover doesn't render
 * entity pages, only the main app does.
 */
export function buildEntityProfileUrl(
  options:
    | { kind: 'known_entity'; slug: string }
    | { kind: 'supplier'; id: string }
    | { kind: 'crude_grade'; slug: string },
): string {
  if (options.kind === 'crude_grade') {
    return `${ENTITY_PROFILE_BASE}/crudes/${options.slug}`;
  }
  const slugOrId = options.kind === 'known_entity' ? options.slug : options.id;
  return `${ENTITY_PROFILE_BASE}/entities/${slugOrId}`;
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


// ===========================================================================
// Layer 3 — distress and motivation signals
// ===========================================================================

export interface DistressedSuppliersSpec {
  /** Optional category filter — match against suppliers whose
      most-recent activity is in this category (uses supplier_signals
      / capability summary columns). v1 only filters by velocity +
      country + news events; the categoryTag arg is reserved for the
      next iteration where we join supplier_capability_summary's
      per-category counts. */
  categoryTag?: string;
  /** Optional country filter (ISO-2). */
  countries?: string[];
  /** Minimum prior-period awards count. Default 3. Filters out
      suppliers who never won much anyway — a velocity drop from 1 to
      0 is noise. */
  minPrevAwards?: number;
  /** Velocity drop threshold. -0.5 means "awards dropped 50%+ vs
      the prior 90-day window". Default -0.5. */
  velocityChangeMax?: number;
  /** Whether to JOIN entity_news_events for each candidate. Default
      true. Set false when the caller doesn't need the contextual
      events (faster). */
  includeNewsEvents?: boolean;
  limit?: number;
}

export interface DistressedSupplier {
  supplierId: string;
  organisationName: string;
  country: string;
  awardsLast90d: number;
  awardsPrev90d: number;
  /** Negative = distress. (last - prev) / prev. */
  velocityChangePct: number;
  valueUsdLast90d: number | null;
  valueUsdPrev90d: number | null;
  mostRecentAwardDate: string;
  /** Recent news events (last 90 days, relevance_score >= 0.5 or
      NULL). Empty array when none / when includeNewsEvents=false. */
  recentNewsEvents: Array<{
    eventType: string;
    eventDate: string;
    summary: string;
    relevanceScore: number | null;
    sourceUrl: string | null;
  }>;
  /** Plain-text reasons this supplier is on the list. */
  distressReasons: string[];
}

/**
 * Suppliers whose award velocity has dropped sharply, optionally
 * joined to recent news events. Powers vex's OriginationPartnerScout
 * agent and the corresponding /api/intelligence/distressed-suppliers
 * endpoint.
 *
 * Velocity is computed in supplier_capability_summary (rolling-window
 * columns added in 0047). News events come from entity_news_events
 * (table from 0048; population gated on ingest workers — empty
 * until SEC EDGAR / PACER / RSS workers ship).
 */
export async function findDistressedSuppliers(
  spec: DistressedSuppliersSpec = {},
): Promise<DistressedSupplier[]> {
  const minPrev = spec.minPrevAwards ?? 3;
  const velMax = spec.velocityChangeMax ?? -0.5;
  const limit = Math.min(spec.limit ?? 25, 100);
  const includeNews = spec.includeNewsEvents !== false;

  const countryFilter =
    spec.countries && spec.countries.length > 0
      ? sql`AND s.country = ANY(ARRAY[${sql.join(
          spec.countries.map((c) => sql`${c}`),
          sql`, `,
        )}]::text[])`
      : sql``;
  const categoryFilter = spec.categoryTag
    ? categoryColumnFilter(spec.categoryTag)
    : sql``;

  const result = await db.execute(sql`
    SELECT
      s.supplier_id,
      s.organisation_name,
      s.country,
      s.awards_last_90d,
      s.awards_prev_90d,
      s.value_usd_last_90d,
      s.value_usd_prev_90d,
      s.most_recent_award_date
    FROM supplier_capability_summary s
    WHERE s.awards_prev_90d >= ${minPrev}
      AND ((s.awards_last_90d::float / NULLIF(s.awards_prev_90d, 0)::float) - 1) <= ${velMax}
      ${countryFilter}
      ${categoryFilter}
    ORDER BY ((s.awards_last_90d::float / NULLIF(s.awards_prev_90d, 0)::float) - 1) ASC,
             s.awards_prev_90d DESC
    LIMIT ${limit}
  `);

  const rows = result.rows as Array<Record<string, unknown>>;
  if (rows.length === 0) return [];

  // Optionally JOIN news events. Single batch query keyed by
  // external_supplier_id rather than N+1 per row.
  const supplierIds = rows.map((r) => String(r.supplier_id));
  const newsBySupplier = new Map<string, DistressedSupplier['recentNewsEvents']>();
  if (includeNews) {
    const newsResult = await db.execute(sql`
      SELECT
        external_supplier_id,
        event_type,
        event_date,
        summary,
        relevance_score,
        source_url
      FROM entity_news_events
      WHERE external_supplier_id = ANY(ARRAY[${sql.join(
        supplierIds.map((id) => sql`${id}`),
        sql`, `,
      )}]::uuid[])
        AND event_date >= CURRENT_DATE - INTERVAL '90 days'
        AND (relevance_score IS NULL OR relevance_score >= 0.5)
      ORDER BY event_date DESC
    `);
    for (const n of newsResult.rows as Array<Record<string, unknown>>) {
      const sid = String(n.external_supplier_id);
      const list = newsBySupplier.get(sid) ?? [];
      list.push({
        eventType: String(n.event_type),
        eventDate:
          n.event_date instanceof Date
            ? n.event_date.toISOString().slice(0, 10)
            : String(n.event_date),
        summary: String(n.summary),
        relevanceScore:
          n.relevance_score != null ? Number.parseFloat(String(n.relevance_score)) : null,
        sourceUrl: n.source_url == null ? null : String(n.source_url),
      });
      newsBySupplier.set(sid, list);
    }
  }

  return rows.map((r) => {
    const last90 = Number(r.awards_last_90d);
    const prev90 = Number(r.awards_prev_90d);
    const velocityChangePct = prev90 > 0 ? (last90 / prev90 - 1) : 0;
    const reasons: string[] = [];
    reasons.push(
      `Awards down ${Math.abs(velocityChangePct * 100).toFixed(0)}% in last 90 days ` +
        `(${last90} vs ${prev90} prior)`,
    );
    const sid = String(r.supplier_id);
    const events = newsBySupplier.get(sid) ?? [];
    for (const e of events.slice(0, 3)) {
      reasons.push(`${e.eventType.replace(/_/g, ' ')} ${e.eventDate}`);
    }
    return {
      supplierId: sid,
      organisationName: String(r.organisation_name),
      country: String(r.country),
      awardsLast90d: last90,
      awardsPrev90d: prev90,
      velocityChangePct,
      valueUsdLast90d:
        r.value_usd_last_90d != null
          ? Number.parseFloat(String(r.value_usd_last_90d))
          : null,
      valueUsdPrev90d:
        r.value_usd_prev_90d != null
          ? Number.parseFloat(String(r.value_usd_prev_90d))
          : null,
      mostRecentAwardDate:
        r.most_recent_award_date instanceof Date
          ? r.most_recent_award_date.toISOString().slice(0, 10)
          : String(r.most_recent_award_date),
      recentNewsEvents: events,
      distressReasons: reasons,
    };
  });
}

/**
 * Map a categoryTag to its supplier_capability_summary count column +
 * filter "supplier has at least 1 award in this category". Keeping
 * this as a tiny helper rather than a dynamic-column lookup so the
 * SQL injection surface is zero.
 */
function categoryColumnFilter(categoryTag: string) {
  switch (categoryTag) {
    case 'petroleum-fuels':
      return sql`AND s.petroleum_awards > 0`;
    case 'crude-oil':
      return sql`AND s.crude_awards > 0`;
    case 'diesel':
      return sql`AND s.diesel_awards > 0`;
    case 'gasoline':
      return sql`AND s.gasoline_awards > 0`;
    case 'jet-fuel':
    case 'aviation-fuels':
      return sql`AND s.jet_awards > 0`;
    case 'lpg':
      return sql`AND s.lpg_awards > 0`;
    case 'marine-bunker':
      return sql`AND s.marine_bunker_awards > 0`;
    case 'food-commodities':
      return sql`AND s.food_awards > 0`;
    case 'vehicles':
      return sql`AND s.vehicle_awards > 0`;
    default:
      return sql``;
  }
}

export interface EntityNewsEventRow {
  id: string;
  knownEntityId: string | null;
  externalSupplierId: string | null;
  sourceEntityName: string;
  sourceEntityCountry: string | null;
  eventType: string;
  eventDate: string;
  summary: string;
  source: string;
  sourceUrl: string | null;
  relevanceScore: number | null;
  ingestedAt: string;
}

/**
 * News events for a single entity, resolved by either the
 * known_entities slug or a free-text fuzzy-name match. Powers
 * /api/intelligence/entity-news/[entitySlug].
 *
 * v1 strategy:
 *   - If `entitySlug` matches a known_entities row → query by
 *     known_entity_id.
 *   - Otherwise fall back to source_entity_name trigram match
 *     (gin_trgm_ops index on the column).
 *
 * Returns events ordered by event_date DESC. Filters to
 * relevance_score >= 0.5 OR NULL by default — set
 * `includeNoise=true` to override (useful for debugging extraction
 * quality).
 */
export async function getEntityNewsEvents(filters: {
  entitySlugOrName: string;
  /** Lookback window in days. Default 365. */
  daysBack?: number;
  includeNoise?: boolean;
  limit?: number;
}): Promise<EntityNewsEventRow[]> {
  const daysBack = filters.daysBack ?? 365;
  const limit = Math.min(filters.limit ?? 50, 200);
  const noiseFilter = filters.includeNoise
    ? sql``
    : sql`AND (relevance_score IS NULL OR relevance_score >= 0.5)`;

  // Resolve slug → known_entity_id when possible.
  const entityRow = await db
    .select({ id: knownEntities.id })
    .from(knownEntities)
    .where(eq(knownEntities.slug, filters.entitySlugOrName))
    .limit(1);

  let scopeFilter;
  if (entityRow.length > 0) {
    scopeFilter = sql`known_entity_id = ${entityRow[0]!.id}::uuid`;
  } else {
    // Fuzzy-name fallback. similarity > 0.4 = lenient enough to catch
    // typical scrape-vs-source name drift without flooding noise.
    scopeFilter = sql`similarity(source_entity_name, ${filters.entitySlugOrName}) > 0.4`;
  }

  const result = await db.execute(sql`
    SELECT
      id, known_entity_id, external_supplier_id,
      source_entity_name, source_entity_country,
      event_type, event_date, summary, source, source_url,
      relevance_score, ingested_at
    FROM entity_news_events
    WHERE ${scopeFilter}
      AND event_date >= CURRENT_DATE - ${daysBack}::int
      ${noiseFilter}
    ORDER BY event_date DESC, ingested_at DESC
    LIMIT ${limit}
  `);

  return (result.rows as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    knownEntityId: r.known_entity_id == null ? null : String(r.known_entity_id),
    externalSupplierId:
      r.external_supplier_id == null ? null : String(r.external_supplier_id),
    sourceEntityName: String(r.source_entity_name),
    sourceEntityCountry:
      r.source_entity_country == null ? null : String(r.source_entity_country),
    eventType: String(r.event_type),
    eventDate:
      r.event_date instanceof Date
        ? r.event_date.toISOString().slice(0, 10)
        : String(r.event_date),
    summary: String(r.summary),
    source: String(r.source),
    sourceUrl: r.source_url == null ? null : String(r.source_url),
    relevanceScore:
      r.relevance_score != null ? Number.parseFloat(String(r.relevance_score)) : null,
    ingestedAt:
      r.ingested_at instanceof Date
        ? r.ingested_at.toISOString()
        : String(r.ingested_at),
  }));
}

// ===========================================================================
// Competitor overview — companies operating in VTC's lane
// ===========================================================================

export interface CompetitorOverviewRow {
  knownEntityId: string;
  slug: string;
  name: string;
  country: string;
  role: string;
  categories: string[];
  tags: string[];
  notes: string | null;
  headquarters: string | null;
  /** External-supplier id we matched the competitor to (via name fuzzy
      match against external_suppliers). NULL when no public-tender
      footprint links the competitor. Drives the activity numbers. */
  matchedSupplierId: string | null;
  totalAwards: number;
  totalValueUsd: number | null;
  awardsLast90d: number;
  awardsPrev90d: number;
  velocityChangePct: number | null;
  mostRecentAwardDate: string | null;
  /** entity_news_events count over the lookback window — distress
      signals, bankruptcies, press mentions, leadership changes. */
  newsEventsLast90d: number;
  /** Most recent news event title (truncated). NULL when no events. */
  mostRecentNewsTitle: string | null;
  mostRecentNewsDate: string | null;
}

export interface RecentCompetitorNewsItem {
  id: string;
  knownEntityId: string | null;
  knownEntitySlug: string | null;
  knownEntityName: string | null;
  sourceEntityName: string;
  eventType: string;
  eventDate: string;
  summary: string;
  source: string;
  sourceUrl: string | null;
  relevanceScore: number | null;
}

/**
 * Roll up the competitor universe — every known_entities row tagged
 * 'competitor' (or role='trader' as the looser fallback). For each,
 * surfaces:
 *   - public-tender activity: total awards + total value + last/prev
 *     90d velocity, joined via fuzzy-name match to external_suppliers
 *     (most major trading houses don't appear in public-procurement
 *     data, so these stats are typically zero — we still want the
 *     row in the dashboard with a "no public-tender activity" state).
 *   - news event activity: count of entity_news_events rows in the
 *     last 90 days + the most recent one's title/date.
 *
 * Powers /suppliers/competitors. Lookups all batched — one query
 * per data source then merged in JS.
 */
export async function getCompetitorOverview(filters: {
  category?: string;
  country?: string;
  /** When 'curated' (default), require the 'competitor' tag.
      When 'all-traders', include any role='trader' even without
      explicit competitor tagging. */
  scope?: 'curated' | 'all-traders';
} = {}): Promise<CompetitorOverviewRow[]> {
  const scope = filters.scope ?? 'curated';

  const scopeFilter = scope === 'curated'
    ? sql`AND ('competitor' = ANY(tags))`
    : sql`AND (role = 'trader' OR 'competitor' = ANY(tags))`;
  const categoryFilter = filters.category
    ? sql`AND ${filters.category} = ANY(categories)`
    : sql``;
  const countryFilter = filters.country
    ? sql`AND country = ${filters.country.toUpperCase()}`
    : sql``;

  const entitiesResult = await db.execute(sql`
    SELECT id, slug, name, country, role, categories, tags, notes, metadata
    FROM known_entities
    WHERE 1 = 1
      ${scopeFilter}
      ${categoryFilter}
      ${countryFilter}
    ORDER BY
      ('top-tier' = ANY(tags))::int DESC,
      ('state-affiliated' = ANY(tags))::int DESC,
      name ASC
  `);

  const entities = (entitiesResult.rows as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    slug: String(r.slug),
    name: String(r.name),
    country: String(r.country),
    role: String(r.role),
    categories: (r.categories as string[]) ?? [],
    tags: (r.tags as string[]) ?? [],
    notes: r.notes != null ? String(r.notes) : null,
    metadata: (r.metadata as Record<string, unknown> | null) ?? null,
  }));
  if (entities.length === 0) return [];

  // Fuzzy-match each entity against external_suppliers via trigram on
  // the supplier's organisation name. similarity > 0.55 keeps the
  // false-positive rate low; aliases (also stored on known_entities)
  // could bump recall in v2. One query — left join + DISTINCT ON.
  const names = entities.map((e) => e.name);
  const supplierLinks = await db.execute(sql`
    WITH e AS (
      SELECT unnest(${pgArray(names)}) AS entity_name
    ),
    matched AS (
      SELECT DISTINCT ON (e.entity_name)
        e.entity_name,
        s.id AS supplier_id,
        similarity(s.organisation_name, e.entity_name) AS sim
      FROM e
      JOIN external_suppliers s
        ON similarity(s.organisation_name, e.entity_name) > 0.55
      ORDER BY e.entity_name, sim DESC
    )
    SELECT entity_name, supplier_id FROM matched
  `);
  const supplierByName = new Map<string, string>();
  for (const row of supplierLinks.rows as Array<Record<string, unknown>>) {
    supplierByName.set(String(row.entity_name), String(row.supplier_id));
  }

  // Fetch capability-summary rows for the matched supplier ids.
  const supplierIds = Array.from(supplierByName.values());
  const capByCounter = new Map<string, {
    totalAwards: number;
    totalValueUsd: number | null;
    awardsLast90d: number;
    awardsPrev90d: number;
    mostRecentAwardDate: string | null;
  }>();
  if (supplierIds.length > 0) {
    const capResult = await db.execute(sql`
      SELECT
        supplier_id, total_awards, total_value_usd,
        awards_last_90d, awards_prev_90d, most_recent_award_date
      FROM supplier_capability_summary
      WHERE supplier_id = ANY(${pgArray(supplierIds, 'uuid')})
    `);
    for (const row of capResult.rows as Array<Record<string, unknown>>) {
      capByCounter.set(String(row.supplier_id), {
        totalAwards: Number(row.total_awards ?? 0),
        totalValueUsd: row.total_value_usd != null ? Number.parseFloat(String(row.total_value_usd)) : null,
        awardsLast90d: Number(row.awards_last_90d ?? 0),
        awardsPrev90d: Number(row.awards_prev_90d ?? 0),
        mostRecentAwardDate:
          row.most_recent_award_date instanceof Date
            ? row.most_recent_award_date.toISOString().slice(0, 10)
            : row.most_recent_award_date == null ? null : String(row.most_recent_award_date),
      });
    }
  }

  // News events count + most recent per entity. Single batched query.
  const entityIds = entities.map((e) => e.id);
  const newsResult = await db.execute(sql`
    SELECT
      known_entity_id,
      COUNT(*) FILTER (WHERE event_date >= CURRENT_DATE - INTERVAL '90 days') AS events_90d,
      (
        SELECT json_build_object(
          'summary', summary,
          'event_date', event_date,
          'event_type', event_type
        )
        FROM entity_news_events e2
        WHERE e2.known_entity_id = e1.known_entity_id
          AND (relevance_score IS NULL OR relevance_score >= 0.5)
        ORDER BY event_date DESC
        LIMIT 1
      ) AS most_recent
    FROM entity_news_events e1
    WHERE known_entity_id = ANY(${pgArray(entityIds, 'uuid')})
      AND (relevance_score IS NULL OR relevance_score >= 0.5)
    GROUP BY known_entity_id
  `);
  const newsByEntity = new Map<string, {
    eventsLast90d: number;
    mostRecentTitle: string | null;
    mostRecentDate: string | null;
  }>();
  for (const row of newsResult.rows as Array<Record<string, unknown>>) {
    const recent = (row.most_recent as { summary?: string; event_date?: string } | null) ?? null;
    newsByEntity.set(String(row.known_entity_id), {
      eventsLast90d: Number(row.events_90d ?? 0),
      mostRecentTitle: recent?.summary ? recent.summary.slice(0, 200) : null,
      mostRecentDate: recent?.event_date ?? null,
    });
  }

  return entities.map((e) => {
    const supplierId = supplierByName.get(e.name) ?? null;
    const cap = supplierId ? capByCounter.get(supplierId) : null;
    const news = newsByEntity.get(e.id);
    const headquarters = ((e.metadata as { headquarters?: string } | null) ?? null)?.headquarters ?? null;
    const velocity =
      cap && cap.awardsPrev90d > 0
        ? cap.awardsLast90d / cap.awardsPrev90d - 1
        : null;
    return {
      knownEntityId: e.id,
      slug: e.slug,
      name: e.name,
      country: e.country,
      role: e.role,
      categories: e.categories,
      tags: e.tags,
      notes: e.notes,
      headquarters,
      matchedSupplierId: supplierId,
      totalAwards: cap?.totalAwards ?? 0,
      totalValueUsd: cap?.totalValueUsd ?? null,
      awardsLast90d: cap?.awardsLast90d ?? 0,
      awardsPrev90d: cap?.awardsPrev90d ?? 0,
      velocityChangePct: velocity,
      mostRecentAwardDate: cap?.mostRecentAwardDate ?? null,
      newsEventsLast90d: news?.eventsLast90d ?? 0,
      mostRecentNewsTitle: news?.mostRecentTitle ?? null,
      mostRecentNewsDate: news?.mostRecentDate ?? null,
    };
  });
}

/**
 * Recent news events across all competitor entities. Powers the
 * "Recent news" feed at the bottom of /suppliers/competitors. Joins
 * known_entities so the renderer can deep-link to the unified
 * profile page.
 */
export async function getRecentCompetitorNews(filters: {
  daysBack?: number;
  limit?: number;
} = {}): Promise<RecentCompetitorNewsItem[]> {
  const daysBack = filters.daysBack ?? 30;
  const limit = Math.min(filters.limit ?? 30, 100);

  const result = await db.execute(sql`
    SELECT
      n.id,
      n.known_entity_id,
      ke.slug AS known_entity_slug,
      ke.name AS known_entity_name,
      n.source_entity_name,
      n.event_type,
      n.event_date,
      n.summary,
      n.source,
      n.source_url,
      n.relevance_score
    FROM entity_news_events n
    JOIN known_entities ke ON ke.id = n.known_entity_id
    WHERE 'competitor' = ANY(ke.tags)
      AND n.event_date >= CURRENT_DATE - ${daysBack}::int
      AND (n.relevance_score IS NULL OR n.relevance_score >= 0.5)
    ORDER BY n.event_date DESC, n.ingested_at DESC
    LIMIT ${limit}
  `);

  return (result.rows as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    knownEntityId: r.known_entity_id == null ? null : String(r.known_entity_id),
    knownEntitySlug: r.known_entity_slug == null ? null : String(r.known_entity_slug),
    knownEntityName: r.known_entity_name == null ? null : String(r.known_entity_name),
    sourceEntityName: String(r.source_entity_name),
    eventType: String(r.event_type),
    eventDate:
      r.event_date instanceof Date
        ? r.event_date.toISOString().slice(0, 10)
        : String(r.event_date),
    summary: String(r.summary),
    source: String(r.source),
    sourceUrl: r.source_url == null ? null : String(r.source_url),
    relevanceScore:
      r.relevance_score != null ? Number.parseFloat(String(r.relevance_score)) : null,
  }));
}

// ===========================================================================
// Vessel intelligence — map data
// ===========================================================================

export interface VesselMapPoint {
  mmsi: string;
  vesselName: string | null;
  imo: string | null;
  shipTypeLabel: string | null;
  flagCountry: string | null;
  /** Most recent position. */
  lat: number;
  lng: number;
  speedKnots: number | null;
  timestamp: string;
  /** Up to 20 prior position points for the vessel's recent trail.
      Ordered oldest → newest so polyline rendering is straight. */
  trail: Array<{ lat: number; lng: number; timestamp: string }>;
}

export interface PortMapPoint {
  slug: string;
  name: string;
  country: string;
  portType: string;
  lat: number;
  lng: number;
  geofenceRadiusNm: number;
}

/**
 * Recent vessel positions, grouped by MMSI, with up to 20 trail
 * points each. Powers the /suppliers/vessels map.
 *
 * Strategy:
 *   1. Pull DISTINCT ON (mmsi) latest position (1 row per vessel) —
 *      drives the marker placement.
 *   2. For the same vessels, pull last 20 positions ordered oldest-
 *      first to draw the trail polyline.
 *   3. Optional bbox filter on the latest position so we don't ship
 *      thousands of vessel rows to the client when the user is
 *      looking at one region.
 *
 * Both queries hit the (mmsi, timestamp DESC) index from the schema.
 * 1000-vessel cap on the latest-position step to keep the wire
 * payload bounded.
 */
export async function getRecentVesselTracks(filters: {
  /** Lookback in days. Default 7 (catches active tankers; older than
      a week typically means the vessel has left the bbox). */
  daysBack?: number;
  /** Cap on number of distinct MMSIs returned. Default 500, max 2000. */
  limit?: number;
  /** Optional [[latSW, lngSW], [latNE, lngNE]]. */
  bbox?: [[number, number], [number, number]];
  /** Trail length per vessel. Default 20, max 50. */
  trailLength?: number;
}): Promise<VesselMapPoint[]> {
  const daysBack = filters.daysBack ?? 7;
  const limit = Math.min(filters.limit ?? 500, 2000);
  const trailLength = Math.min(filters.trailLength ?? 20, 50);

  const bboxFilter = filters.bbox
    ? sql`AND lat::numeric BETWEEN ${filters.bbox[0][0]} AND ${filters.bbox[1][0]}
            AND lng::numeric BETWEEN ${filters.bbox[0][1]} AND ${filters.bbox[1][1]}`
    : sql``;

  // Step 1 — latest position per MMSI.
  const latestResult = await db.execute(sql`
    WITH latest AS (
      SELECT DISTINCT ON (mmsi)
        mmsi, lat::numeric AS lat, lng::numeric AS lng,
        speed_knots::numeric AS speed_knots, timestamp
      FROM vessel_positions
      WHERE timestamp >= NOW() - (${daysBack}::int * INTERVAL '1 day')
      ORDER BY mmsi, timestamp DESC
    )
    SELECT
      l.mmsi, l.lat, l.lng, l.speed_knots, l.timestamp,
      v.name AS vessel_name, v.imo, v.ship_type_label, v.flag_country
    FROM latest l
    LEFT JOIN vessels v ON v.mmsi = l.mmsi
    WHERE 1 = 1 ${bboxFilter}
    ORDER BY l.timestamp DESC
    LIMIT ${limit}
  `);

  const latestRows = latestResult.rows as Array<Record<string, unknown>>;
  if (latestRows.length === 0) return [];

  const mmsis = latestRows.map((r) => String(r.mmsi));

  // Step 2 — last N positions for the trail. Keep ordered
  // chronologically (oldest first) so the consumer can draw the
  // polyline without re-sorting.
  const trailResult = await db.execute(sql`
    SELECT mmsi, lat::numeric AS lat, lng::numeric AS lng, timestamp
    FROM (
      SELECT mmsi, lat, lng, timestamp,
        ROW_NUMBER() OVER (PARTITION BY mmsi ORDER BY timestamp DESC) AS rn
      FROM vessel_positions
      WHERE mmsi = ANY(${pgArray(mmsis)})
        AND timestamp >= NOW() - (${daysBack}::int * INTERVAL '1 day')
    ) sub
    WHERE rn <= ${trailLength}
    ORDER BY mmsi, timestamp ASC
  `);

  const trailByMmsi = new Map<string, Array<{ lat: number; lng: number; timestamp: string }>>();
  for (const r of trailResult.rows as Array<Record<string, unknown>>) {
    const m = String(r.mmsi);
    const arr = trailByMmsi.get(m) ?? [];
    arr.push({
      lat: Number.parseFloat(String(r.lat)),
      lng: Number.parseFloat(String(r.lng)),
      timestamp:
        r.timestamp instanceof Date
          ? r.timestamp.toISOString()
          : String(r.timestamp),
    });
    trailByMmsi.set(m, arr);
  }

  return latestRows.map((r) => {
    const mmsi = String(r.mmsi);
    return {
      mmsi,
      vesselName: r.vessel_name == null ? null : String(r.vessel_name),
      imo: r.imo == null ? null : String(r.imo),
      shipTypeLabel: r.ship_type_label == null ? null : String(r.ship_type_label),
      flagCountry: r.flag_country == null ? null : String(r.flag_country),
      lat: Number.parseFloat(String(r.lat)),
      lng: Number.parseFloat(String(r.lng)),
      speedKnots: r.speed_knots != null ? Number.parseFloat(String(r.speed_knots)) : null,
      timestamp:
        r.timestamp instanceof Date
          ? r.timestamp.toISOString()
          : String(r.timestamp),
      trail: trailByMmsi.get(mmsi) ?? [],
    };
  });
}

/**
 * Ports for the map view. Tiny query — the table is hand-seeded and
 * has dozens of rows, not thousands. No filters needed; the client
 * styles by `portType`.
 */
export async function getPortsForMap(filters: {
  types?: Array<'crude-loading' | 'refinery' | 'transshipment' | 'mixed'>;
} = {}): Promise<PortMapPoint[]> {
  const typeFilter =
    filters.types && filters.types.length > 0
      ? sql`WHERE port_type = ANY(${pgArray(filters.types)})`
      : sql``;
  const result = await db.execute(sql`
    SELECT
      slug, name, country, port_type,
      lat::numeric AS lat, lng::numeric AS lng,
      geofence_radius_nm::numeric AS radius_nm
    FROM ports
    ${typeFilter}
    ORDER BY name ASC
  `);
  return (result.rows as Array<Record<string, unknown>>).map((r) => ({
    slug: String(r.slug),
    name: String(r.name),
    country: String(r.country),
    portType: String(r.port_type),
    lat: Number.parseFloat(String(r.lat)),
    lng: Number.parseFloat(String(r.lng)),
    geofenceRadiusNm: Number.parseFloat(String(r.radius_nm)),
  }));
}

// ===========================================================================
// Entity vessel activity — port-call rollup near a refinery / terminal
// ===========================================================================

export interface EntityVesselActivity {
  /** Tanker calls in the last 24 hours / 7 days / 30 days at any
      port within `radiusNm` of the entity. A "call" is a unique
      (mmsi × port × continuous-cluster). */
  callsLast24h: number;
  callsLast7d: number;
  callsLast30d: number;
  /** Ports within radiusNm that any tanker actually called at,
      ranked by 7-day call count. Empty when the entity sits far
      from any seeded port. */
  nearbyPorts: Array<{
    slug: string;
    name: string;
    distanceNm: number;
    calls7d: number;
    calls30d: number;
  }>;
  /** Most recent calls (10 by default) for the activity timeline. */
  recentVessels: Array<{
    mmsi: string;
    vesselName: string | null;
    flagCountry: string | null;
    portSlug: string;
    portName: string;
    arrivalAt: string;
    lastSeenAt: string;
  }>;
}

/**
 * Vessel activity at the ports nearest a given entity (refinery,
 * terminal, port). Powers the per-entity vessel section on
 * /entities/[slug].
 *
 * Strategy:
 *   1. Find ports within `radiusNm` of the entity's coordinates
 *      (default 50 nm — wide enough to catch the actual loading/
 *      discharge port even when the entity's lat/lng is its
 *      headquarters rather than the dock).
 *   2. For those ports, derive port calls the same way
 *      findRecentPortCalls does — geofence-radius + slow-speed
 *      cluster — over a 30-day window.
 *   3. Aggregate per-port counts; aggregate global 24h/7d/30d totals;
 *      emit the 10 most recent calls.
 *
 * Skips entirely when no port is in range (returns zeros + empty
 * arrays). The caller decides whether to render an empty state.
 */
export async function getEntityVesselActivity(args: {
  lat: number;
  lng: number;
  /** Default 50 nm (wide; includes headquarters-vs-dock offset). */
  radiusNm?: number;
  /** Default 30; lookback for the long-window count + ranking. */
  daysBack?: number;
  /** Default 10; cap on recentVessels. */
  recentLimit?: number;
}): Promise<EntityVesselActivity> {
  const radius = args.radiusNm ?? 50;
  const daysBack = args.daysBack ?? 30;
  const recentLimit = Math.min(args.recentLimit ?? 10, 50);

  if (
    !Number.isFinite(args.lat) ||
    !Number.isFinite(args.lng) ||
    Math.abs(args.lat) > 90 ||
    Math.abs(args.lng) > 180
  ) {
    return {
      callsLast24h: 0,
      callsLast7d: 0,
      callsLast30d: 0,
      nearbyPorts: [],
      recentVessels: [],
    };
  }

  // Aggregate — single query with window-of-window CTEs. Uses the
  // existing equirectangular distance approximation (acceptable
  // <0.5 nm error at typical port latitudes).
  const result = await db.execute(sql`
    WITH nearby_ports AS (
      SELECT slug, name,
        lat::numeric AS lat,
        lng::numeric AS lng,
        geofence_radius_nm::numeric AS port_radius_nm,
        SQRT(
          POW((lat::numeric - ${args.lat}) * 60, 2) +
          POW((lng::numeric - ${args.lng}) * 60 * COS(RADIANS(${args.lat})), 2)
        ) AS distance_nm
      FROM ports
    ),
    in_range AS (
      SELECT * FROM nearby_ports WHERE distance_nm <= ${radius}
    ),
    matches AS (
      SELECT
        p.mmsi,
        p.timestamp,
        ir.slug AS port_slug,
        ir.name AS port_name,
        ir.distance_nm
      FROM vessel_positions p
      JOIN in_range ir
        ON SQRT(
          POW((p.lat::numeric - ir.lat) * 60, 2) +
          POW((p.lng::numeric - ir.lng) * 60 * COS(RADIANS(ir.lat)), 2)
        ) <= ir.port_radius_nm
      WHERE p.timestamp >= NOW() - (${daysBack}::int * INTERVAL '1 day')
        AND (p.speed_knots IS NULL OR p.speed_knots::numeric < 2)
    ),
    calls AS (
      SELECT
        mmsi,
        port_slug,
        MIN(port_name) AS port_name,
        MIN(distance_nm) AS distance_nm,
        MIN(timestamp) AS arrival_at,
        MAX(timestamp) AS last_seen_at
      FROM matches
      GROUP BY mmsi, port_slug
    )
    SELECT
      json_build_object(
        'totals', json_build_object(
          'calls24h', COALESCE((SELECT COUNT(*) FROM calls WHERE arrival_at >= NOW() - INTERVAL '24 hours'), 0),
          'calls7d',  COALESCE((SELECT COUNT(*) FROM calls WHERE arrival_at >= NOW() - INTERVAL '7 days'), 0),
          'calls30d', COALESCE((SELECT COUNT(*) FROM calls), 0)
        ),
        'nearbyPorts', COALESCE((
          SELECT json_agg(p) FROM (
            SELECT
              port_slug AS slug,
              port_name AS name,
              MIN(distance_nm) AS "distanceNm",
              COUNT(*) FILTER (WHERE arrival_at >= NOW() - INTERVAL '7 days') AS calls7d,
              COUNT(*) AS calls30d
            FROM calls
            GROUP BY port_slug, port_name
            ORDER BY calls7d DESC, calls30d DESC
          ) p
        ), '[]'::json),
        'recentVessels', COALESCE((
          SELECT json_agg(r) FROM (
            SELECT
              c.mmsi,
              v.name AS "vesselName",
              v.flag_country AS "flagCountry",
              c.port_slug AS "portSlug",
              c.port_name AS "portName",
              c.arrival_at AS "arrivalAt",
              c.last_seen_at AS "lastSeenAt"
            FROM calls c
            LEFT JOIN vessels v ON v.mmsi = c.mmsi
            ORDER BY c.last_seen_at DESC
            LIMIT ${recentLimit}
          ) r
        ), '[]'::json)
      ) AS payload
  `);

  const row = (result.rows as Array<Record<string, unknown>>)[0];
  const payload = (row?.payload as {
    totals?: { calls24h: number; calls7d: number; calls30d: number };
    nearbyPorts?: Array<{ slug: string; name: string; distanceNm: number | string; calls7d: number; calls30d: number }>;
    recentVessels?: Array<{
      mmsi: string;
      vesselName: string | null;
      flagCountry: string | null;
      portSlug: string;
      portName: string;
      arrivalAt: string;
      lastSeenAt: string;
    }>;
  }) ?? null;

  return {
    callsLast24h: Number(payload?.totals?.calls24h ?? 0),
    callsLast7d: Number(payload?.totals?.calls7d ?? 0),
    callsLast30d: Number(payload?.totals?.calls30d ?? 0),
    nearbyPorts: (payload?.nearbyPorts ?? []).map((p) => ({
      slug: p.slug,
      name: p.name,
      distanceNm: Number.parseFloat(String(p.distanceNm)),
      calls7d: Number(p.calls7d),
      calls30d: Number(p.calls30d),
    })),
    recentVessels: payload?.recentVessels ?? [],
  };
}

// ===========================================================================
// Per-buyer-entity pricing rollup
// ===========================================================================

export interface BuyerEntityPricingProfile {
  buyerEntityId: string;
  legalName: string;
  avgDeltaPct: number | null;
  medianDeltaPct: number | null;
  stddevDeltaPct: number | null;
  sampleSize: number;
  byCategory: Array<{
    categoryTag: string;
    avgDeltaPct: number | null;
    sampleSize: number;
  }>;
}

/**
 * Pricing rollup for a single buyer entity across every category
 * they appear in. Used by the vex /buyer-pricing endpoint, which
 * keys by entity rather than (country × category).
 *
 * `buyer_entity_id` here is just `buyer:{COUNTRY}:{slug-name}`
 * synthesised by /find-buyers — we resolve back to the buyer_name
 * portion to query award_price_deltas.
 *
 * Honors the same minConfidence + daysBack defaults as
 * analyzeBuyerPricing for stylistic parity.
 */
export async function analyzeBuyerEntityPricing(filters: {
  buyerName: string;
  minConfidence?: number;
  daysBack?: number;
}): Promise<BuyerEntityPricingProfile> {
  const minConfidence = filters.minConfidence ?? 0.6;
  const daysBack = filters.daysBack ?? 1095;

  const aggResult = await db.execute(sql`
    SELECT
      COUNT(*)::int                                              AS sample_size,
      AVG(delta_pct)                                             AS avg_pct,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY delta_pct)     AS median_pct,
      stddev_samp(delta_pct)                                     AS stddev_pct
    FROM award_price_deltas
    WHERE LOWER(buyer_name) = LOWER(${filters.buyerName})
      AND overall_confidence >= ${minConfidence}::numeric
      AND award_date >= CURRENT_DATE - (${daysBack}::int * INTERVAL '1 day')
      AND delta_pct IS NOT NULL;
  `);
  const agg = (aggResult.rows as Array<Record<string, unknown>>)[0] ?? {};

  const catResult = await db.execute(sql`
    SELECT
      tag                                                        AS category_tag,
      COUNT(*)::int                                              AS sample_size,
      AVG(delta_pct)                                             AS avg_pct
    FROM award_price_deltas, unnest(category_tags) AS tag
    WHERE LOWER(buyer_name) = LOWER(${filters.buyerName})
      AND overall_confidence >= ${minConfidence}::numeric
      AND award_date >= CURRENT_DATE - (${daysBack}::int * INTERVAL '1 day')
      AND delta_pct IS NOT NULL
    GROUP BY tag
    ORDER BY COUNT(*) DESC;
  `);
  const byCategory = (catResult.rows as Array<Record<string, unknown>>).map((r) => ({
    categoryTag: String(r.category_tag),
    avgDeltaPct:
      r.avg_pct != null ? Number.parseFloat(String(r.avg_pct)) : null,
    sampleSize: Number(r.sample_size ?? 0),
  }));

  return {
    buyerEntityId: `buyer:${filters.buyerName.toLowerCase().replace(/\s+/g, '-')}`,
    legalName: filters.buyerName,
    avgDeltaPct:
      agg.avg_pct != null ? Number.parseFloat(String(agg.avg_pct)) : null,
    medianDeltaPct:
      agg.median_pct != null ? Number.parseFloat(String(agg.median_pct)) : null,
    stddevDeltaPct:
      agg.stddev_pct != null ? Number.parseFloat(String(agg.stddev_pct)) : null,
    sampleSize: Number(agg.sample_size ?? 0),
    byCategory,
  };
}

// ===========================================================================
// Crude basis differentials — named crudes → marker + live spot
// ===========================================================================

export interface CrudeBasisQuote {
  gradeSlug: string;
  gradeName: string;
  /** NULL when the grade is itself a marker. */
  markerSlug: string | null;
  markerName: string | null;
  /** USD/bbl. Positive = grade trades above marker; negative = below. */
  differentialUsdPerBbl: number | null;
  /** Live marker spot pulled from commodity_prices. NULL when the
      marker has no ingested feed (Dubai, for instance, isn't in
      our FRED/EIA pulls today). */
  markerSpotUsdPerBbl: number | null;
  markerAsOf: string | null;
  /** All-in fair-value estimate: markerSpot + differential. NULL
      when either input is missing. */
  fairValueUsdPerBbl: number | null;
  notes: string | null;
}

/**
 * Resolve a named crude grade to its pricing marker + live spot +
 * structural differential. Powers the `get_crude_basis` chat tool.
 *
 * For marker grades (Brent / WTI / Dubai / Urals): returns the
 * grade's own spot (since they're priced directly, not as a basis).
 *
 * For non-marker grades: looks up markerSlug + differential from
 * crude_grades, fetches the marker's most-recent spot from
 * commodity_prices, and computes fair value = spot + differential.
 *
 * Returns null when the grade slug doesn't exist.
 */
export async function getCrudeBasis(
  gradeSlug: string,
): Promise<CrudeBasisQuote | null> {
  const result = await db.execute(sql`
    WITH g AS (
      SELECT slug, name, is_marker, marker_slug,
             differential_usd_per_bbl, notes
      FROM crude_grades
      WHERE slug = ${gradeSlug}
      LIMIT 1
    ),
    marker AS (
      SELECT slug, name FROM crude_grades
      WHERE slug = (SELECT marker_slug FROM g)
      LIMIT 1
    ),
    spot_self AS (
      SELECT price::numeric AS price, price_date
      FROM commodity_prices
      WHERE series_slug = (SELECT slug FROM g)
        AND contract_type = 'spot'
      ORDER BY price_date DESC
      LIMIT 1
    ),
    spot_marker AS (
      SELECT price::numeric AS price, price_date
      FROM commodity_prices
      WHERE series_slug = (SELECT slug FROM marker)
        AND contract_type = 'spot'
      ORDER BY price_date DESC
      LIMIT 1
    )
    SELECT
      g.slug, g.name, g.is_marker,
      g.marker_slug,
      m.name AS marker_name,
      g.differential_usd_per_bbl,
      g.notes,
      CASE WHEN g.is_marker
           THEN (SELECT price FROM spot_self)
           ELSE (SELECT price FROM spot_marker)
      END AS marker_spot,
      CASE WHEN g.is_marker
           THEN (SELECT price_date::text FROM spot_self)
           ELSE (SELECT price_date::text FROM spot_marker)
      END AS marker_as_of
    FROM g
    LEFT JOIN marker m ON true;
  `);

  const row = (result.rows as Array<Record<string, unknown>>)[0];
  if (!row) return null;

  const isMarker = row.is_marker === true;
  const markerSpot =
    row.marker_spot != null ? Number.parseFloat(String(row.marker_spot)) : null;
  const differential =
    row.differential_usd_per_bbl != null
      ? Number.parseFloat(String(row.differential_usd_per_bbl))
      : null;
  // For markers: fair value = own spot. For non-markers: marker
  // spot + differential. Either input being null collapses fair
  // value to null.
  const fairValue = isMarker
    ? markerSpot
    : markerSpot != null && differential != null
      ? markerSpot + differential
      : null;

  return {
    gradeSlug: String(row.slug),
    gradeName: String(row.name),
    markerSlug: isMarker ? null : (row.marker_slug == null ? null : String(row.marker_slug)),
    markerName: isMarker ? null : (row.marker_name == null ? null : String(row.marker_name)),
    differentialUsdPerBbl: isMarker ? null : differential,
    markerSpotUsdPerBbl: markerSpot,
    markerAsOf: row.marker_as_of == null ? null : String(row.marker_as_of),
    fairValueUsdPerBbl: fairValue,
    notes: row.notes == null ? null : String(row.notes),
  };
}

// ===========================================================================
// Cargo inference — pair load→discharge port calls into cargo trips
// ===========================================================================

export interface CargoTrip {
  /** Synthetic id stable across runs: `${mmsi}:${loadSlug}:${dischargeSlug}:${loadedAt}` */
  cargoId: string;
  mmsi: string;
  vesselName: string | null;
  flagCountry: string | null;
  /** Loading-port leg. */
  loadPortSlug: string;
  loadPortName: string;
  loadPortCountry: string;
  loadedAt: string;
  /** Discharge-port leg. */
  dischargePortSlug: string;
  dischargePortName: string;
  dischargePortCountry: string;
  arrivedAt: string;
  transitDays: number;
  /**
   * 'strong'  : both ends in known crude/refinery ports, transit-time plausible
   * 'medium'  : ports include 'mixed' on at least one end OR transit borderline
   * 'weak'    : edge cases (vessel revisits same port; very short transit)
   */
  confidence: 'strong' | 'medium' | 'weak';
}

/**
 * Infer cargo trips from AIS port-call clusters, pairing each
 * vessel's consecutive (load → discharge) calls. Pure SQL; no
 * materialized layer. Powers the /api/intelligence/cargoes
 * endpoint when the AIS feed has coverage.
 *
 * Method:
 *   1. Re-use the geofence-cluster logic from findRecentPortCalls
 *      to derive port calls (mmsi × port × cluster) over the lookback.
 *   2. ROW_NUMBER() OVER (PARTITION BY mmsi ORDER BY arrival_at) to
 *      enumerate each vessel's call sequence.
 *   3. Self-join on (mmsi, rn = next.rn-1) to pair each call with its
 *      next call. Filter to (load_type, discharge_type) compatible
 *      pairs.
 *   4. Guardrails: discharge.arrived > load.last_seen,
 *      transit ≥ 1 day, transit ≤ 90 days. (Sub-day pairs are
 *      typically lightering / inland transfers, not cargoes.
 *      Over 90 = vessel left the bbox and re-entered; not a single
 *      cargo trip.)
 *
 * Confidence ladder:
 *   'strong'  : load.port_type='crude-loading' AND discharge.port_type='refinery'
 *   'medium'  : either end is 'mixed' OR 'transshipment'
 *   'weak'    : otherwise (catch-all)
 *
 * Order: most-recent arrivedAt first.
 */
export async function inferCargoTripsFromAis(filters: {
  /** Lookback in days. Default 30. Capped at 365. */
  daysBack?: number;
  /** ISO-2 destination filter (matches discharge_port_country). */
  destinationCountry?: string;
  /** ISO-2 origin filter (matches load_port_country). */
  originCountry?: string;
  /** Default 'weak'. Filter rows whose confidence is at or above this. */
  minConfidence?: 'weak' | 'medium' | 'strong';
  /** Cap rows. Default 100, max 500. */
  limit?: number;
}): Promise<CargoTrip[]> {
  const daysBack = Math.min(filters.daysBack ?? 30, 365);
  const limit = Math.min(filters.limit ?? 100, 500);
  const minConfidence = filters.minConfidence ?? 'weak';

  const destinationFilter = filters.destinationCountry
    ? sql`AND d.port_country = ${filters.destinationCountry.toUpperCase()}`
    : sql``;
  const originFilter = filters.originCountry
    ? sql`AND l.port_country = ${filters.originCountry.toUpperCase()}`
    : sql``;
  const confidenceRank: Record<string, number> = {
    weak: 0,
    medium: 1,
    strong: 2,
  };
  const minRank = confidenceRank[minConfidence] ?? 0;

  const result = await db.execute(sql`
    WITH calls AS (
      -- Per-mmsi port-call clusters via geofence + slow-speed.
      -- Same shape as findRecentPortCalls' inner CTE.
      SELECT
        p.mmsi,
        sp.slug    AS port_slug,
        sp.name    AS port_name,
        sp.country AS port_country,
        sp.port_type,
        MIN(p.timestamp) AS arrival_at,
        MAX(p.timestamp) AS last_seen_at
      FROM vessel_positions p
      JOIN ports sp
        ON SQRT(
            POW((p.lat::numeric - sp.lat::numeric) * 60, 2) +
            POW((p.lng::numeric - sp.lng::numeric) * 60 * COS(RADIANS(sp.lat::numeric)), 2)
           ) <= sp.geofence_radius_nm::numeric
      WHERE p.timestamp >= NOW() - (${daysBack}::int * INTERVAL '1 day')
        AND (p.speed_knots IS NULL OR p.speed_knots::numeric < 2)
      GROUP BY p.mmsi, sp.slug, sp.name, sp.country, sp.port_type
    ),
    enumerated AS (
      SELECT *,
        ROW_NUMBER() OVER (PARTITION BY mmsi ORDER BY arrival_at) AS rn
      FROM calls
    ),
    pairs AS (
      SELECT
        l.mmsi,
        l.port_slug    AS load_port_slug,
        l.port_name    AS load_port_name,
        l.port_country AS load_port_country,
        l.port_type    AS load_port_type,
        l.last_seen_at AS loaded_at,
        d.port_slug    AS discharge_port_slug,
        d.port_name    AS discharge_port_name,
        d.port_country AS discharge_port_country,
        d.port_type    AS discharge_port_type,
        d.arrival_at   AS arrived_at,
        EXTRACT(EPOCH FROM (d.arrival_at - l.last_seen_at)) / 86400 AS transit_days
      FROM enumerated l
      JOIN enumerated d
        ON d.mmsi = l.mmsi
       AND d.rn   = l.rn + 1
      WHERE l.port_type IN ('crude-loading', 'mixed')
        AND d.port_type IN ('refinery', 'transshipment', 'mixed')
        AND d.arrival_at > l.last_seen_at
        AND EXTRACT(EPOCH FROM (d.arrival_at - l.last_seen_at)) / 86400 BETWEEN 1 AND 90
        ${destinationFilter}
        ${originFilter}
    ),
    scored AS (
      SELECT *,
        CASE
          WHEN load_port_type = 'crude-loading' AND discharge_port_type = 'refinery'
            THEN 'strong'
          WHEN load_port_type = 'mixed' OR discharge_port_type IN ('mixed', 'transshipment')
            THEN 'medium'
          ELSE 'weak'
        END AS confidence,
        CASE
          WHEN load_port_type = 'crude-loading' AND discharge_port_type = 'refinery' THEN 2
          WHEN load_port_type = 'mixed' OR discharge_port_type IN ('mixed', 'transshipment') THEN 1
          ELSE 0
        END AS conf_rank
      FROM pairs
    )
    SELECT
      s.*,
      v.name AS vessel_name,
      v.flag_country
    FROM scored s
    LEFT JOIN vessels v ON v.mmsi = s.mmsi
    WHERE conf_rank >= ${minRank}
    ORDER BY arrived_at DESC
    LIMIT ${limit}
  `);

  return (result.rows as Array<Record<string, unknown>>).map((r) => {
    const mmsi = String(r.mmsi);
    const loadSlug = String(r.load_port_slug);
    const dischSlug = String(r.discharge_port_slug);
    const loadedAt =
      r.loaded_at instanceof Date ? r.loaded_at.toISOString() : String(r.loaded_at);
    const arrivedAt =
      r.arrived_at instanceof Date ? r.arrived_at.toISOString() : String(r.arrived_at);
    return {
      cargoId: `${mmsi}:${loadSlug}:${dischSlug}:${loadedAt.slice(0, 10)}`,
      mmsi,
      vesselName: r.vessel_name == null ? null : String(r.vessel_name),
      flagCountry: r.flag_country == null ? null : String(r.flag_country),
      loadPortSlug: loadSlug,
      loadPortName: String(r.load_port_name),
      loadPortCountry: String(r.load_port_country),
      loadedAt,
      dischargePortSlug: dischSlug,
      dischargePortName: String(r.discharge_port_name),
      dischargePortCountry: String(r.discharge_port_country),
      arrivedAt,
      transitDays: Number.parseFloat(String(r.transit_days)),
      confidence: String(r.confidence) as CargoTrip['confidence'],
    };
  });
}

// ===========================================================================
// Match queue — proactive deal-origination signals
// ===========================================================================

export interface MatchQueueItem {
  id: string;
  signalType: 'distress_event' | 'velocity_drop' | 'new_award' | string;
  signalKind: string;
  sourceTable: string;
  sourceId: string;
  knownEntityId: string | null;
  externalSupplierId: string | null;
  sourceEntityName: string;
  sourceEntityCountry: string | null;
  categoryTags: string[];
  observedAt: string;
  score: number;
  rationale: string;
  status: 'open' | 'dismissed' | 'pushed-to-vex' | 'actioned' | string;
  matchedAt: string;
  /** Set when knownEntityId resolves to a known_entities row. */
  entityProfileSlug: string | null;
}

/**
 * Pull the match queue, default to open rows ranked by score
 * (DESC) + observed_at (DESC). Powers /match-queue.
 *
 * `target` filter (added 2026-Q2):
 *   'counterparty' — rows linked to a known_entity OR external_supplier.
 *                    Actionable for push-to-vex; this is the home
 *                    dashboard's Match queue panel.
 *   'macro'        — rows where both FK columns are NULL (geo / region
 *                    / market signals — e.g. "Tuapse press_distress",
 *                    "Iran tensions", "Strait of Hormuz disruption").
 *                    Surfaced separately as Market signals; not
 *                    pushable to vex but useful as macro context.
 *   'all'          — both. Default for back-compat with the existing
 *                    /suppliers/match-queue page that doesn't yet
 *                    distinguish.
 */
export async function getMatchQueue(filters: {
  status?: 'open' | 'dismissed' | 'pushed-to-vex' | 'actioned';
  signalType?: 'distress_event' | 'velocity_drop' | 'new_award';
  daysBack?: number;
  limit?: number;
  target?: 'counterparty' | 'macro' | 'all';
} = {}): Promise<MatchQueueItem[]> {
  const status = filters.status ?? 'open';
  const daysBack = filters.daysBack ?? 30;
  const limit = Math.min(filters.limit ?? 100, 500);
  const target = filters.target ?? 'all';

  const signalFilter = filters.signalType
    ? sql`AND mq.signal_type = ${filters.signalType}`
    : sql``;
  const targetFilter =
    target === 'counterparty'
      ? sql`AND (mq.known_entity_id IS NOT NULL OR mq.external_supplier_id IS NOT NULL)`
      : target === 'macro'
        ? sql`AND mq.known_entity_id IS NULL AND mq.external_supplier_id IS NULL`
        : sql``;

  const result = await db.execute(sql`
    SELECT
      mq.id,
      mq.signal_type,
      mq.signal_kind,
      mq.source_table,
      mq.source_id,
      mq.known_entity_id,
      mq.external_supplier_id,
      mq.source_entity_name,
      mq.source_entity_country,
      mq.category_tags,
      mq.observed_at,
      mq.score,
      mq.rationale,
      mq.status,
      mq.matched_at,
      ke.slug AS entity_slug
    FROM match_queue mq
    LEFT JOIN known_entities ke ON ke.id = mq.known_entity_id
    WHERE mq.status = ${status}
      AND mq.observed_at >= CURRENT_DATE - (${daysBack}::int * INTERVAL '1 day')
      ${signalFilter}
      ${targetFilter}
    ORDER BY mq.score DESC, mq.observed_at DESC, mq.matched_at DESC
    LIMIT ${limit}
  `);

  return (result.rows as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    signalType: String(r.signal_type),
    signalKind: String(r.signal_kind),
    sourceTable: String(r.source_table),
    sourceId: String(r.source_id),
    knownEntityId: r.known_entity_id == null ? null : String(r.known_entity_id),
    externalSupplierId:
      r.external_supplier_id == null ? null : String(r.external_supplier_id),
    sourceEntityName: String(r.source_entity_name),
    sourceEntityCountry:
      r.source_entity_country == null ? null : String(r.source_entity_country),
    categoryTags: (r.category_tags as string[] | null) ?? [],
    observedAt:
      r.observed_at instanceof Date
        ? r.observed_at.toISOString().slice(0, 10)
        : String(r.observed_at),
    score: Number.parseFloat(String(r.score)),
    rationale: String(r.rationale),
    status: String(r.status) as MatchQueueItem['status'],
    matchedAt:
      r.matched_at instanceof Date
        ? r.matched_at.toISOString()
        : String(r.matched_at),
    entityProfileSlug: r.entity_slug == null ? null : String(r.entity_slug),
  }));
}

/**
 * Workflow transitions on a match-queue row. Server-action target.
 */
export async function updateMatchQueueStatus(args: {
  id: string;
  status: 'open' | 'dismissed' | 'pushed-to-vex' | 'actioned';
}): Promise<void> {
  await db.execute(sql`
    UPDATE match_queue
    SET status = ${args.status},
        status_updated_at = NOW()
    WHERE id = ${args.id}::uuid
  `);
}

// ============================================================================
// Entity contact enrichments — vex's ContactEnrichmentAgent share-back
// ============================================================================

export type EntityContactEnrichment = {
  id: string;
  contactName: string;
  source: string;
  enrichedAt: string;
  email: { value: string; confidence: number; sourceUrl: string | null } | null;
  title: { value: string; confidence: number; sourceUrl: string | null } | null;
  phone: { value: string; confidence: number; sourceUrl: string | null } | null;
  linkedinUrl: { value: string; confidence: number; sourceUrl: string | null } | null;
};

/**
 * Fetch sidecar contact enrichments for an entity. These are vex's
 * ContactEnrichmentAgent discoveries that have been shared back via
 * POST /api/intelligence/entity/{slug}/contact-enrichment. Read-only
 * here — the entity profile page renders them as a "Contacts"
 * section so an operator can see what vex has surfaced.
 *
 * Ordered by enrichedAt DESC so the most-recently-discovered
 * contacts surface first.
 */
export async function getContactEnrichmentsBySlug(
  entitySlug: string,
): Promise<EntityContactEnrichment[]> {
  const result = await db.execute(sql`
    SELECT
      id,
      contact_name,
      source,
      enriched_at,
      email, email_confidence, email_source_url,
      title, title_confidence, title_source_url,
      phone, phone_confidence, phone_source_url,
      linkedin_url, linkedin_confidence, linkedin_source_url
    FROM entity_contact_enrichments
    WHERE entity_slug = ${entitySlug}
    ORDER BY enriched_at DESC, contact_name ASC
    LIMIT 50
  `);

  return (result.rows as Array<Record<string, unknown>>).map((r) => {
    const field = (
      value: unknown,
      conf: unknown,
      src: unknown,
    ): EntityContactEnrichment['email'] => {
      if (value == null) return null;
      return {
        value: String(value),
        confidence: conf == null ? 0 : Number.parseFloat(String(conf)),
        sourceUrl: src == null ? null : String(src),
      };
    };
    return {
      id: String(r.id),
      contactName: String(r.contact_name),
      source: String(r.source),
      enrichedAt:
        r.enriched_at instanceof Date
          ? r.enriched_at.toISOString()
          : String(r.enriched_at),
      email: field(r.email, r.email_confidence, r.email_source_url),
      title: field(r.title, r.title_confidence, r.title_source_url),
      phone: field(r.phone, r.phone_confidence, r.phone_source_url),
      linkedinUrl: field(r.linkedin_url, r.linkedin_confidence, r.linkedin_source_url),
    };
  });
}

// ─── Supplier approvals (per-tenant KYC state) ──────────────────

export type SupplierApprovalRow = {
  id: string;
  entitySlug: string;
  entityName: string | null;
  status: SupplierApprovalStatus;
  approvedAt: string | null;
  expiresAt: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
};

function approvalRowFromDb(row: SupplierApproval): SupplierApprovalRow {
  return {
    id: row.id,
    entitySlug: row.entitySlug,
    entityName: row.entityName,
    status: row.status,
    approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Fetch a single approval row for (companyId, entitySlug). Returns
 * null when the company hasn't engaged with this supplier yet —
 * caller should treat null as "not engaged" and offer the
 * "Mark approval" CTA.
 */
export async function getSupplierApproval(
  companyId: string,
  entitySlug: string,
): Promise<SupplierApprovalRow | null> {
  const row = await db.query.supplierApprovals.findFirst({
    where: and(
      eq(supplierApprovals.companyId, companyId),
      eq(supplierApprovals.entitySlug, entitySlug),
    ),
  });
  return row ? approvalRowFromDb(row) : null;
}

/**
 * List every approval row for a company. Used by the settings
 * "Supplier approvals" summary panel and the rolodex filter chip.
 * Optional status filter narrows to a specific bucket.
 */
export async function listSupplierApprovals(
  companyId: string,
  statusFilter?: SupplierApprovalStatus,
): Promise<SupplierApprovalRow[]> {
  const rows = await db.query.supplierApprovals.findMany({
    where: statusFilter
      ? and(
          eq(supplierApprovals.companyId, companyId),
          eq(supplierApprovals.status, statusFilter),
        )
      : eq(supplierApprovals.companyId, companyId),
    orderBy: (t, { desc: d }) => [d(t.updatedAt)],
  });
  return rows.map(approvalRowFromDb);
}

/**
 * Quick set lookup: which entity slugs has the company been
 * approved by (with or without KYC). Used by the assistant's
 * supplier-ranking step to bias toward approved counterparties.
 */
export async function getApprovedEntitySlugs(companyId: string): Promise<Set<string>> {
  const rows = await db
    .select({ entitySlug: supplierApprovals.entitySlug })
    .from(supplierApprovals)
    .where(
      and(
        eq(supplierApprovals.companyId, companyId),
        inArray(supplierApprovals.status, ['approved_with_kyc', 'approved_without_kyc']),
      ),
    );
  return new Set(rows.map((r) => r.entitySlug));
}

export type SupplierApprovalRollup = {
  totalApproved: number;
  approvedWithKyc: number;
  approvedWithoutKyc: number;
  inFlight: number; // pending OR kyc_in_progress
  expired: number;
};

/**
 * Cross-tabulation of the company's supplier approvals scoped to a
 * specific known_entities.categoryTag. Powers the pursuit-detail
 * "Sourcing readiness" panel — given a pursuit's category, how
 * many counterparties can we transact with today?
 *
 * categoryTag is matched against the entity's categories[] array
 * (same semantics as lookupKnownEntities). Pass null/undefined to
 * count across all categories.
 */
export async function getSupplierApprovalRollup(
  companyId: string,
  categoryTag?: string | null,
): Promise<SupplierApprovalRollup> {
  const result = await db.execute(sql`
    SELECT sa.status, COUNT(*)::int AS n
    FROM supplier_approvals sa
    ${
      categoryTag
        ? sql`JOIN known_entities ke ON ke.slug = sa.entity_slug
              AND ${categoryTag} = ANY(ke.categories)`
        : sql``
    }
    WHERE sa.company_id = ${companyId}::uuid
    GROUP BY sa.status;
  `);
  const counts: Record<string, number> = {};
  for (const r of result.rows as Array<{ status: string; n: number }>) {
    counts[r.status] = r.n;
  }
  const approvedWithKyc = counts['approved_with_kyc'] ?? 0;
  const approvedWithoutKyc = counts['approved_without_kyc'] ?? 0;
  return {
    totalApproved: approvedWithKyc + approvedWithoutKyc,
    approvedWithKyc,
    approvedWithoutKyc,
    inFlight: (counts['pending'] ?? 0) + (counts['kyc_in_progress'] ?? 0),
    expired: counts['expired'] ?? 0,
  };
}

// ─── Market move (banner) ───────────────────────────────────────

export type MarketMoveSeries = {
  seriesSlug: string;
  /** Display-friendly series name (e.g. "Brent", "NYH ULSD"). */
  label: string;
  unit: string;
  latestPrice: number;
  latestAsOf: string;
  /** Decimal change over the lookback window. -0.18 = -18%. Null when
   *  not enough data points to compute (one trading day or zero). */
  pctChange: number | null;
};

export type MarketMoveBanner = {
  /** True when at least one series moved more than the threshold over
   *  the lookback window. UI uses this to decide whether to render. */
  shouldDisplay: boolean;
  windowDays: number;
  /** Threshold the trader cares about, as a decimal. 0.05 = ±5%. */
  thresholdAbs: number;
  series: MarketMoveSeries[];
};

const BANNER_SERIES: Array<{ slug: string; label: string }> = [
  { slug: 'brent', label: 'Brent' },
  { slug: 'nyh-diesel', label: 'NYH ULSD' },
  { slug: 'nyh-gasoline', label: 'NYH Gasoline' },
  { slug: 'nyh-heating-oil', label: 'NYH Heating Oil' },
];

/**
 * Fetch a fixed set of benchmark price series and compute the
 * lookback-window pct change for each. Returns a "shouldDisplay" flag
 * that's true when at least one series moved more than thresholdAbs
 * — so the layout-level banner can render conditionally without
 * having to interpret the data.
 *
 * Uses the same window-pct-change semantics as
 * getCommodityPriceContext, but issues a single multi-series query
 * so the layout doesn't fan out to four separate calls per render.
 */
export async function getMarketMoveBanner(
  windowDays = 7,
  thresholdAbs = 0.05,
): Promise<MarketMoveBanner> {
  const slugs = BANNER_SERIES.map((s) => s.slug);
  const result = await db.execute(sql`
    WITH series AS (
      SELECT
        cp.series_slug,
        cp.unit,
        cp.price::numeric AS price,
        cp.price_date,
        ROW_NUMBER() OVER (
          PARTITION BY cp.series_slug
          ORDER BY cp.price_date DESC
        ) AS rn_desc,
        ROW_NUMBER() OVER (
          PARTITION BY cp.series_slug
          ORDER BY cp.price_date ASC
        ) AS rn_asc
      FROM commodity_prices cp
      WHERE cp.series_slug = ANY(${slugs}::text[])
        AND cp.contract_type = 'spot'
        AND cp.price_date >= CURRENT_DATE - ${windowDays}::int
    )
    SELECT
      latest.series_slug,
      latest.unit,
      latest.price        AS latest_price,
      latest.price_date   AS latest_date,
      earliest.price      AS earliest_price
    FROM (SELECT * FROM series WHERE rn_desc = 1) latest
    LEFT JOIN (SELECT * FROM series WHERE rn_asc = 1) earliest
      ON latest.series_slug = earliest.series_slug;
  `);

  const rows = result.rows as Array<{
    series_slug: string;
    unit: string;
    latest_price: string | number;
    latest_date: string | Date;
    earliest_price: string | number | null;
  }>;
  const bySlug = new Map(rows.map((r) => [r.series_slug, r]));

  const series: MarketMoveSeries[] = BANNER_SERIES.map((s) => {
    const row = bySlug.get(s.slug);
    if (!row) {
      return {
        seriesSlug: s.slug,
        label: s.label,
        unit: 'usd-bbl',
        latestPrice: 0,
        latestAsOf: '',
        pctChange: null,
      };
    }
    const latest = Number.parseFloat(String(row.latest_price));
    const earliest =
      row.earliest_price != null
        ? Number.parseFloat(String(row.earliest_price))
        : null;
    const pctChange =
      earliest != null && earliest !== 0 ? (latest - earliest) / earliest : null;
    return {
      seriesSlug: s.slug,
      label: s.label,
      unit: row.unit,
      latestPrice: latest,
      latestAsOf:
        row.latest_date instanceof Date
          ? row.latest_date.toISOString().slice(0, 10)
          : String(row.latest_date).slice(0, 10),
      pctChange,
    };
  }).filter((s) => s.latestAsOf !== '');

  const shouldDisplay = series.some(
    (s) => s.pctChange != null && Math.abs(s.pctChange) >= thresholdAbs,
  );

  return { shouldDisplay, windowDays, thresholdAbs, series };
}

// ─── Entity news (RSS-ingested) ─────────────────────────────────

export type EntityNewsRow = {
  id: string;
  knownEntityId: string | null;
  entityName: string;
  entityCountry: string | null;
  /** Slug of the linked known_entity, when joinable. Powers the
   *  "click through to entity profile" link on the brief panel. */
  entitySlug: string | null;
  eventType: string;
  eventDate: string;
  summary: string;
  source: string;
  sourceUrl: string | null;
  relevanceScore: number;
  ingestedAt: string;
};

export type ListEntityNewsFilters = {
  /** Restrict to events linked to entities the company has marked
   *  approved (any approved_* status). When false, returns events
   *  for every entity in the rolodex — useful for the chat
   *  assistant looking up news on a specific counterparty. */
  approvedSuppliersOnly?: boolean;
  /** Required when approvedSuppliersOnly is true. Ignored otherwise. */
  companyId?: string;
  /** Filter to a single entity by slug. Mutually exclusive with
   *  approvedSuppliersOnly. */
  entitySlug?: string;
  /** Restrict to specific event_type values (e.g. ['press_distress_signal']
   *  for the counterparty-news panel, ['fuel_market_news'] for the
   *  fuel-market panel). When omitted, returns all event types. */
  eventTypes?: string[];
  /** Minimum relevance threshold. The ingest task already drops
   *  <0.4 noise; a default of 0.5 here surfaces the high-signal
   *  half. */
  minRelevance?: number;
  /** Lookback window in days. Default 7 (matches the brief
   *  "what changed overnight" framing). */
  daysBack?: number;
  limit?: number;
};

/**
 * Read entity_news_events filtered to a useful slice for the brief
 * page or the chat assistant. Joins known_entities to surface the
 * canonical slug + country. Optional approval-scope filter pulls
 * only events linked to the company's approved suppliers — that's
 * the brief-page default.
 */
export async function listEntityNews(
  filters: ListEntityNewsFilters,
): Promise<EntityNewsRow[]> {
  const minRelevance = filters.minRelevance ?? 0.5;
  const daysBack = filters.daysBack ?? 7;
  const limit = Math.min(filters.limit ?? 25, 100);

  const result = await db.execute(sql`
    SELECT
      ne.id,
      ne.known_entity_id,
      ne.source_entity_name,
      ne.source_entity_country,
      ke.slug          AS entity_slug,
      ne.event_type,
      ne.event_date,
      ne.summary,
      ne.source,
      ne.source_url,
      ne.relevance_score,
      ne.ingested_at
    FROM entity_news_events ne
    LEFT JOIN known_entities ke ON ke.id = ne.known_entity_id
    WHERE ne.event_date >= CURRENT_DATE - ${daysBack}::int
      AND coalesce(ne.relevance_score, 0) >= ${minRelevance}
      ${
        filters.approvedSuppliersOnly && filters.companyId
          ? sql`AND ke.slug IN (
              SELECT entity_slug FROM supplier_approvals
              WHERE company_id = ${filters.companyId}::uuid
                AND status IN ('approved_with_kyc', 'approved_without_kyc')
            )`
          : sql``
      }
      ${
        filters.entitySlug
          ? sql`AND ke.slug = ${filters.entitySlug}`
          : sql``
      }
      ${
        filters.eventTypes && filters.eventTypes.length > 0
          ? sql`AND ne.event_type IN (${sql.join(
              filters.eventTypes.map((t) => sql`${t}`),
              sql`, `,
            )})`
          : sql``
      }
    ORDER BY ne.event_date DESC, ne.relevance_score DESC NULLS LAST
    LIMIT ${limit};
  `);

  return (result.rows as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    knownEntityId: r.known_entity_id == null ? null : String(r.known_entity_id),
    entityName: String(r.source_entity_name),
    entityCountry:
      r.source_entity_country == null ? null : String(r.source_entity_country),
    entitySlug: r.entity_slug == null ? null : String(r.entity_slug),
    eventType: String(r.event_type),
    eventDate:
      r.event_date instanceof Date
        ? r.event_date.toISOString().slice(0, 10)
        : String(r.event_date).slice(0, 10),
    summary: String(r.summary),
    source: String(r.source),
    sourceUrl: r.source_url == null ? null : String(r.source_url),
    relevanceScore:
      r.relevance_score == null ? 0 : Number.parseFloat(String(r.relevance_score)),
    ingestedAt:
      r.ingested_at instanceof Date
        ? r.ingested_at.toISOString()
        : String(r.ingested_at),
  }));
}

// ─── Sanctions screens (vex push) ────────────────────────────────

type SanctionsMatch = {
  source_list: string;
  sdn_uid: string;
  programs: string[];
  confidence_band: 'high_confidence' | 'fuzzy_review';
  sdn_type: 'individual' | 'entity' | 'vessel' | 'aircraft';
};

export interface SanctionsScreenRow {
  vexTenantId: string;
  screenId: string;
  legalName: string;
  status: 'clear' | 'potential_match' | 'confirmed_match';
  sourcesChecked: string[];
  matches: SanctionsMatch[];
  screenedAt: string;
}

export interface SanctionsBySource {
  sourceList: string;
  matched: boolean;
  lastScreenedAt: string;
  screeningTenant: string;
}

export interface SanctionsActiveMatch extends SanctionsMatch {
  screenedAt: string;
  screeningTenant: string;
}

export interface SanctionsScreensSummary {
  entitySlug: string;
  /** True when no screens have ever landed for this entity. The chat
   *  tool surfaces a clear "no data" framing rather than implying
   *  silence is exonerating. */
  noData: boolean;
  /** ISO date of the most recent screen across all tenants, or null. */
  latestScreenedAt: string | null;
  /** Worst-case roll-up across tenants and sources. 'no_data' when
   *  noData is true; 'mixed' when tenants disagree and there's at
   *  least one match. */
  overall:
    | 'clear'
    | 'potential_match'
    | 'confirmed_match'
    | 'mixed'
    | 'no_data';
  /** Per source-list: when last screened + whether it matched. Each
   *  source appears once with its most recent verdict. */
  bySource: SanctionsBySource[];
  /** Currently-active match records — deduped by sdn_uid + source_list,
   *  taking the latest occurrence. Empty when no matches exist. */
  matches: SanctionsActiveMatch[];
  /** Full per-tenant breakdown so the assistant can surface
   *  cross-tenant disagreement on demand. Latest row per tenant only. */
  byTenant: Array<{
    vexTenantId: string;
    latestScreenedAt: string;
    status: SanctionsScreenRow['status'];
    sourcesChecked: string[];
    matches: SanctionsMatch[];
  }>;
}

/**
 * Roll up vex's sanctions-screen rows for one entity into the shape
 * the chat assistant + entity profile UI consume. Verdicts are
 * append-only per (vex_tenant_id, screen_id); we resolve "current
 * state" by taking the latest row per (vex_tenant_id) and the latest
 * matching record per (source_list, sdn_uid).
 *
 * Returns noData=true when nothing has been screened for the entity
 * yet — the assistant must say "no screens on record" rather than
 * implying clear status from absence of data.
 */
export async function lookupSanctionsScreens(
  entitySlug: string,
): Promise<SanctionsScreensSummary> {
  // 50-row cap is conservative — most entities will have 0-2 screens.
  // Tenants can re-screen daily; the cap protects against runaway
  // history queries without losing meaningful coverage.
  const result = await db.execute(sql`
    SELECT
      vex_tenant_id,
      screen_id,
      legal_name,
      status,
      sources_checked,
      matches,
      screened_at
    FROM ${entitySanctionsScreens}
    WHERE entity_slug = ${entitySlug}
    ORDER BY screened_at DESC
    LIMIT 50;
  `);

  const rows: SanctionsScreenRow[] = (
    result.rows as Array<Record<string, unknown>>
  ).map((r) => ({
    vexTenantId: String(r.vex_tenant_id),
    screenId: String(r.screen_id),
    legalName: String(r.legal_name),
    status: String(r.status) as SanctionsScreenRow['status'],
    sourcesChecked: (r.sources_checked as string[] | null) ?? [],
    matches: (r.matches as SanctionsMatch[] | null) ?? [],
    screenedAt:
      r.screened_at instanceof Date
        ? r.screened_at.toISOString()
        : String(r.screened_at),
  }));

  if (rows.length === 0) {
    return {
      entitySlug,
      noData: true,
      latestScreenedAt: null,
      overall: 'no_data',
      bySource: [],
      matches: [],
      byTenant: [],
    };
  }

  // Latest row per tenant.
  const byTenantMap = new Map<string, SanctionsScreenRow>();
  for (const row of rows) {
    if (!byTenantMap.has(row.vexTenantId)) byTenantMap.set(row.vexTenantId, row);
  }

  // Latest verdict per source_list. Walk newest-first; first hit wins.
  const bySourceMap = new Map<string, SanctionsBySource>();
  for (const row of rows) {
    for (const src of row.sourcesChecked) {
      if (bySourceMap.has(src)) continue;
      const matched = row.matches.some((m) => m.source_list === src);
      bySourceMap.set(src, {
        sourceList: src,
        matched,
        lastScreenedAt: row.screenedAt,
        screeningTenant: row.vexTenantId,
      });
    }
  }

  // Active matches — dedupe by (source_list, sdn_uid), latest wins.
  const matchMap = new Map<string, SanctionsActiveMatch>();
  for (const row of rows) {
    for (const m of row.matches) {
      const key = `${m.source_list}::${m.sdn_uid}`;
      if (matchMap.has(key)) continue;
      matchMap.set(key, {
        ...m,
        screenedAt: row.screenedAt,
        screeningTenant: row.vexTenantId,
      });
    }
  }

  // Overall roll-up: worst case across the latest row per tenant.
  const tenantRows = [...byTenantMap.values()];
  const statuses = new Set(tenantRows.map((r) => r.status));
  let overall: SanctionsScreensSummary['overall'];
  if (statuses.has('confirmed_match')) {
    overall = 'confirmed_match';
  } else if (statuses.size === 1 && statuses.has('clear')) {
    overall = 'clear';
  } else if (statuses.has('potential_match') && statuses.has('clear')) {
    overall = 'mixed';
  } else if (statuses.has('potential_match')) {
    overall = 'potential_match';
  } else {
    overall = 'clear';
  }

  return {
    entitySlug,
    noData: false,
    latestScreenedAt: rows[0]!.screenedAt,
    overall,
    bySource: [...bySourceMap.values()].sort((a, b) =>
      a.sourceList.localeCompare(b.sourceList),
    ),
    matches: [...matchMap.values()],
    byTenant: tenantRows.map((r) => ({
      vexTenantId: r.vexTenantId,
      latestScreenedAt: r.screenedAt,
      status: r.status,
      sourcesChecked: r.sourcesChecked,
      matches: r.matches,
    })),
  };
}

/**
 * Look up crude assays by name / origin / property filter, joining
 * to `crude_grades` for marker-differential context. Powers the
 * `lookup_crude_assay` chat tool + the `compose_deal_economics`
 * density auto-fill.
 *
 * Filter semantics:
 *   - `name` runs a case-insensitive prefix + substring match
 *     against assay name AND linked grade name. Use the longer
 *     producer name verbatim ("BRENT BLEND", "EKOFISK 2015 06") or
 *     the canonical short form ("Brent", "Bonny Light"); both work.
 *   - `originCountry` is ISO-2 (already normalized at the chat-tool
 *     boundary).
 *   - `gradeSlug` filters by linked crude_grades slug (exact match).
 *   - `apiMin` / `apiMax` filter on assay api_gravity range.
 *   - `sulphurMaxPct` filters assays at or below the threshold.
 *
 * Sort: most recent assayDate first, with NULL dates last (older
 * vintages typically don't carry a parsed date). When multiple
 * producers publish the same grade (e.g. Brent has 4 vintages
 * across BP/Equinor/Total/ExxonMobil), the user sees the freshest
 * first but all vintages are returned up to the limit.
 */
export type CrudeAssayLookupFilter = {
  name?: string;
  originCountry?: string;
  gradeSlug?: string;
  apiMin?: number;
  apiMax?: number;
  sulphurMaxPct?: number;
  /** Default 12. Capped at 50 to keep chat-surface payloads reasonable. */
  limit?: number;
};

export type CrudeAssayLookupRow = {
  source: string;
  reference: string;
  name: string;
  originCountry: string | null;
  originLabel: string | null;
  assayDate: string | null;
  apiGravity: number | null;
  densityKgL: number | null;
  bblPerMt: number | null;
  sulphurWtPct: number | null;
  pourPointC: number | null;
  acidityMgKohG: number | null;
  vanadiumMgKg: number | null;
  nickelMgKg: number | null;
  /** Linked grade context. Null when the assay didn't match any
   *  curated grade row. */
  grade: {
    slug: string;
    name: string;
    region: string | null;
    isMarker: boolean;
    markerSlug: string | null;
    differentialUsdPerBbl: number | null;
  } | null;
};

export async function lookupCrudeAssay(
  filter: CrudeAssayLookupFilter,
): Promise<{ totalMatches: number; results: CrudeAssayLookupRow[] }> {
  const limit = Math.min(filter.limit ?? 12, 50);
  const conditions = [];

  if (filter.name && filter.name.trim().length > 0) {
    const pattern = `%${filter.name.trim()}%`;
    conditions.push(
      or(
        ilike(crudeAssays.name, pattern),
        ilike(crudeGrades.name, pattern),
      ),
    );
  }
  if (filter.originCountry) {
    conditions.push(eq(crudeAssays.originCountry, filter.originCountry));
  }
  if (filter.gradeSlug) {
    conditions.push(eq(crudeAssays.gradeSlug, filter.gradeSlug));
  }
  if (filter.apiMin != null) {
    conditions.push(gte(crudeAssays.apiGravity, String(filter.apiMin)));
  }
  if (filter.apiMax != null) {
    conditions.push(lte(crudeAssays.apiGravity, String(filter.apiMax)));
  }
  if (filter.sulphurMaxPct != null) {
    conditions.push(lte(crudeAssays.sulphurWtPct, String(filter.sulphurMaxPct)));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  // Total count for "X more matches" hints in chat.
  const totalMatchesRow = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(crudeAssays)
    .leftJoin(crudeGrades, eq(crudeAssays.gradeSlug, crudeGrades.slug))
    .where(whereClause as never);
  const totalMatches = totalMatchesRow[0]?.count ?? 0;

  const rows = await db
    .select({
      source: crudeAssays.source,
      reference: crudeAssays.reference,
      name: crudeAssays.name,
      originCountry: crudeAssays.originCountry,
      originLabel: crudeAssays.originLabel,
      assayDate: crudeAssays.assayDate,
      apiGravity: crudeAssays.apiGravity,
      densityKgL: crudeAssays.densityKgL,
      bblPerMt: crudeAssays.bblPerMt,
      sulphurWtPct: crudeAssays.sulphurWtPct,
      pourPointC: crudeAssays.pourPointC,
      acidityMgKohG: crudeAssays.acidityMgKohG,
      vanadiumMgKg: crudeAssays.vanadiumMgKg,
      nickelMgKg: crudeAssays.nickelMgKg,
      gradeSlug: crudeGrades.slug,
      gradeName: crudeGrades.name,
      gradeRegion: crudeGrades.region,
      gradeIsMarker: crudeGrades.isMarker,
      gradeMarkerSlug: crudeGrades.markerSlug,
      gradeDifferential: crudeGrades.differentialUsdPerBbl,
    })
    .from(crudeAssays)
    .leftJoin(crudeGrades, eq(crudeAssays.gradeSlug, crudeGrades.slug))
    .where(whereClause as never)
    .orderBy(sql`${crudeAssays.assayDate} desc nulls last`, desc(crudeAssays.updatedAt))
    .limit(limit);

  const results: CrudeAssayLookupRow[] = rows.map((r) => ({
    source: r.source,
    reference: r.reference,
    name: r.name,
    originCountry: r.originCountry,
    originLabel: r.originLabel,
    assayDate: r.assayDate,
    apiGravity: numericOrNull(r.apiGravity),
    densityKgL: numericOrNull(r.densityKgL),
    bblPerMt: numericOrNull(r.bblPerMt),
    sulphurWtPct: numericOrNull(r.sulphurWtPct),
    pourPointC: numericOrNull(r.pourPointC),
    acidityMgKohG: numericOrNull(r.acidityMgKohG),
    vanadiumMgKg: numericOrNull(r.vanadiumMgKg),
    nickelMgKg: numericOrNull(r.nickelMgKg),
    grade: r.gradeSlug
      ? {
          slug: r.gradeSlug,
          name: r.gradeName!,
          region: r.gradeRegion,
          isMarker: r.gradeIsMarker!,
          markerSlug: r.gradeMarkerSlug,
          differentialUsdPerBbl: numericOrNull(r.gradeDifferential),
        }
      : null,
  }));

  return { totalMatches, results };
}

/**
 * Look up the most recent assay-derived density for a named crude.
 * Used by `compose_deal_economics` to auto-fill `densityKgL` when
 * the user provides `cargoCrudeName` instead of an explicit density.
 *
 * Returns null when no matching assay found OR when none of the
 * matching assays carry a density value. The calculator's per-product
 * density default is the fallback in that case.
 */
export async function getDensityForCrudeName(
  name: string,
): Promise<{ densityKgL: number; source: string; reference: string; assayName: string } | null> {
  const trimmed = name.trim();
  if (trimmed.length === 0) return null;
  const pattern = `%${trimmed}%`;

  const [row] = await db
    .select({
      source: crudeAssays.source,
      reference: crudeAssays.reference,
      name: crudeAssays.name,
      densityKgL: crudeAssays.densityKgL,
    })
    .from(crudeAssays)
    .leftJoin(crudeGrades, eq(crudeAssays.gradeSlug, crudeGrades.slug))
    .where(
      and(
        isNotNull(crudeAssays.densityKgL),
        or(ilike(crudeAssays.name, pattern), ilike(crudeGrades.name, pattern)),
      ),
    )
    .orderBy(sql`${crudeAssays.assayDate} desc nulls last`, desc(crudeAssays.updatedAt))
    .limit(1);

  if (!row || row.densityKgL == null) return null;
  const density = Number(row.densityKgL);
  if (!Number.isFinite(density) || density <= 0) return null;
  return {
    densityKgL: density,
    source: row.source,
    reference: row.reference,
    assayName: row.name,
  };
}

function numericOrNull(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

// ─── Refinery × grade compatibility (work item 1) ────────────────

export type RefineryGradeFitRow = {
  refinerySlug: string;
  refineryName: string;
  refineryCountry: string;
  gradeSlug: string;
  gradeName: string;
  gradeOriginCountry: string | null;
  gradeRegion: string | null;
  gradeApiGravity: number | null;
  gradeSulfurPct: number | null;
  gradeTan: number | null;
  slateApiMin: number | null;
  slateApiMax: number | null;
  slateSulfurMaxPct: number | null;
  slateTanMax: number | null;
  slateComplexityIndex: number | null;
  slateCapacityBpd: number | null;
  apiCompatible: boolean;
  sulfurCompatible: boolean;
  tanCompatible: boolean;
  slateCompatible: boolean;
};

/**
 * Refineries whose slate envelope accepts a given crude grade.
 *
 * Backed by the `refinery_grade_compatibility` view (migration 0057),
 * which CROSS JOINs `known_entities` (slate envelopes) with
 * `crude_grades` (property scalars) and produces per-pair
 * compatibility booleans deterministically.
 *
 * Sort:
 *   1. slate_compatible DESC (matches first)
 *   2. complexity_index DESC NULLS LAST (more sophisticated
 *      refineries first — they extract more value from the grade)
 *   3. capacity_bpd DESC NULLS LAST (larger units absorb cargoes
 *      more easily)
 */
export async function findRefineriesForGrade(args: {
  gradeSlug: string;
  /** Restrict to refineries in these ISO-2 countries. */
  inCountries?: string[];
  /** Default 25, cap 100. */
  limit?: number;
  /** When true (default), return only `slate_compatible = TRUE`
   *  rows. Set false to also surface near-misses with their
   *  per-dimension reasons. */
  compatibleOnly?: boolean;
}): Promise<RefineryGradeFitRow[]> {
  const limit = Math.min(args.limit ?? 25, 100);
  const compatibleOnly = args.compatibleOnly ?? true;
  const result = await db.execute(sql`
    SELECT * FROM refinery_grade_compatibility
    WHERE grade_slug = ${args.gradeSlug}
      ${compatibleOnly ? sql`AND slate_compatible = TRUE` : sql``}
      ${
        args.inCountries && args.inCountries.length > 0
          ? sql`AND refinery_country = ANY(${pgArray(args.inCountries)})`
          : sql``
      }
    ORDER BY slate_compatible DESC,
             slate_complexity_index DESC NULLS LAST,
             slate_capacity_bpd DESC NULLS LAST
    LIMIT ${limit};
  `);
  return (result.rows as Array<Record<string, unknown>>).map(rowToRefineryGradeFit);
}

/**
 * Crude grades whose properties fit a given refinery's slate envelope.
 *
 * Symmetric to `findRefineriesForGrade`. Uses the same view; sorts by
 * `differentialUsdPerBbl ASC NULLS LAST` so the cheapest grades
 * (largest discount to marker) appear first — typically the highest
 * margin if the refiner has flexibility.
 */
export async function findGradesForRefinery(args: {
  refinerySlug: string;
  /** Restrict to grades originating in these ISO-2 countries. */
  fromOriginCountries?: string[];
  /** Restrict to specific regions (matches crude_grades.region). */
  fromRegions?: string[];
  /** Default 25, cap 100. */
  limit?: number;
  /** When true (default), only `slate_compatible = TRUE`. */
  compatibleOnly?: boolean;
}): Promise<
  Array<RefineryGradeFitRow & { differentialUsdPerBbl: number | null; markerSlug: string | null }>
> {
  const limit = Math.min(args.limit ?? 25, 100);
  const compatibleOnly = args.compatibleOnly ?? true;
  const result = await db.execute(sql`
    SELECT rgc.*,
           cg.differential_usd_per_bbl AS differential_usd_per_bbl,
           cg.marker_slug AS marker_slug
    FROM refinery_grade_compatibility rgc
    LEFT JOIN crude_grades cg ON cg.slug = rgc.grade_slug
    WHERE rgc.refinery_slug = ${args.refinerySlug}
      ${compatibleOnly ? sql`AND rgc.slate_compatible = TRUE` : sql``}
      ${
        args.fromOriginCountries && args.fromOriginCountries.length > 0
          ? sql`AND rgc.grade_origin_country = ANY(${pgArray(args.fromOriginCountries)})`
          : sql``
      }
      ${
        args.fromRegions && args.fromRegions.length > 0
          ? sql`AND rgc.grade_region = ANY(${pgArray(args.fromRegions)})`
          : sql``
      }
    ORDER BY rgc.slate_compatible DESC,
             cg.differential_usd_per_bbl ASC NULLS LAST,
             rgc.grade_api_gravity DESC NULLS LAST
    LIMIT ${limit};
  `);
  return (result.rows as Array<Record<string, unknown>>).map((r) => ({
    ...rowToRefineryGradeFit(r),
    differentialUsdPerBbl: numericOrNullCG(r.differential_usd_per_bbl),
    markerSlug: r.marker_slug == null ? null : String(r.marker_slug),
  }));
}

function rowToRefineryGradeFit(r: Record<string, unknown>): RefineryGradeFitRow {
  return {
    refinerySlug: String(r.refinery_slug),
    refineryName: String(r.refinery_name),
    refineryCountry: String(r.refinery_country),
    gradeSlug: String(r.grade_slug),
    gradeName: String(r.grade_name),
    gradeOriginCountry: r.grade_origin_country == null ? null : String(r.grade_origin_country),
    gradeRegion: r.grade_region == null ? null : String(r.grade_region),
    gradeApiGravity: numericOrNullCG(r.grade_api_gravity),
    gradeSulfurPct: numericOrNullCG(r.grade_sulfur_pct),
    gradeTan: numericOrNullCG(r.grade_tan),
    slateApiMin: numericOrNullCG(r.slate_api_min),
    slateApiMax: numericOrNullCG(r.slate_api_max),
    slateSulfurMaxPct: numericOrNullCG(r.slate_sulfur_max_pct),
    slateTanMax: numericOrNullCG(r.slate_tan_max),
    slateComplexityIndex: numericOrNullCG(r.slate_complexity_index),
    slateCapacityBpd: numericOrNullCG(r.slate_capacity_bpd),
    apiCompatible: r.api_compatible === true,
    sulfurCompatible: r.sulfur_compatible === true,
    tanCompatible: r.tan_compatible === true,
    slateCompatible: r.slate_compatible === true,
  };
}

function numericOrNullCG(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

// ─── Environmental services rolodex queries ──────────────────────

export type EnvironmentalOperatorMatch = {
  slug: string;
  name: string;
  country: string;
  /** Best-effort dehydrated view of the structured slot at
   *  `metadata.environmentalServices`. Fields default to safe empties
   *  when the metadata hasn't been populated yet — caller can still
   *  filter / display without an inner narrow. */
  capability: {
    wasteTypesHandled: string[];
    treatmentTechnologies: string[];
    mobileCapability: boolean;
    labCapability: boolean;
    countriesServed: string[];
    priorOilGasClients: string[];
    confidenceScore: number;
    /** Compact summary of regulator licenses for ranking / display.
     *  Full license list lives at `metadata.environmentalServices.
     *  regulatorLicenses`. */
    licenseCount: number;
    licenseAuthorities: string[];
  };
  notes: string | null;
};

/**
 * Helper: pull the env-services capability slot off `metadata` with
 * sane defaults when the slot is missing or partial. Centralizes the
 * "this rolodex entry hasn't been fully enriched yet" defense — the
 * brief's Phase 2 is multi-week, so partial entries are the norm
 * during ingestion.
 */
function readEnvServicesCapability(
  metadata: unknown,
): EnvironmentalOperatorMatch['capability'] {
  const env =
    metadata != null &&
    typeof metadata === 'object' &&
    'environmentalServices' in metadata
      ? (metadata as Record<string, unknown>).environmentalServices
      : null;
  const cap =
    env != null && typeof env === 'object' ? (env as Record<string, unknown>) : {};
  const arr = (key: string): string[] => {
    const v = cap[key];
    return Array.isArray(v) ? v.map(String) : [];
  };
  const bool = (key: string): boolean => cap[key] === true;
  const num = (key: string): number => {
    const v = cap[key];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
      const n = Number.parseFloat(v);
      if (Number.isFinite(n)) return n;
    }
    return 0;
  };
  const licenses = Array.isArray(cap.regulatorLicenses)
    ? (cap.regulatorLicenses as Array<Record<string, unknown>>)
    : [];
  const licenseAuthorities = Array.from(
    new Set(licenses.map((l) => (l.authority == null ? '' : String(l.authority))).filter(Boolean)),
  );
  return {
    wasteTypesHandled: arr('wasteTypesHandled'),
    treatmentTechnologies: arr('treatmentTechnologies'),
    mobileCapability: bool('mobileCapability'),
    labCapability: bool('labCapability'),
    countriesServed: arr('countriesServed'),
    priorOilGasClients: arr('priorOilGasClients'),
    confidenceScore: num('confidenceScore'),
    licenseCount: licenses.length,
    licenseAuthorities,
  };
}

/**
 * Find environmental services operators capable of handling a
 * specific waste type, optionally filtered by country or by issuing
 * regulator authority.
 *
 * Implementation: filters `known_entities` to `role =
 * 'environmental-services'` and applies the capability filter
 * post-load (the structured slot lives in JSONB; for ~thousands of
 * rows the post-filter is fine — switch to a JSONB GIN index if
 * the rolodex grows past ~10k env-services entries).
 *
 * Result is sorted by confidence DESC then license count DESC then
 * name — surface the most-credible operators first.
 */
export async function findEnvironmentalOperatorsByWasteType(args: {
  wasteType: string;
  inCountries?: string[];
  withLicenseFrom?: string;
  mobileCapabilityRequired?: boolean;
  /** 0-1; default 0.6 keeps low-confidence Phase 1 entries out of
   *  outreach lists by default. */
  minConfidenceScore?: number;
  limit?: number;
}): Promise<EnvironmentalOperatorMatch[]> {
  const limit = Math.min(args.limit ?? 50, 200);
  const minConf = args.minConfidenceScore ?? 0.6;
  const result = await db.execute(sql`
    SELECT slug, name, country, metadata, notes
    FROM known_entities
    WHERE role = 'environmental-services'
      ${
        args.inCountries && args.inCountries.length > 0
          ? sql`AND country = ANY(${pgArray(args.inCountries)})`
          : sql``
      }
    ORDER BY name ASC
    LIMIT 1000;
  `);
  const rows = (result.rows as Array<Record<string, unknown>>).map((r) => ({
    slug: String(r.slug),
    name: String(r.name),
    country: String(r.country),
    notes: r.notes == null ? null : String(r.notes),
    capability: readEnvServicesCapability(r.metadata),
  }));

  const filtered = rows.filter((row) => {
    if (!row.capability.wasteTypesHandled.includes(args.wasteType)) return false;
    if (args.mobileCapabilityRequired && !row.capability.mobileCapability) return false;
    if (
      args.withLicenseFrom &&
      !row.capability.licenseAuthorities.includes(args.withLicenseFrom)
    ) {
      return false;
    }
    if (row.capability.confidenceScore < minConf) return false;
    return true;
  });

  filtered.sort((a, b) => {
    if (b.capability.confidenceScore !== a.capability.confidenceScore) {
      return b.capability.confidenceScore - a.capability.confidenceScore;
    }
    if (b.capability.licenseCount !== a.capability.licenseCount) {
      return b.capability.licenseCount - a.capability.licenseCount;
    }
    return a.name.localeCompare(b.name);
  });

  return filtered.slice(0, limit);
}

/**
 * Find environmental services operators with operational presence
 * in a specific country. Uses `known_entities.country` as the
 * primary filter, OR the entity's `metadata.environmentalServices.
 * countriesServed` array — a Mexican operator with documented
 * Casanare presence appears in a Colombia query even if its
 * registered seat is MX.
 *
 * Capability filter is applied post-load (same JSONB-on-the-app-
 * side discipline as the waste-type query).
 */
export async function findEnvironmentalOperatorsByCountry(args: {
  country: string;
  capabilityFilter?: {
    wasteTypes?: string[];
    treatmentTechnologies?: string[];
    requireLabCapability?: boolean;
    requireMobileCapability?: boolean;
  };
  minConfidenceScore?: number;
  limit?: number;
}): Promise<EnvironmentalOperatorMatch[]> {
  const limit = Math.min(args.limit ?? 100, 500);
  const minConf = args.minConfidenceScore ?? 0.6;
  // Pull a wider set than `country = X` would — operators based
  // elsewhere may serve this country. Filter by countriesServed in JS.
  const result = await db.execute(sql`
    SELECT slug, name, country, metadata, notes
    FROM known_entities
    WHERE role = 'environmental-services'
    ORDER BY name ASC
    LIMIT 5000;
  `);
  const rows = (result.rows as Array<Record<string, unknown>>).map((r) => ({
    slug: String(r.slug),
    name: String(r.name),
    country: String(r.country),
    notes: r.notes == null ? null : String(r.notes),
    capability: readEnvServicesCapability(r.metadata),
  }));

  const cf = args.capabilityFilter;
  const filtered = rows.filter((row) => {
    const presentInCountry =
      row.country === args.country || row.capability.countriesServed.includes(args.country);
    if (!presentInCountry) return false;
    if (row.capability.confidenceScore < minConf) return false;
    if (cf?.wasteTypes && cf.wasteTypes.length > 0) {
      const overlap = cf.wasteTypes.some((w) =>
        row.capability.wasteTypesHandled.includes(w),
      );
      if (!overlap) return false;
    }
    if (cf?.treatmentTechnologies && cf.treatmentTechnologies.length > 0) {
      const overlap = cf.treatmentTechnologies.some((t) =>
        row.capability.treatmentTechnologies.includes(t),
      );
      if (!overlap) return false;
    }
    if (cf?.requireLabCapability && !row.capability.labCapability) return false;
    if (cf?.requireMobileCapability && !row.capability.mobileCapability) return false;
    return true;
  });

  filtered.sort((a, b) => {
    if (b.capability.confidenceScore !== a.capability.confidenceScore) {
      return b.capability.confidenceScore - a.capability.confidenceScore;
    }
    if (b.capability.licenseCount !== a.capability.licenseCount) {
      return b.capability.licenseCount - a.capability.licenseCount;
    }
    return a.name.localeCompare(b.name);
  });

  return filtered.slice(0, limit);
}

// ─── Caribbean fuel buyer rolodex queries ────────────────────────

export type FuelBuyerMatch = {
  slug: string;
  name: string;
  country: string;
  /** Best-effort dehydrated view of the structured slot at
   *  `metadata.fuelBuyerProfile`. Empty defaults when not yet
   *  populated so callers can filter / display without inner
   *  narrowing. */
  profile: {
    segments: string[];
    fuelTypesPurchased: string[];
    annualPurchaseVolumeBblMin: number | null;
    annualPurchaseVolumeBblMax: number | null;
    annualPurchaseVolumeConfidence: string;
    typicalCargoSizeMtMin: number | null;
    typicalCargoSizeMtMax: number | null;
    procurementModel: string;
    procurementAuthority: string;
    paymentInstrumentCapability: string[];
    knownSuppliers: string[];
    caribbeanCountriesOperated: string[];
    decisionMakerCountry: string | null;
    ownershipType: string;
    tier: 1 | 2 | 3 | null;
    confidenceScore: number;
  };
  notes: string | null;
};

/** Read the fuel-buyer profile slot off metadata with sane defaults
 *  for partially-populated rows during Phase 1/2 ingestion. */
function readFuelBuyerProfile(metadata: unknown): FuelBuyerMatch['profile'] {
  const fb =
    metadata != null &&
    typeof metadata === 'object' &&
    'fuelBuyerProfile' in metadata
      ? (metadata as Record<string, unknown>).fuelBuyerProfile
      : null;
  const p = fb != null && typeof fb === 'object' ? (fb as Record<string, unknown>) : {};
  const arr = (k: string): string[] => {
    const v = p[k];
    return Array.isArray(v) ? v.map(String) : [];
  };
  const numOrNull = (k: string): number | null => {
    const v = p[k];
    if (v == null) return null;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
      const n = Number.parseFloat(v);
      if (Number.isFinite(n)) return n;
    }
    return null;
  };
  const cargo = (p.typicalCargoSizeMt ?? null) as { min?: unknown; max?: unknown } | null;
  const cargoMin =
    cargo && typeof cargo === 'object' && cargo.min != null
      ? Number(cargo.min)
      : null;
  const cargoMax =
    cargo && typeof cargo === 'object' && cargo.max != null
      ? Number(cargo.max)
      : null;
  const tierRaw = p.tier;
  const tier =
    tierRaw === 1 || tierRaw === 2 || tierRaw === 3 ? (tierRaw as 1 | 2 | 3) : null;
  return {
    segments: arr('segments'),
    fuelTypesPurchased: arr('fuelTypesPurchased'),
    annualPurchaseVolumeBblMin: numOrNull('annualPurchaseVolumeBblMin'),
    annualPurchaseVolumeBblMax: numOrNull('annualPurchaseVolumeBblMax'),
    annualPurchaseVolumeConfidence:
      typeof p.annualPurchaseVolumeConfidence === 'string'
        ? p.annualPurchaseVolumeConfidence
        : 'unknown',
    typicalCargoSizeMtMin: cargoMin,
    typicalCargoSizeMtMax: cargoMax,
    procurementModel:
      typeof p.procurementModel === 'string' ? p.procurementModel : 'unknown',
    procurementAuthority:
      typeof p.procurementAuthority === 'string' ? p.procurementAuthority : 'unknown',
    paymentInstrumentCapability: arr('paymentInstrumentCapability'),
    knownSuppliers: arr('knownSuppliers'),
    caribbeanCountriesOperated: arr('caribbeanCountriesOperated'),
    decisionMakerCountry:
      typeof p.decisionMakerCountry === 'string' ? p.decisionMakerCountry : null,
    ownershipType:
      typeof p.ownershipType === 'string' ? p.ownershipType : 'unknown',
    tier,
    confidenceScore: numOrNull('confidenceScore') ?? 0,
  };
}

/**
 * Find Caribbean fuel buyers matching segment, fuel type, and
 * geography filters. Backs the `find_caribbean_fuel_buyers` chat
 * tool. Sorts by tier ASC (Tier-1 first), then confidence DESC.
 */
export async function findCaribbeanFuelBuyers(args: {
  segments?: string[];
  fuelTypes?: string[];
  inCountries?: string[];
  minAnnualVolumeBbl?: number;
  ownershipTypeFilter?: string;
  tier?: 1 | 2 | 3;
  withPaymentInstrumentCapability?: string[];
  minConfidenceScore?: number;
  limit?: number;
}): Promise<FuelBuyerMatch[]> {
  const limit = Math.min(args.limit ?? 100, 500);
  const minConf = args.minConfidenceScore ?? 0.6;

  const result = await db.execute(sql`
    SELECT slug, name, country, metadata, notes
    FROM known_entities
    WHERE role = 'fuel-buyer-industrial'
      ${
        args.inCountries && args.inCountries.length > 0
          ? sql`AND country = ANY(${pgArray(args.inCountries)})`
          : sql``
      }
    ORDER BY name ASC
    LIMIT 5000;
  `);
  const rows = (result.rows as Array<Record<string, unknown>>).map((r) => ({
    slug: String(r.slug),
    name: String(r.name),
    country: String(r.country),
    notes: r.notes == null ? null : String(r.notes),
    profile: readFuelBuyerProfile(r.metadata),
  }));

  const filtered = rows.filter((row) => {
    if (row.profile.confidenceScore < minConf) return false;
    if (args.segments && args.segments.length > 0) {
      const overlap = args.segments.some((s) => row.profile.segments.includes(s));
      if (!overlap) return false;
    }
    if (args.fuelTypes && args.fuelTypes.length > 0) {
      const overlap = args.fuelTypes.some((f) => row.profile.fuelTypesPurchased.includes(f));
      if (!overlap) return false;
    }
    if (args.minAnnualVolumeBbl != null) {
      const max = row.profile.annualPurchaseVolumeBblMax;
      if (max == null || max < args.minAnnualVolumeBbl) return false;
    }
    if (args.ownershipTypeFilter && row.profile.ownershipType !== args.ownershipTypeFilter) {
      return false;
    }
    if (args.tier != null && row.profile.tier !== args.tier) return false;
    if (args.withPaymentInstrumentCapability && args.withPaymentInstrumentCapability.length > 0) {
      const overlap = args.withPaymentInstrumentCapability.some((p) =>
        row.profile.paymentInstrumentCapability.includes(p),
      );
      if (!overlap) return false;
    }
    return true;
  });

  filtered.sort((a, b) => {
    // Tier ASC (1 before 2 before 3 before null), confidence DESC.
    const tierA = a.profile.tier ?? 99;
    const tierB = b.profile.tier ?? 99;
    if (tierA !== tierB) return tierA - tierB;
    return b.profile.confidenceScore - a.profile.confidenceScore;
  });

  return filtered.slice(0, limit);
}

export type RankedBuyerMatch = FuelBuyerMatch & {
  /** Why this buyer fits the cargo. */
  matchReasons: string[];
  /** 0-100 fit score; higher = better match. Composed of segment
   *  fit, volume fit, geographic fit, payment-instrument fit. */
  matchScore: number;
};

/**
 * Match a specific cargo (volume, fuel type, discharge port) to
 * ranked candidate buyers. Backs `match_cargo_to_buyers`.
 *
 * Scoring (0-100):
 *   +40 fuel-type match
 *   +25 geographic feasibility (country contains discharge port OR
 *       country in caribbeanCountriesOperated)
 *   +20 volume fit (typical cargo size envelope contains the cargo)
 *   +15 payment-instrument fit (when a paymentInstrumentRequired is
 *       supplied)
 *   - tier penalty applied at sort: tier 1 +10, tier 2 +0, tier 3 -10
 */
export async function matchCargoToFuelBuyers(args: {
  fuelType: string;
  volumeMt: number;
  /** ISO-2 country of discharge — port-to-country resolution is
   *  the caller's responsibility. */
  dischargeCountry: string;
  /** Optional payment instrument the cargo requires (e.g. 'lc-sight'). */
  paymentInstrumentRequired?: string;
  limit?: number;
}): Promise<RankedBuyerMatch[]> {
  const limit = Math.min(args.limit ?? 25, 100);
  const candidates = await findCaribbeanFuelBuyers({
    fuelTypes: [args.fuelType],
    minConfidenceScore: 0.5,
    limit: 500,
  });

  const ranked: RankedBuyerMatch[] = [];
  for (const c of candidates) {
    const reasons: string[] = [];
    let score = 0;

    if (c.profile.fuelTypesPurchased.includes(args.fuelType)) {
      score += 40;
      reasons.push(`buys ${args.fuelType} at cargo scale`);
    }

    const geoFit =
      c.country === args.dischargeCountry ||
      c.profile.caribbeanCountriesOperated.includes(args.dischargeCountry);
    if (geoFit) {
      score += 25;
      reasons.push(`operates in ${args.dischargeCountry}`);
    } else {
      // No geo fit at all = drop it.
      continue;
    }

    const cargoMin = c.profile.typicalCargoSizeMtMin;
    const cargoMax = c.profile.typicalCargoSizeMtMax;
    if (cargoMin != null && cargoMax != null) {
      if (args.volumeMt >= cargoMin && args.volumeMt <= cargoMax) {
        score += 20;
        reasons.push(`typical cargo ${cargoMin}-${cargoMax} MT contains ${args.volumeMt} MT`);
      } else if (args.volumeMt < cargoMin) {
        reasons.push(
          `cargo ${args.volumeMt} MT is below buyer's typical floor ${cargoMin} MT — may need parcel split`,
        );
      } else {
        reasons.push(
          `cargo ${args.volumeMt} MT exceeds buyer's typical ceiling ${cargoMax} MT — may need multi-buyer split`,
        );
      }
    }

    if (args.paymentInstrumentRequired) {
      if (
        c.profile.paymentInstrumentCapability.includes(args.paymentInstrumentRequired)
      ) {
        score += 15;
        reasons.push(`clears ${args.paymentInstrumentRequired}`);
      } else {
        reasons.push(
          `does NOT clear ${args.paymentInstrumentRequired} — payment instrument mismatch`,
        );
      }
    }

    if (c.profile.tier === 1) score += 10;
    else if (c.profile.tier === 3) score -= 10;

    ranked.push({ ...c, matchReasons: reasons, matchScore: score });
  }

  ranked.sort((a, b) => b.matchScore - a.matchScore);
  return ranked.slice(0, limit);
}

export type CountryDemandSummary = {
  country: string;
  totalBuyersTracked: number;
  segmentBreakdown: Array<{
    segment: string;
    buyerCount: number;
    estimatedAnnualVolumeBblMin: number;
    estimatedAnnualVolumeBblMax: number;
    topBuyers: Array<{ slug: string; name: string; tier: 1 | 2 | 3 | null }>;
  }>;
  fuelTypeBreakdown: Array<{ fuelType: string; buyerCount: number }>;
  totalEstimatedAnnualVolumeBblMin: number;
  totalEstimatedAnnualVolumeBblMax: number;
  notes: string[];
};

/**
 * Summarize fuel demand structure for a country. Backs
 * `analyze_caribbean_fuel_demand`.
 */
export async function analyzeCaribbeanFuelDemand(args: {
  country: string;
  fuelType?: string;
}): Promise<CountryDemandSummary> {
  const buyers = await findCaribbeanFuelBuyers({
    inCountries: [args.country],
    fuelTypes: args.fuelType ? [args.fuelType] : undefined,
    minConfidenceScore: 0,
    limit: 1000,
  });

  const segmentMap = new Map<
    string,
    {
      buyerCount: number;
      volMin: number;
      volMax: number;
      buyers: Array<{ slug: string; name: string; tier: 1 | 2 | 3 | null }>;
    }
  >();
  const fuelMap = new Map<string, number>();
  let totalMin = 0;
  let totalMax = 0;

  for (const b of buyers) {
    const min = b.profile.annualPurchaseVolumeBblMin ?? 0;
    const max = b.profile.annualPurchaseVolumeBblMax ?? 0;
    totalMin += min;
    totalMax += max;
    for (const s of b.profile.segments) {
      const slot = segmentMap.get(s) ?? { buyerCount: 0, volMin: 0, volMax: 0, buyers: [] };
      slot.buyerCount += 1;
      slot.volMin += min;
      slot.volMax += max;
      if (slot.buyers.length < 5) {
        slot.buyers.push({ slug: b.slug, name: b.name, tier: b.profile.tier });
      }
      segmentMap.set(s, slot);
    }
    for (const f of b.profile.fuelTypesPurchased) {
      fuelMap.set(f, (fuelMap.get(f) ?? 0) + 1);
    }
  }

  const segmentBreakdown = [...segmentMap.entries()]
    .sort((a, b) => b[1].volMax - a[1].volMax || b[1].buyerCount - a[1].buyerCount)
    .map(([segment, v]) => ({
      segment,
      buyerCount: v.buyerCount,
      estimatedAnnualVolumeBblMin: v.volMin,
      estimatedAnnualVolumeBblMax: v.volMax,
      topBuyers: v.buyers,
    }));
  const fuelTypeBreakdown = [...fuelMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([fuelType, buyerCount]) => ({ fuelType, buyerCount }));

  const notes: string[] = [];
  if (buyers.length === 0) {
    notes.push(
      `No fuel-buyer-industrial entities tracked for ${args.country} yet. ` +
        'Populate via curated-utilities seed or OCDS / customs ingestion.',
    );
  } else if (totalMax === 0) {
    notes.push(
      `${buyers.length} buyers tracked but no volume estimates populated. ` +
        'Volume figures are placeholder until Phase 1 hand-curation completes.',
    );
  }

  return {
    country: args.country,
    totalBuyersTracked: buyers.length,
    segmentBreakdown,
    fuelTypeBreakdown,
    totalEstimatedAnnualVolumeBblMin: totalMin,
    totalEstimatedAnnualVolumeBblMax: totalMax,
    notes,
  };
}

// ─── Fuel-buyer import context (declared mix × actual country flows) ─

export type FuelBuyerImportContext = {
  buyerSlug: string;
  buyerName: string;
  buyerCountry: string;
  /** HS code group used for the customs aggregation. 2710 covers
   *  refined-product imports broadly; per-fuel-type sub-codes
   *  (271012 light oils, 271019 medium/heavy, 271020 fuel oil)
   *  could be added later for finer attribution. */
  productCode: string;
  monthsLookback: number;
  /** Country's total imports of `productCode` over the window. */
  countryImportTotalKg: number | null;
  /** Buyer's declared annual purchase volume from their profile,
   *  converted to kg using barrel→tonne assumption (~7.3 bbl/MT
   *  for residual + middle distillate; we use 7.0 for blended
   *  refined-product accounting since the mix tilts heavier in
   *  the Caribbean utility universe). */
  buyerVolumeBblMin: number | null;
  buyerVolumeBblMax: number | null;
  buyerVolumeKgMin: number | null;
  buyerVolumeKgMax: number | null;
  /** Buyer's implied share of country imports (max-volume basis).
   *  NULL when either side is missing. */
  impliedShareOfCountryMax: number | null;
  fuelTypesDeclared: string[];
  /** Per-partner-country breakdown of where the country actually
   *  imports refined product from. Sorted by quantity DESC.
   *  Surfaces "Jamaica imported 8.2M kg of HFO from US, 3.1M from
   *  Russia, 1.4M from Aruba" — buyer's exposure profile by source. */
  partnerBreakdown: Array<{
    partnerCountry: string;
    quantityKg: number | null;
    valueUsd: number | null;
    monthsActive: number;
    mostRecentPeriod: string | null;
  }>;
  notes: string[];
};

const BBL_PER_MT_REFINED_BLEND = 7.0;
const KG_PER_MT = 1000;

/**
 * Country-level imports of refined product (HS 2710 by default)
 * cross-referenced against the buyer's declared annual purchase
 * volume + fuel mix. Validates whether the buyer's profile is
 * plausible given country-level customs data, and surfaces
 * partner-country source mix for outreach context.
 *
 * Granularity: country-level imports vs entity-level claim — same
 * limitation as `getRefineryImportContext` for refineries. We can
 * say "Jamaica imports 12M bbl HFO/yr; JPS claims 2.5-4M = 20-33%
 * — plausible". We can't say "JPS imported X cargoes specifically"
 * — that requires per-cargo AIS+commercial data.
 *
 * Returns null when the buyer slug doesn't resolve OR isn't a
 * fuel-buyer-industrial role.
 */
export async function getFuelBuyerImportContext(
  buyerSlug: string,
  options: {
    productCode?: string;
    monthsLookback?: number;
  } = {},
): Promise<FuelBuyerImportContext | null> {
  const productCode = options.productCode ?? '2710';
  const monthsLookback = options.monthsLookback ?? 12;

  const [buyer] = await db
    .select({
      slug: knownEntities.slug,
      name: knownEntities.name,
      country: knownEntities.country,
      role: knownEntities.role,
      metadata: knownEntities.metadata,
    })
    .from(knownEntities)
    .where(eq(knownEntities.slug, buyerSlug))
    .limit(1);
  if (!buyer || buyer.role !== 'fuel-buyer-industrial') return null;

  const meta = buyer.metadata as { fuelBuyerProfile?: Record<string, unknown> } | null;
  const profile = meta?.fuelBuyerProfile ?? {};
  const fuelTypesDeclared = Array.isArray(profile.fuelTypesPurchased)
    ? (profile.fuelTypesPurchased as string[])
    : [];
  const buyerVolumeBblMin =
    typeof profile.annualPurchaseVolumeBblMin === 'number'
      ? profile.annualPurchaseVolumeBblMin
      : null;
  const buyerVolumeBblMax =
    typeof profile.annualPurchaseVolumeBblMax === 'number'
      ? profile.annualPurchaseVolumeBblMax
      : null;

  // Aggregate country imports by partner.
  const partnerRows = await db.execute(sql`
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
              WHEN ${buyer.country} IN ('AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE')
                AND source = 'eurostat-comext' THEN 1
              WHEN source = 'un-comtrade' THEN 2
              ELSE 3
            END
        ) AS rn
      FROM customs_imports
      WHERE
        reporter_country = ${buyer.country}
        AND product_code = ${productCode}
        AND flow_direction = 'import'
        AND period >= date_trunc('month', NOW() - (${monthsLookback}::int || ' months')::interval)
    )
    SELECT
      partner_country,
      SUM(quantity_kg)            AS quantity_kg,
      SUM(value_usd)              AS value_usd,
      COUNT(DISTINCT period)::int AS months_active,
      to_char(MAX(period), 'YYYY-MM') AS most_recent_period
    FROM ranked
    WHERE rn = 1
    GROUP BY partner_country
    ORDER BY quantity_kg DESC NULLS LAST
    LIMIT 25;
  `);
  const partnerBreakdown = (partnerRows.rows as Array<Record<string, unknown>>).map((r) => ({
    partnerCountry: String(r.partner_country),
    quantityKg: r.quantity_kg == null ? null : Number.parseFloat(String(r.quantity_kg)),
    valueUsd: r.value_usd == null ? null : Number.parseFloat(String(r.value_usd)),
    monthsActive: Number(r.months_active ?? 0),
    mostRecentPeriod: r.most_recent_period == null ? null : String(r.most_recent_period),
  }));

  const countryImportTotalKg = partnerBreakdown.reduce(
    (acc, r) => (r.quantityKg == null ? acc : (acc ?? 0) + r.quantityKg),
    null as number | null,
  );

  // Convert buyer's bbl/yr → kg/yr for share comparison.
  const buyerVolumeKgMin =
    buyerVolumeBblMin != null
      ? (buyerVolumeBblMin / BBL_PER_MT_REFINED_BLEND) * KG_PER_MT
      : null;
  const buyerVolumeKgMax =
    buyerVolumeBblMax != null
      ? (buyerVolumeBblMax / BBL_PER_MT_REFINED_BLEND) * KG_PER_MT
      : null;
  const impliedShareOfCountryMax =
    countryImportTotalKg != null && buyerVolumeKgMax != null && countryImportTotalKg > 0
      ? buyerVolumeKgMax / countryImportTotalKg
      : null;

  const notes: string[] = [];
  if (partnerBreakdown.length === 0) {
    notes.push(
      `No customs flows found for ${buyer.country} HS ${productCode} in ` +
        `the last ${monthsLookback} months. Either the country isn't covered ` +
        `by Eurostat / UN Comtrade ingest, or imports were genuinely zero.`,
    );
  }
  if (impliedShareOfCountryMax != null) {
    if (impliedShareOfCountryMax > 1.0) {
      notes.push(
        `Buyer's declared volume (${(buyerVolumeKgMax! / 1_000_000).toFixed(1)}M kg) ` +
          `exceeds country's total HS ${productCode} imports ` +
          `(${(countryImportTotalKg! / 1_000_000).toFixed(1)}M kg) — declared volume ` +
          `is high or includes domestic refining offtake not captured by customs.`,
      );
    } else if (impliedShareOfCountryMax > 0.6) {
      notes.push(
        `Buyer's declared volume implies >60% of country imports — plausible for ` +
          `dominant utilities but verify against the volume confidence flag.`,
      );
    }
  }

  return {
    buyerSlug,
    buyerName: buyer.name,
    buyerCountry: buyer.country,
    productCode,
    monthsLookback,
    countryImportTotalKg,
    buyerVolumeBblMin,
    buyerVolumeBblMax,
    buyerVolumeKgMin,
    buyerVolumeKgMax,
    impliedShareOfCountryMax,
    fuelTypesDeclared,
    partnerBreakdown,
    notes,
  };
}

// ─── Refinery import context (slate × actual flows) ─────────────

export type RefineryImportContext = {
  refinerySlug: string;
  refineryName: string;
  refineryCountry: string;
  /** HS code used for the customs aggregation (2709 = crude). */
  productCode: string;
  /** Lookback window in months (default 12). */
  monthsLookback: number;
  /**
   * Per slate-compatible grade: how much of that grade's origin
   * country DID the refinery's country actually import in the
   * window? Aggregated at country-pair level (Eurostat / UN
   * Comtrade resolution); per-cargo attribution is out of scope.
   *
   * Sorted by `quantityKg DESC NULLS LAST` so the largest realized
   * flows surface first — that's the strongest "the slate envelope
   * isn't lying" signal.
   */
  rows: Array<{
    gradeSlug: string;
    gradeName: string;
    gradeOriginCountry: string;
    gradeApiGravity: number | null;
    gradeSulfurPct: number | null;
    /** Total imported mass over the lookback. NULL when no rows
     *  exist in customs_imports for the (refinery_country,
     *  grade_origin_country) pair. */
    quantityKg: number | null;
    valueUsd: number | null;
    monthsActive: number;
    mostRecentPeriod: string | null;
  }>;
  /**
   * Aggregate hint for the panel header: how many grades the
   * refinery is theoretically slate-fit to run, vs how many of
   * those have any actual import evidence.
   */
  summary: {
    slateCompatibleGradeCount: number;
    gradesWithImportEvidence: number;
    totalQuantityKg: number | null;
  };
};

/**
 * Cross-reference a refinery's slate against its country's actual
 * crude import flows. Answers the gap that pure slate-compatibility
 * misses: an envelope can SAY a refinery accepts Es Sider, but if
 * the country has imported ZERO Libyan crude in the last 12 months
 * the slate window is hypothetical — the buyer relationship doesn't
 * exist yet.
 *
 * Granularity: customs flows are reporter × partner country level
 * (Eurostat / UN Comtrade). We can't say "Sannazzaro specifically
 * ran Es Sider"; we can say "Italy imported 8.2M kg of Libyan
 * crude over the last 12 months and Sannazzaro's slate accepts
 * it" — vastly stronger signal than slate alone.
 *
 * Default product code: HS 2709 (crude petroleum). Caller can pass
 * a refined-products code (HS 2710) for refiner profiles where
 * crude-side flows aren't the right framing — but that's an edge
 * case; v1 ships with the crude default.
 */
export async function getRefineryImportContext(
  refinerySlug: string,
  options: {
    productCode?: string;
    monthsLookback?: number;
  } = {},
): Promise<RefineryImportContext | null> {
  const productCode = options.productCode ?? '2709';
  const monthsLookback = options.monthsLookback ?? 12;

  // Pull the slate-compatible grades for this refinery. Reuse the
  // existing helper so the slate-fit semantics stay in one place.
  const slateRows = await findGradesForRefinery({
    refinerySlug,
    compatibleOnly: true,
    limit: 100,
  });
  if (slateRows.length === 0) return null;

  const refineryCountry = slateRows[0]!.refineryCountry;
  const refineryName = slateRows[0]!.refineryName;

  // Collect distinct origin countries for the slate-fit grades,
  // skip nulls (grades without an origin country can't be matched
  // to import flows).
  const origins = Array.from(
    new Set(
      slateRows
        .map((r) => r.gradeOriginCountry)
        .filter((c): c is string => Boolean(c)),
    ),
  );

  let flowByOrigin = new Map<
    string,
    { quantityKg: number | null; valueUsd: number | null; monthsActive: number; mostRecentPeriod: string | null }
  >();
  if (origins.length > 0) {
    // Aggregate over the lookback window per partner country. Same
    // source-priority dedup as getMonthlyImportFlow (Eurostat for
    // EU reporters, UN Comtrade fallback) so cross-source double-
    // counting doesn't inflate totals.
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
                WHEN ${refineryCountry} IN ('AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE')
                  AND source = 'eurostat-comext' THEN 1
                WHEN source = 'un-comtrade' THEN 2
                ELSE 3
              END
          ) AS rn
        FROM customs_imports
        WHERE
          reporter_country = ${refineryCountry}
          AND product_code = ${productCode}
          AND flow_direction = 'import'
          AND partner_country = ANY(${pgArray(origins)})
          AND period >= date_trunc('month', NOW() - (${monthsLookback}::int || ' months')::interval)
      )
      SELECT
        partner_country,
        SUM(quantity_kg)            AS quantity_kg,
        SUM(value_usd)              AS value_usd,
        COUNT(DISTINCT period)::int AS months_active,
        to_char(MAX(period), 'YYYY-MM') AS most_recent_period
      FROM ranked
      WHERE rn = 1
      GROUP BY partner_country;
    `);
    for (const row of result.rows as Array<Record<string, unknown>>) {
      const origin = String(row.partner_country);
      flowByOrigin.set(origin, {
        quantityKg: row.quantity_kg == null ? null : Number.parseFloat(String(row.quantity_kg)),
        valueUsd: row.value_usd == null ? null : Number.parseFloat(String(row.value_usd)),
        monthsActive: Number(row.months_active ?? 0),
        mostRecentPeriod: row.most_recent_period == null ? null : String(row.most_recent_period),
      });
    }
  }

  const rows = slateRows
    .filter((r) => r.gradeOriginCountry != null)
    .map((r) => {
      const flow = flowByOrigin.get(r.gradeOriginCountry!);
      return {
        gradeSlug: r.gradeSlug,
        gradeName: r.gradeName,
        gradeOriginCountry: r.gradeOriginCountry!,
        gradeApiGravity: r.gradeApiGravity,
        gradeSulfurPct: r.gradeSulfurPct,
        quantityKg: flow?.quantityKg ?? null,
        valueUsd: flow?.valueUsd ?? null,
        monthsActive: flow?.monthsActive ?? 0,
        mostRecentPeriod: flow?.mostRecentPeriod ?? null,
      };
    })
    .sort((a, b) => {
      // Bigger flow first; null flows fall to the bottom.
      if (a.quantityKg == null && b.quantityKg == null) return 0;
      if (a.quantityKg == null) return 1;
      if (b.quantityKg == null) return -1;
      return b.quantityKg - a.quantityKg;
    });

  const totalQuantityKg = rows.reduce(
    (acc, r) => (r.quantityKg == null ? acc : (acc ?? 0) + r.quantityKg),
    null as number | null,
  );

  return {
    refinerySlug,
    refineryName,
    refineryCountry,
    productCode,
    monthsLookback,
    rows,
    summary: {
      slateCompatibleGradeCount: slateRows.length,
      gradesWithImportEvidence: rows.filter((r) => r.quantityKg != null && r.quantityKg > 0).length,
      totalQuantityKg,
    },
  };
}
// ─── Recursive ownership walks (work item 2) ──────────────────────

export type OwnershipEdge = {
  /** Distance from the seed entity (1 = direct parent / direct subsidiary). */
  depth: number;
  /** GEM IDs of the chain from the seed to this node, inclusive. */
  path: string[];
  subjectGemId: string;
  subjectName: string;
  parentGemId: string;
  parentName: string;
  sharePct: number | null;
  shareImputed: boolean;
  sourceUrls: string | null;
};

/**
 * Walk the ownership graph upward from `entityName` — every parent
 * relationship at every level, capped at `maxDepth`. Backed by the
 * `lookup_ownership_chain_up` SQL function (migration 0058).
 *
 * Different from `getOwnershipChain` (which returns ONE highest-share
 * parent per level): this returns ALL parents. Eni S.p.A. surfaces
 * with both its 30% Italian govt edge AND its 70% public-float edge,
 * not just the dominant one.
 *
 * Returns empty when the entity isn't found in `entity_ownership` at
 * all (the trigram fuzzy-match seed found nothing above the
 * similarity threshold).
 */
export async function walkOwnershipChainUp(args: {
  entityName: string;
  maxDepth?: number;
  minSimilarity?: number;
}): Promise<OwnershipEdge[]> {
  const result = await runOwnershipQuery(() =>
    db.execute(sql`
      SELECT
        depth, subject_gem_id, subject_name, parent_gem_id, parent_name,
        share_pct, share_imputed, source_urls, path
      FROM lookup_ownership_chain_up(
        ${args.entityName},
        ${args.maxDepth ?? 10}::int,
        ${args.minSimilarity ?? 0.55}::numeric
      );
    `),
  );
  if (!result) return [];
  return (result.rows as Array<Record<string, unknown>>).map(rowToOwnershipEdge);
}

/**
 * Walk the ownership graph downward — every subsidiary at every level
 * owned (>= `minSharePct`) by `entityName`. Backed by the
 * `lookup_subsidiaries` SQL function.
 *
 * `minSharePct=50` gives "controlling-interest" subsidiaries (the OFAC
 * 50% Rule view of the holding's footprint); `0` (default) returns
 * every relationship reported.
 */
export async function walkSubsidiaries(args: {
  entityName: string;
  minSharePct?: number;
  maxDepth?: number;
  minSimilarity?: number;
}): Promise<OwnershipEdge[]> {
  const result = await runOwnershipQuery(() =>
    db.execute(sql`
      SELECT
        depth, parent_gem_id, parent_name, subject_gem_id, subject_name,
        share_pct, share_imputed, source_urls, path
      FROM lookup_subsidiaries(
        ${args.entityName},
        ${args.maxDepth ?? 10}::int,
        ${args.minSharePct ?? 0}::numeric,
        ${args.minSimilarity ?? 0.55}::numeric
      );
    `),
  );
  if (!result) return [];
  return (result.rows as Array<Record<string, unknown>>).map(rowToOwnershipEdge);
}

function rowToOwnershipEdge(r: Record<string, unknown>): OwnershipEdge {
  return {
    depth: Number(r.depth),
    path: Array.isArray(r.path) ? (r.path as string[]) : [],
    subjectGemId: String(r.subject_gem_id),
    subjectName: String(r.subject_name),
    parentGemId: String(r.parent_gem_id),
    parentName: String(r.parent_name),
    sharePct: r.share_pct == null ? null : Number.parseFloat(String(r.share_pct)),
    shareImputed: Boolean(r.share_imputed),
    sourceUrls: r.source_urls == null ? null : String(r.source_urls),
  };
}

// ─── Match-queue signal performance (work item 3) ────────────────

export type MatchSignalPerformanceRow = {
  signalKind: string;
  total90d: number;
  actioned90d: number;
  closedWon90d: number;
  closedLost90d: number;
  /** % of matches the operator chose to push (vs dismissed). */
  actionRatePct: number | null;
  /** % of matches that converted to closed_won. */
  closeRatePct: number | null;
  /** Of pushed matches, % that converted (excludes the dismissed
   *  filter from the denominator). */
  conversionRatePct: number | null;
  avgMarginWonUsd: number | null;
  totalMarginWonUsd: number | null;
};

/**
 * Trailing-90d match-queue conversion rates per signal_kind, sourced
 * from the `match_signal_performance` view (migration 0059).
 *
 * Powers two surfaces:
 *   1. The `analyze_match_signal_performance` chat tool — operator
 *      asks "which signals are converting" / "should we keep
 *      surfacing distress events?" and gets empirical conversion
 *      data.
 *   2. The future scoring-calibration job — replaces the static
 *      heuristic weights with rolling close-rate per signal_kind.
 */
export async function getMatchSignalPerformance(): Promise<MatchSignalPerformanceRow[]> {
  const result = await db.execute(sql`
    SELECT
      signal_kind,
      total_90d,
      actioned_90d,
      closed_won_90d,
      closed_lost_90d,
      action_rate_pct,
      close_rate_pct,
      conversion_rate_pct,
      avg_margin_won_usd,
      total_margin_won_usd
    FROM match_signal_performance;
  `);
  return (result.rows as Array<Record<string, unknown>>).map((r) => ({
    signalKind: String(r.signal_kind),
    total90d: Number(r.total_90d ?? 0),
    actioned90d: Number(r.actioned_90d ?? 0),
    closedWon90d: Number(r.closed_won_90d ?? 0),
    closedLost90d: Number(r.closed_lost_90d ?? 0),
    actionRatePct: r.action_rate_pct == null ? null : Number(r.action_rate_pct),
    closeRatePct: r.close_rate_pct == null ? null : Number(r.close_rate_pct),
    conversionRatePct:
      r.conversion_rate_pct == null ? null : Number(r.conversion_rate_pct),
    avgMarginWonUsd:
      r.avg_margin_won_usd == null ? null : Number(r.avg_margin_won_usd),
    totalMarginWonUsd:
      r.total_margin_won_usd == null ? null : Number(r.total_margin_won_usd),
  }));
}

// ─── Country-level trade pattern (work item 5) ──────────────────

export type CountryTradePatternResult = {
  /** Reporter country (ISO-2) — the importer / consumer side. */
  reporterCountry: string;
  /** Source-country breakdown for inbound flows, OR null when the
   *  caller asked for an export-side view (then `partnerBreakdown`
   *  is the destination breakdown). */
  productCodeRanges: string[];
  flowDirection: 'import' | 'export';
  windowMonths: number;
  /** Aggregated summary over the window. */
  totals: {
    quantityKg: number | null;
    valueUsd: number | null;
    monthsWithData: number;
  };
  /** Year-over-year comparison: window vs prior window. NULL ratios
   *  when prior window has no data. */
  yoy: {
    quantityKgPrior: number | null;
    valueUsdPrior: number | null;
    quantityChangePct: number | null;
    valueChangePct: number | null;
  };
  /** Month-over-month series, oldest → newest. Length = windowMonths. */
  monthly: Array<{
    period: string;
    quantityKg: number | null;
    valueUsd: number | null;
  }>;
  /** Top-N partner countries by total value over the window. For
   *  imports, these are the source countries. For exports, destinations. */
  topPartners: Array<{
    partnerCountry: string;
    quantityKg: number | null;
    valueUsd: number | null;
    sharePct: number | null;
  }>;
  /** True when no rows matched the filter (clear "no coverage"
   *  signal for the chat surface — Caribbean-internal flows aren't
   *  in Eurostat, etc.). */
  noData: boolean;
};

/**
 * Country-level trade pattern report — total volume + value, MoM
 * series, YoY comparison, top trading partners — for a given
 * (country, HS code prefix(es)) over a sliding window.
 *
 * Two framings:
 *   - flowDirection='import': "imports INTO `reporterCountry` for
 *     these HS codes from anywhere". `topPartners` = source countries.
 *   - flowDirection='export': "exports FROM `reporterCountry` (which
 *     is encoded in the data as partner_country) to anywhere".
 *     `topPartners` = destination countries.
 *
 * Coverage caveat: today's data is Eurostat Comext (EU reporters) +
 * UN Comtrade. Caribbean-internal / intra-Latam / intra-Africa flows
 * may be missing. `noData=true` when the filter returns zero rows.
 *
 * Brief: docs/data-graph-connections-brief.md §6 (work item 5).
 */
export async function analyzeCountryTradePattern(args: {
  country: string;
  productCodeRanges: string[];
  flowDirection?: 'import' | 'export';
  /** Default 24. Capped at 60 (Eurostat depth). */
  windowMonths?: number;
  /** Default 5; cap 20. */
  topPartnerLimit?: number;
}): Promise<CountryTradePatternResult> {
  const flowDirection = args.flowDirection ?? 'import';
  const windowMonths = Math.min(args.windowMonths ?? 24, 60);
  const topN = Math.min(args.topPartnerLimit ?? 5, 20);

  // For import view we filter by reporter_country = X. For export
  // view we filter by partner_country = X (since the data encodes
  // exports as imports reported from the importer's side).
  const directionExpr =
    flowDirection === 'import'
      ? sql`reporter_country = ${args.country} AND flow_direction = 'import'`
      : sql`partner_country = ${args.country} AND flow_direction = 'import'`;
  // Match HS codes by prefix — a 4-digit "2710" range matches
  // "271019", "27101931", etc. via LIKE.
  const codeFilters = args.productCodeRanges.map(
    (p) => sql`product_code LIKE ${p + '%'}`,
  );
  const productExpr = sql.join(codeFilters, sql` OR `);

  const totalsRow = await db.execute(sql`
    SELECT
      SUM(quantity_kg)::numeric AS quantity_kg,
      SUM(value_usd)::numeric   AS value_usd,
      COUNT(DISTINCT period)::int AS months_with_data
    FROM customs_imports
    WHERE
      ${directionExpr}
      AND (${productExpr})
      AND period >= NOW() - (${windowMonths}::int || ' months')::interval;
  `);
  const totals = (totalsRow.rows as Array<Record<string, unknown>>)[0] ?? {};

  const priorRow = await db.execute(sql`
    SELECT
      SUM(quantity_kg)::numeric AS quantity_kg,
      SUM(value_usd)::numeric   AS value_usd
    FROM customs_imports
    WHERE
      ${directionExpr}
      AND (${productExpr})
      AND period >= NOW() - (${windowMonths * 2}::int || ' months')::interval
      AND period <  NOW() - (${windowMonths}::int || ' months')::interval;
  `);
  const prior = (priorRow.rows as Array<Record<string, unknown>>)[0] ?? {};

  const monthlyRows = await db.execute(sql`
    WITH series AS (
      SELECT generate_series(
        date_trunc('month', NOW() - (${windowMonths}::int || ' months')::interval),
        date_trunc('month', NOW()),
        '1 month'::interval
      )::date AS period
    ),
    buckets AS (
      SELECT
        period,
        SUM(quantity_kg)::numeric AS quantity_kg,
        SUM(value_usd)::numeric   AS value_usd
      FROM customs_imports
      WHERE
        ${directionExpr}
        AND (${productExpr})
      GROUP BY period
    )
    SELECT
      to_char(s.period, 'YYYY-MM') AS period,
      b.quantity_kg,
      b.value_usd
    FROM series s
    LEFT JOIN buckets b ON b.period = s.period
    ORDER BY s.period ASC;
  `);

  const partnerCol = flowDirection === 'import' ? sql`partner_country` : sql`reporter_country`;
  const topRows = await db.execute(sql`
    SELECT
      ${partnerCol} AS partner_country,
      SUM(quantity_kg)::numeric AS quantity_kg,
      SUM(value_usd)::numeric   AS value_usd
    FROM customs_imports
    WHERE
      ${directionExpr}
      AND (${productExpr})
      AND period >= NOW() - (${windowMonths}::int || ' months')::interval
    GROUP BY ${partnerCol}
    ORDER BY SUM(value_usd) DESC NULLS LAST,
             SUM(quantity_kg) DESC NULLS LAST
    LIMIT ${topN};
  `);

  const totalQty = numericOrNull(totals.quantity_kg as never);
  const totalValue = numericOrNull(totals.value_usd as never);
  const monthsWithData = Number(totals.months_with_data ?? 0);

  const priorQty = numericOrNull(prior.quantity_kg as never);
  const priorValue = numericOrNull(prior.value_usd as never);
  const quantityChangePct =
    totalQty != null && priorQty != null && priorQty > 0
      ? ((totalQty - priorQty) / priorQty) * 100
      : null;
  const valueChangePct =
    totalValue != null && priorValue != null && priorValue > 0
      ? ((totalValue - priorValue) / priorValue) * 100
      : null;

  const totalForShare = totalValue ?? 0;
  const topPartners = (topRows.rows as Array<Record<string, unknown>>).map((r) => {
    const valueUsd = numericOrNull(r.value_usd as never);
    return {
      partnerCountry: String(r.partner_country),
      quantityKg: numericOrNull(r.quantity_kg as never),
      valueUsd,
      sharePct:
        valueUsd != null && totalForShare > 0
          ? Math.round((valueUsd / totalForShare) * 1000) / 10
          : null,
    };
  });

  return {
    reporterCountry: args.country,
    productCodeRanges: args.productCodeRanges,
    flowDirection,
    windowMonths,
    totals: {
      quantityKg: totalQty,
      valueUsd: totalValue,
      monthsWithData,
    },
    yoy: {
      quantityKgPrior: priorQty,
      valueUsdPrior: priorValue,
      quantityChangePct: quantityChangePct == null ? null : Math.round(quantityChangePct * 10) / 10,
      valueChangePct: valueChangePct == null ? null : Math.round(valueChangePct * 10) / 10,
    },
    monthly: (monthlyRows.rows as Array<Record<string, unknown>>).map((r) => ({
      period: String(r.period),
      quantityKg: numericOrNull(r.quantity_kg as never),
      valueUsd: numericOrNull(r.value_usd as never),
    })),
    topPartners,
    noData: monthsWithData === 0 && topPartners.length === 0,
  };
}

/**
 * Resolve a known_entities slug to its `customsContext` mapping, if
 * the analyst has populated `metadata.customsContext`. Returns null
 * when the slug doesn't exist OR when no context is curated.
 *
 * Helper for the `analyze_country_trade_pattern` chat tool's
 * entity-driven path — the model can pass entitySlug and we resolve
 * the country + product codes automatically.
 */
export async function getEntityCustomsContext(
  slug: string,
): Promise<{
  entitySlug: string;
  entityName: string;
  context: import('./customs-context').CustomsContextMapping;
} | null> {
  const result = await db.execute(sql`
    SELECT slug, name, metadata
    FROM known_entities
    WHERE slug = ${slug}
    LIMIT 1;
  `);
  const row = (result.rows as Array<Record<string, unknown>>)[0];
  if (!row) return null;
  const { readCustomsContext } = await import('./customs-context');
  const context = readCustomsContext(row.metadata);
  if (!context) return null;
  return {
    entitySlug: String(row.slug),
    entityName: String(row.name),
    context,
  };
}
// ─── Cargo-trip aggregations (work item 4) ───────────────────────

export type EntityCargoActivitySummary = {
  entitySlug: string;
  entityName: string;
  windowDays: number;
  /** Side this entity sits on: 'discharge' (receiver — refinery /
   *  fuel depot) or 'load' (sender — producer terminal / marketing
   *  arm). Determined by whether the entity's nearest port is in
   *  cargo_trips.discharge_port_slug vs load_port_slug more often. */
  primarySide: 'discharge' | 'load' | 'mixed' | 'unknown';
  totals: {
    tripCount: number;
    totalVolumeBbl: number | null;
    avgVolumeBbl: number | null;
    avgConfidence: number | null;
  };
  topPorts: Array<{
    portSlug: string;
    /** 'discharge' or 'load' relative to THIS entity's port. */
    side: 'discharge' | 'load';
    tripCount: number;
    totalVolumeBbl: number | null;
  }>;
  topGrades: Array<{
    gradeSlug: string;
    tripCount: number;
    sharePct: number;
  }>;
  recentTrips: Array<{
    mmsi: string;
    loadPortSlug: string;
    dischargePortSlug: string;
    loadStartedAt: string;
    dischargeStartedAt: string;
    inferredGradeSlug: string | null;
    inferredVolumeBbl: number | null;
    confidence: number;
  }>;
  /** True when the entity has no nearby port OR no cargo_trips
   *  rows in the window. Don't treat as "no activity"; treat as
   *  "no observed activity in our AIS coverage." */
  noData: boolean;
};

/**
 * Per-entity cargo-trip activity summary. Resolves the entity's
 * nearest port via known_entities.lat/lng (50 nm radius), then
 * aggregates cargo_trips with that port on either side.
 *
 * Outputs:
 *   - primarySide: refinery (mostly discharges) vs producer
 *     marketing arm (mostly loads). 'mixed' when within 30%.
 *   - totals: trip count + volume (sum / mean), avg confidence.
 *   - topPorts: counterparty ports — for refineries this is the
 *     load origins; for producers it's the discharge destinations.
 *   - topGrades: % of trips per inferred_grade_slug (NULL grades
 *     excluded from the share calculation).
 *   - recentTrips: most recent 10 trips, full row.
 *
 * Brief: docs/data-graph-connections-brief.md §5 (work item 4).
 */
export async function analyzeEntityCargoActivity(args: {
  entitySlug: string;
  windowDays?: number;
  recentLimit?: number;
}): Promise<EntityCargoActivitySummary | null> {
  const windowDays = args.windowDays ?? 90;
  const recentLimit = Math.min(args.recentLimit ?? 10, 50);

  const entityRow = await db.execute(sql`
    SELECT slug, name, latitude::numeric AS lat, longitude::numeric AS lng
    FROM known_entities
    WHERE slug = ${args.entitySlug}
    LIMIT 1;
  `);
  const entity = (entityRow.rows as Array<Record<string, unknown>>)[0];
  if (!entity) return null;
  const lat = entity.lat == null ? null : Number(entity.lat);
  const lng = entity.lng == null ? null : Number(entity.lng);

  const empty: EntityCargoActivitySummary = {
    entitySlug: String(entity.slug),
    entityName: String(entity.name),
    windowDays,
    primarySide: 'unknown',
    totals: {
      tripCount: 0,
      totalVolumeBbl: null,
      avgVolumeBbl: null,
      avgConfidence: null,
    },
    topPorts: [],
    topGrades: [],
    recentTrips: [],
    noData: true,
  };

  if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return empty;
  }

  // Find ports within 50 nm of the entity.
  const portsRow = await db.execute(sql`
    SELECT slug
    FROM ports
    WHERE SQRT(
      POW((lat::numeric - ${lat}) * 60, 2) +
      POW((lng::numeric - ${lng}) * 60 * COS(RADIANS(${lat})), 2)
    ) <= 50;
  `);
  const portSlugs = (portsRow.rows as Array<{ slug: string }>).map((r) => r.slug);
  if (portSlugs.length === 0) return empty;

  // Pull all trips touching any nearby port within the window.
  const tripsRow = await db.execute(sql`
    SELECT
      ct.mmsi,
      ct.load_port_slug,
      ct.load_started_at,
      ct.discharge_port_slug,
      ct.discharge_started_at,
      ct.inferred_grade_slug,
      ct.inferred_volume_bbl,
      ct.confidence,
      CASE
        WHEN ct.discharge_port_slug = ANY(${pgArray(portSlugs)}) THEN 'discharge'
        ELSE 'load'
      END AS entity_side
    FROM cargo_trips ct
    WHERE (
      ct.load_port_slug = ANY(${pgArray(portSlugs)})
      OR ct.discharge_port_slug = ANY(${pgArray(portSlugs)})
    )
      AND ct.load_started_at >= NOW() - (${windowDays}::int * INTERVAL '1 day')
    ORDER BY ct.load_started_at DESC;
  `);
  const trips = tripsRow.rows as Array<Record<string, unknown>>;
  if (trips.length === 0) return empty;

  let dischargeCount = 0;
  let loadCount = 0;
  let totalVol = 0;
  let volSamples = 0;
  let totalConf = 0;
  const portCounts = new Map<string, { side: 'load' | 'discharge'; count: number; vol: number }>();
  const gradeCounts = new Map<string, number>();

  for (const t of trips) {
    const side = String(t.entity_side) as 'load' | 'discharge';
    if (side === 'discharge') dischargeCount += 1;
    else loadCount += 1;
    const vol = numericOrNull(t.inferred_volume_bbl as never);
    if (vol != null) {
      totalVol += vol;
      volSamples += 1;
    }
    const conf = numericOrNull(t.confidence as never) ?? 0;
    totalConf += conf;

    // The "counterparty port" is the OTHER side from the entity.
    const counterpartySlug =
      side === 'discharge'
        ? String(t.load_port_slug)
        : String(t.discharge_port_slug);
    const counterpartySide = side === 'discharge' ? 'load' : 'discharge';
    const cur = portCounts.get(counterpartySlug);
    if (cur) {
      cur.count += 1;
      if (vol != null) cur.vol += vol;
    } else {
      portCounts.set(counterpartySlug, {
        side: counterpartySide as 'load' | 'discharge',
        count: 1,
        vol: vol ?? 0,
      });
    }
    const grade = t.inferred_grade_slug == null ? null : String(t.inferred_grade_slug);
    if (grade) gradeCounts.set(grade, (gradeCounts.get(grade) ?? 0) + 1);
  }

  const total = trips.length;
  const dischargeRatio = dischargeCount / total;
  const primarySide: EntityCargoActivitySummary['primarySide'] =
    dischargeRatio >= 0.7
      ? 'discharge'
      : dischargeRatio <= 0.3
        ? 'load'
        : 'mixed';

  const knownGradeTotal = [...gradeCounts.values()].reduce((a, b) => a + b, 0);
  const topGrades = [...gradeCounts.entries()]
    .map(([gradeSlug, tripCount]) => ({
      gradeSlug,
      tripCount,
      sharePct:
        knownGradeTotal > 0
          ? Math.round((tripCount / knownGradeTotal) * 1000) / 10
          : 0,
    }))
    .sort((a, b) => b.tripCount - a.tripCount)
    .slice(0, 10);

  const topPorts = [...portCounts.entries()]
    .map(([portSlug, v]) => ({
      portSlug,
      side: v.side,
      tripCount: v.count,
      totalVolumeBbl: v.vol > 0 ? Math.round(v.vol * 100) / 100 : null,
    }))
    .sort((a, b) => b.tripCount - a.tripCount)
    .slice(0, 10);

  const recentTrips = trips.slice(0, recentLimit).map((t) => ({
    mmsi: String(t.mmsi),
    loadPortSlug: String(t.load_port_slug),
    dischargePortSlug: String(t.discharge_port_slug),
    loadStartedAt: String(t.load_started_at),
    dischargeStartedAt: String(t.discharge_started_at),
    inferredGradeSlug: t.inferred_grade_slug == null ? null : String(t.inferred_grade_slug),
    inferredVolumeBbl: numericOrNull(t.inferred_volume_bbl as never),
    confidence: Number(numericOrNull(t.confidence as never) ?? 0),
  }));

  return {
    entitySlug: String(entity.slug),
    entityName: String(entity.name),
    windowDays,
    primarySide,
    totals: {
      tripCount: total,
      totalVolumeBbl: volSamples > 0 ? Math.round(totalVol * 100) / 100 : null,
      avgVolumeBbl: volSamples > 0 ? Math.round((totalVol / volSamples) * 100) / 100 : null,
      avgConfidence: total > 0 ? Math.round((totalConf / total) * 100) / 100 : null,
    },
    topPorts,
    topGrades,
    recentTrips,
    noData: false,
  };
}

// ─── Crude grade detail (UI + chat card) ──────────────────────────

export type CrudeGradeDetailResult = {
  kind: 'crude_grade_detail';
  /** The curated reference row from crude_grades. */
  grade: {
    slug: string;
    name: string;
    originCountry: string | null;
    region: string | null;
    apiGravity: number | null;
    sulfurPct: number | null;
    tan: number | null;
    characterization: string | null;
    isMarker: boolean;
    markerSlug: string | null;
    differentialUsdPerBbl: number | null;
    notes: string | null;
  };
  /** Producer-published assays for this grade — typically 1-4 (one
   *  per source: ExxonMobil-unbranded, BP, Equinor, TotalEnergies).
   *  Sorted by assay date DESC so the freshest vintage is first. */
  assays: Array<{
    source: string;
    reference: string;
    name: string;
    sourceFile: string | null;
    originLabel: string | null;
    assayDate: string | null;
    sampleDate: string | null;
    densityKgL: number | null;
    apiGravity: number | null;
    bblPerMt: number | null;
    sulphurWtPct: number | null;
    pourPointC: number | null;
    acidityMgKohG: number | null;
    vanadiumMgKg: number | null;
    nickelMgKg: number | null;
    nitrogenMgKg: number | null;
    rvpKpa: number | null;
    viscosityCst20c: number | null;
    viscosityCst50c: number | null;
    mercaptanSulphurMgKg: number | null;
    h2sMgKg: number | null;
    waxAppearanceTempC: number | null;
    /** TBP cut yields — light → heavy, ordered by cut_order. */
    cuts: Array<{
      cutLabel: string;
      cutOrder: number;
      startTempC: number | null;
      endTempC: number | null;
      yieldWtPct: number | null;
      yieldVolPct: number | null;
      cumulativeYieldWtPct: number | null;
      densityKgL: number | null;
      sulphurWtPct: number | null;
    }>;
  }>;
  /** Refineries whose slate envelope accepts this grade. Sourced
   *  from the refinery_grade_compatibility view, sorted by Nelson
   *  complexity DESC. Empty when no slated refineries match. */
  compatibleRefineries: Array<{
    slug: string;
    name: string;
    country: string;
    complexityIndex: number | null;
    capacityBpd: number | null;
    apiCompatible: boolean;
    sulfurCompatible: boolean;
    tanCompatible: boolean;
  }>;
};

/**
 * Aggregate detail for a single crude grade — drives both the
 * `/crudes/[slug]` page and the in-chat `view_crude_grade_detail`
 * card. Returns null when slug doesn't exist.
 *
 * One round-trip but three sequential queries (grade row, assays
 * + cuts in a single SELECT, compatibility view). Acceptable for
 * a detail-page workload; not hot-pathed.
 */
export async function getCrudeGradeDetail(
  slug: string,
): Promise<CrudeGradeDetailResult | null> {
  const gradeRow = await db.execute(sql`
    SELECT slug, name, origin_country, region, api_gravity, sulfur_pct,
           tan, characterization, is_marker, marker_slug,
           differential_usd_per_bbl, notes
    FROM crude_grades
    WHERE slug = ${slug}
    LIMIT 1;
  `);
  const g = (gradeRow.rows as Array<Record<string, unknown>>)[0];
  if (!g) return null;

  // Assays + cuts in one go — left-join cuts onto assays so a grade
  // with no assays still returns the (empty) assays array.
  const assayRows = await db.execute(sql`
    SELECT
      ca.id,
      ca.source,
      ca.reference,
      ca.name,
      ca.source_file,
      ca.origin_label,
      ca.assay_date,
      ca.sample_date,
      ca.density_kg_l,
      ca.api_gravity,
      ca.bbl_per_mt,
      ca.sulphur_wt_pct,
      ca.pour_point_c,
      ca.acidity_mg_koh_g,
      ca.vanadium_mg_kg,
      ca.nickel_mg_kg,
      ca.nitrogen_mg_kg,
      ca.rvp_kpa,
      ca.viscosity_cst_20c,
      ca.viscosity_cst_50c,
      ca.mercaptan_sulphur_mg_kg,
      ca.h2s_mg_kg,
      ca.wax_appearance_temp_c
    FROM crude_assays ca
    WHERE ca.grade_slug = ${slug}
    ORDER BY ca.assay_date DESC NULLS LAST, ca.updated_at DESC;
  `);
  const assayList = assayRows.rows as Array<Record<string, unknown>>;

  // Pull all cuts for these assays in one shot.
  // Uses drizzle's `inArray` (vs raw `ANY(${arr}::uuid[])`) because
  // the Neon HTTP driver mis-serializes single-element JS arrays as
  // a bare uuid string — Postgres then errors with
  // `malformed array literal: "<uuid>"`. The query-builder path
  // composes a parameterized `IN (...)` clause that handles any
  // array length cleanly. (Sentry: NeonDbError, May 2026.)
  const assayIds = assayList.map((r) => String(r.id));
  const cutsByAssay = new Map<string, Array<Record<string, unknown>>>();
  if (assayIds.length > 0) {
    const cutDrizzleRows = await db
      .select({
        assayId: crudeAssayCuts.assayId,
        cutLabel: crudeAssayCuts.cutLabel,
        cutOrder: crudeAssayCuts.cutOrder,
        startTempC: crudeAssayCuts.startTempC,
        endTempC: crudeAssayCuts.endTempC,
        yieldWtPct: crudeAssayCuts.yieldWtPct,
        yieldVolPct: crudeAssayCuts.yieldVolPct,
        cumulativeYieldWtPct: crudeAssayCuts.cumulativeYieldWtPct,
        densityKgL: crudeAssayCuts.densityKgL,
        sulphurWtPct: crudeAssayCuts.sulphurWtPct,
      })
      .from(crudeAssayCuts)
      .where(inArray(crudeAssayCuts.assayId, assayIds))
      .orderBy(asc(crudeAssayCuts.assayId), asc(crudeAssayCuts.cutOrder));
    for (const c of cutDrizzleRows) {
      const aid = String(c.assayId);
      // Re-shape into the snake_case map shape the rest of this
      // function already expects so the call-site below stays
      // unchanged.
      const list = cutsByAssay.get(aid) ?? [];
      list.push({
        assay_id: c.assayId,
        cut_label: c.cutLabel,
        cut_order: c.cutOrder,
        start_temp_c: c.startTempC,
        end_temp_c: c.endTempC,
        yield_wt_pct: c.yieldWtPct,
        yield_vol_pct: c.yieldVolPct,
        cumulative_yield_wt_pct: c.cumulativeYieldWtPct,
        density_kg_l: c.densityKgL,
        sulphur_wt_pct: c.sulphurWtPct,
      });
      cutsByAssay.set(aid, list);
    }
  }

  const compatRows = await db.execute(sql`
    SELECT
      refinery_slug, refinery_name, refinery_country,
      slate_complexity_index, slate_capacity_bpd,
      api_compatible, sulfur_compatible, tan_compatible
    FROM refinery_grade_compatibility
    WHERE grade_slug = ${slug}
      AND slate_compatible = TRUE
    ORDER BY slate_complexity_index DESC NULLS LAST,
             slate_capacity_bpd DESC NULLS LAST
    LIMIT 50;
  `);

  return {
    kind: 'crude_grade_detail',
    grade: {
      slug: String(g.slug),
      name: String(g.name),
      originCountry: g.origin_country == null ? null : String(g.origin_country),
      region: g.region == null ? null : String(g.region),
      apiGravity: numericOrNull(g.api_gravity as never),
      sulfurPct: numericOrNull(g.sulfur_pct as never),
      tan: numericOrNull(g.tan as never),
      characterization: g.characterization == null ? null : String(g.characterization),
      isMarker: g.is_marker === true,
      markerSlug: g.marker_slug == null ? null : String(g.marker_slug),
      differentialUsdPerBbl: numericOrNull(g.differential_usd_per_bbl as never),
      notes: g.notes == null ? null : String(g.notes),
    },
    assays: assayList.map((a) => ({
      source: String(a.source),
      reference: String(a.reference),
      name: String(a.name),
      sourceFile: a.source_file == null ? null : String(a.source_file),
      originLabel: a.origin_label == null ? null : String(a.origin_label),
      assayDate: a.assay_date == null ? null : String(a.assay_date),
      sampleDate: a.sample_date == null ? null : String(a.sample_date),
      densityKgL: numericOrNull(a.density_kg_l as never),
      apiGravity: numericOrNull(a.api_gravity as never),
      bblPerMt: numericOrNull(a.bbl_per_mt as never),
      sulphurWtPct: numericOrNull(a.sulphur_wt_pct as never),
      pourPointC: numericOrNull(a.pour_point_c as never),
      acidityMgKohG: numericOrNull(a.acidity_mg_koh_g as never),
      vanadiumMgKg: numericOrNull(a.vanadium_mg_kg as never),
      nickelMgKg: numericOrNull(a.nickel_mg_kg as never),
      nitrogenMgKg: numericOrNull(a.nitrogen_mg_kg as never),
      rvpKpa: numericOrNull(a.rvp_kpa as never),
      viscosityCst20c: numericOrNull(a.viscosity_cst_20c as never),
      viscosityCst50c: numericOrNull(a.viscosity_cst_50c as never),
      mercaptanSulphurMgKg: numericOrNull(a.mercaptan_sulphur_mg_kg as never),
      h2sMgKg: numericOrNull(a.h2s_mg_kg as never),
      waxAppearanceTempC: numericOrNull(a.wax_appearance_temp_c as never),
      cuts: (cutsByAssay.get(String(a.id)) ?? []).map((c) => ({
        cutLabel: String(c.cut_label),
        cutOrder: Number(c.cut_order),
        startTempC: numericOrNull(c.start_temp_c as never),
        endTempC: numericOrNull(c.end_temp_c as never),
        yieldWtPct: numericOrNull(c.yield_wt_pct as never),
        yieldVolPct: numericOrNull(c.yield_vol_pct as never),
        cumulativeYieldWtPct: numericOrNull(c.cumulative_yield_wt_pct as never),
        densityKgL: numericOrNull(c.density_kg_l as never),
        sulphurWtPct: numericOrNull(c.sulphur_wt_pct as never),
      })),
    })),
    compatibleRefineries: (compatRows.rows as Array<Record<string, unknown>>).map((r) => ({
      slug: String(r.refinery_slug),
      name: String(r.refinery_name),
      country: String(r.refinery_country),
      complexityIndex: numericOrNull(r.slate_complexity_index as never),
      capacityBpd: numericOrNull(r.slate_capacity_bpd as never),
      apiCompatible: r.api_compatible === true,
      sulfurCompatible: r.sulfur_compatible === true,
      tanCompatible: r.tan_compatible === true,
    })),
  };
}

// ─── Crude grade index (UI catalog page) ─────────────────────────

export type CrudeGradeIndexRow = {
  slug: string;
  name: string;
  originCountry: string | null;
  region: string | null;
  apiGravity: number | null;
  sulfurPct: number | null;
  tan: number | null;
  characterization: string | null;
  isMarker: boolean;
  /** Marker this grade prices against (NULL on markers themselves). */
  markerSlug: string | null;
  /** $/bbl premium (+) or discount (-) vs marker. NULL on markers. */
  differentialUsdPerBbl: number | null;
  /** How many producer assays are linked to this grade. 0 means
   *  curated reference data only — chart/cut data not available
   *  on the detail page yet. */
  assayCount: number;
};

export type CrudeGradeIndexFilters = {
  /** Free-text substring match against `name` (ILIKE). */
  search?: string;
  region?: string;
  originCountry?: string;
  /** When true, return only sweet crudes (sulfur < 0.5% or NULL). */
  sweetOnly?: boolean;
  /** When true, return only light crudes (api >= 35 or NULL). */
  lightOnly?: boolean;
  /** When 'marker', only marker grades; 'non-marker', only non-markers. */
  markerFilter?: 'marker' | 'non-marker';
};

/**
 * Index-page query — every grade with the headline stats plus
 * assay-availability flag + marker pricing context. Single SQL pass
 * with a LEFT JOIN onto `crude_assays` for the count.
 *
 * Sorted: markers first, then by region, then by name. Stable order
 * across pageloads so the URL-driven filter UI feels deterministic.
 */
export async function listCrudeGradesForIndex(
  filters?: CrudeGradeIndexFilters,
): Promise<CrudeGradeIndexRow[]> {
  const result = await db.execute(sql`
    SELECT
      cg.slug, cg.name, cg.origin_country, cg.region,
      cg.api_gravity, cg.sulfur_pct, cg.tan, cg.characterization,
      cg.is_marker, cg.marker_slug, cg.differential_usd_per_bbl,
      COALESCE(a.assay_count, 0)::int AS assay_count
    FROM crude_grades cg
    LEFT JOIN (
      SELECT grade_slug, COUNT(*)::int AS assay_count
      FROM crude_assays
      WHERE grade_slug IS NOT NULL
      GROUP BY grade_slug
    ) a ON a.grade_slug = cg.slug
    WHERE 1=1
      ${
        filters?.search && filters.search.trim().length > 0
          ? sql`AND cg.name ILIKE ${`%${filters.search.trim()}%`}`
          : sql``
      }
      ${filters?.region ? sql`AND cg.region = ${filters.region}` : sql``}
      ${
        filters?.originCountry
          ? sql`AND cg.origin_country = ${filters.originCountry}`
          : sql``
      }
      ${
        filters?.sweetOnly
          ? sql`AND (cg.sulfur_pct IS NULL OR cg.sulfur_pct < 0.5)`
          : sql``
      }
      ${
        filters?.lightOnly
          ? sql`AND (cg.api_gravity IS NULL OR cg.api_gravity >= 35)`
          : sql``
      }
      ${
        filters?.markerFilter === 'marker'
          ? sql`AND cg.is_marker = TRUE`
          : filters?.markerFilter === 'non-marker'
            ? sql`AND cg.is_marker = FALSE`
            : sql``
      }
    ORDER BY cg.is_marker DESC, cg.region, cg.name;
  `);
  return (result.rows as Array<Record<string, unknown>>).map((r) => ({
    slug: String(r.slug),
    name: String(r.name),
    originCountry: r.origin_country == null ? null : String(r.origin_country),
    region: r.region == null ? null : String(r.region),
    apiGravity: numericOrNull(r.api_gravity as never),
    sulfurPct: numericOrNull(r.sulfur_pct as never),
    tan: numericOrNull(r.tan as never),
    characterization: r.characterization == null ? null : String(r.characterization),
    isMarker: r.is_marker === true,
    markerSlug: r.marker_slug == null ? null : String(r.marker_slug),
    differentialUsdPerBbl: numericOrNull(r.differential_usd_per_bbl as never),
    assayCount: Number(r.assay_count ?? 0),
  }));
}

// ─── Grade yield value (cut-weighted refined-product valuation) ───

/**
 * Cut-label → benchmark-series + handling. Producer assays don't
 * agree on a fixed cut vocabulary — TotalEnergies splits naphtha
 * into Light/Heavy, BP uses "Kero" / "Gas oil" / "Atm. residue",
 * Haverly-format reports emit start/end temps without canonical
 * names. We classify by lowercased label substring, falling back
 * to start_temp_c bins for the temperature-only producers.
 *
 * `multiplier` is what the cut contributes to the valuation:
 *   1.0  = full benchmark price
 *   <1.0 = downgraded for handling losses (residue cracking yield,
 *          intermediate streams that need further upgrade).
 * Tune the multipliers as real refining-margin calibration data
 * surfaces from the operator.
 */
const CUT_BENCHMARKS: Array<{
  match: (label: string, startC: number | null) => boolean;
  series: string;
  multiplier: number;
  category: 'lpg' | 'naphtha' | 'gasoline' | 'kerosene' | 'gasoil' | 'residue';
}> = [
  {
    match: (l) => /lpg|c3|c4|propane|butane/.test(l),
    series: 'brent',
    multiplier: 1.0, // No good LPG benchmark in the ingest yet — proxy off Brent at parity.
    category: 'lpg',
  },
  {
    match: (l, s) => /naphtha/.test(l) || (s != null && s < 175),
    series: 'nyh-gasoline',
    multiplier: 0.85, // Naphtha trades at a discount to finished gasoline.
    category: 'naphtha',
  },
  {
    match: (l) => /gasoline|mogas|reform/.test(l),
    series: 'nyh-gasoline',
    multiplier: 1.0,
    category: 'gasoline',
  },
  {
    match: (l, s) => /kero|jet|avtur/.test(l) || (s != null && s >= 175 && s < 250),
    series: 'nyh-heating-oil',
    multiplier: 1.05, // Jet typically over heating-oil benchmark.
    category: 'kerosene',
  },
  {
    match: (l, s) => /gas[- ]?oil|diesel|distillate|lgo|hgo/.test(l) || (s != null && s >= 250 && s < 360),
    series: 'nyh-diesel',
    multiplier: 1.0,
    category: 'gasoil',
  },
  {
    match: (l, s) => /residue|resid|bottoms|atmospheric|vacuum|vgo/.test(l) || (s != null && s >= 360),
    series: 'brent',
    multiplier: 0.7, // Residue → cracking yield haircut. Calibrate later.
    category: 'residue',
  },
];

export type GradeYieldValuation = {
  gradeSlug: string;
  gradeName: string;
  /** Source assay used for the cut yields. Latest sampleDate per grade. */
  assayReference: string;
  assaySource: string;
  assayDate: string | null;
  /** Per-cut contribution. Uses cut weight (yield_wt_pct) since the
   *  benchmark prices are mass-equivalent (USD/bbl with 1 bbl ≈ 1 unit). */
  contributions: Array<{
    cutLabel: string;
    category: string;
    yieldWtPct: number;
    benchmarkSeries: string;
    benchmarkPriceUsdBbl: number | null;
    multiplier: number;
    contributionUsdBbl: number | null;
  }>;
  /** Sum of contributions (USD/bbl crude equivalent). NULL when any
   *  required benchmark is missing. */
  grossProductValueUsdBbl: number | null;
  /** % of cuts that resolved to a benchmark — diagnostic for whether
   *  the assay's vocabulary mapped cleanly. < 80 % → result is rough. */
  cutsCoveredPct: number;
  notes: string[];
};

/**
 * Cut-weighted gross product value for a single crude grade. For
 * each cut in the most recent assay, look up the closest refined-
 * product benchmark and multiply by the cut's weight yield. Sum
 * = "what you'd theoretically realize from this crude at today's
 * product prices."
 *
 * Useful as a calibration check on FOB cost: a Brent-priced cargo
 * whose theoretical product value is $90/bbl while the FOB is
 * $82/bbl is a +$8 gross refining margin (before utilities + freight
 * + working capital — those land in compose_deal_economics). Lighter
 * grades (Bonny Light, Es Sider) typically value out 5-10 %above
 * Brent due to higher distillate yields; heavier sour grades
 * (Maya, Urals) are 5-15 % below.
 *
 * NOT a substitute for compose_deal_economics — this is a single-
 * grade reference number, not a P&L. Treat it as the "gross product
 * value vs. FOB" anchor; the calculator handles the per-trade
 * mechanics.
 */
export async function getGradeYieldValue(
  gradeSlug: string,
): Promise<GradeYieldValuation | null> {
  // Pick the most recent assay for this grade (by sample_date,
  // falling back to created_at when sample_date is null).
  const assayRows = await db.execute(sql`
    SELECT id, name, source, reference, sample_date::text AS sample_date
    FROM crude_assays
    WHERE grade_slug = ${gradeSlug}
    ORDER BY sample_date DESC NULLS LAST, created_at DESC
    LIMIT 1;
  `);
  const assay = (assayRows.rows as Array<Record<string, unknown>>)[0];
  if (!assay) return null;

  const cutRows = await db.execute(sql`
    SELECT cut_label, cut_order, start_temp_c, yield_wt_pct
    FROM crude_assay_cuts
    WHERE assay_id = ${String(assay.id)}
    ORDER BY cut_order ASC;
  `);
  const cuts = (cutRows.rows as Array<Record<string, unknown>>).map((c) => ({
    cutLabel: String(c.cut_label),
    cutOrder: Number(c.cut_order),
    startTempC: c.start_temp_c == null ? null : Number.parseFloat(String(c.start_temp_c)),
    yieldWtPct: c.yield_wt_pct == null ? null : Number.parseFloat(String(c.yield_wt_pct)),
  }));
  if (cuts.length === 0) {
    const gradeRow = (
      await db.execute(sql`SELECT name FROM crude_grades WHERE slug = ${gradeSlug} LIMIT 1;`)
    ).rows as Array<Record<string, unknown>>;
    return {
      gradeSlug,
      gradeName: String(gradeRow[0]?.name ?? gradeSlug),
      assayReference: String(assay.reference),
      assaySource: String(assay.source),
      assayDate: assay.sample_date == null ? null : String(assay.sample_date),
      contributions: [],
      grossProductValueUsdBbl: null,
      cutsCoveredPct: 0,
      notes: ['Assay has no cut breakdown — cut-weighted value cannot be computed.'],
    };
  }

  // Pull all distinct benchmark series that the cut classifier might
  // need, fetch each spot price in parallel.
  const seriesNeeded = Array.from(new Set(CUT_BENCHMARKS.map((b) => b.series)));
  const priceBySeries = new Map<string, number | null>();
  await Promise.all(
    seriesNeeded.map(async (series) => {
      const ctx = await getCommodityPriceContext(series, 30);
      priceBySeries.set(series, ctx.latest?.price ?? null);
    }),
  );

  const notes: string[] = [];
  let grossSum = 0;
  let coveredYield = 0;
  let totalYield = 0;

  const contributions = cuts.map((c) => {
    const lower = c.cutLabel.toLowerCase();
    const match = CUT_BENCHMARKS.find((b) => b.match(lower, c.startTempC));
    const yld = c.yieldWtPct ?? 0;
    if (yld > 0) totalYield += yld;
    if (!match || c.yieldWtPct == null) {
      return {
        cutLabel: c.cutLabel,
        category: 'unmatched',
        yieldWtPct: yld,
        benchmarkSeries: '',
        benchmarkPriceUsdBbl: null,
        multiplier: 0,
        contributionUsdBbl: null,
      };
    }
    const benchmark = priceBySeries.get(match.series) ?? null;
    if (benchmark == null) {
      notes.push(`Benchmark ${match.series} unavailable — cut "${c.cutLabel}" excluded.`);
      return {
        cutLabel: c.cutLabel,
        category: match.category,
        yieldWtPct: yld,
        benchmarkSeries: match.series,
        benchmarkPriceUsdBbl: null,
        multiplier: match.multiplier,
        contributionUsdBbl: null,
      };
    }
    // yield_wt_pct is already in % — divide by 100 before weighting.
    const contribution = benchmark * match.multiplier * (yld / 100);
    grossSum += contribution;
    coveredYield += yld;
    return {
      cutLabel: c.cutLabel,
      category: match.category,
      yieldWtPct: yld,
      benchmarkSeries: match.series,
      benchmarkPriceUsdBbl: benchmark,
      multiplier: match.multiplier,
      contributionUsdBbl: contribution,
    };
  });

  const cutsCoveredPct = totalYield > 0 ? (coveredYield / totalYield) * 100 : 0;
  const grossProductValueUsdBbl = cutsCoveredPct > 0 ? grossSum : null;

  if (cutsCoveredPct < 80) {
    notes.push(
      `Only ${cutsCoveredPct.toFixed(1)} % of yield mapped to a benchmark — ` +
        `result is approximate. Add cut-label cases to CUT_BENCHMARKS in queries.ts.`,
    );
  }

  const gradeRow = (
    await db.execute(sql`SELECT name FROM crude_grades WHERE slug = ${gradeSlug} LIMIT 1;`)
  ).rows as Array<Record<string, unknown>>;

  return {
    gradeSlug,
    gradeName: String(gradeRow[0]?.name ?? gradeSlug),
    assayReference: String(assay.reference),
    assaySource: String(assay.source),
    assayDate: assay.sample_date == null ? null : String(assay.sample_date),
    contributions,
    grossProductValueUsdBbl,
    cutsCoveredPct,
    notes,
  };
}

/** Distinct regions present in `crude_grades` — drives the filter
 *  dropdown without hard-coding the taxonomy. */
export async function listCrudeGradeRegions(): Promise<string[]> {
  const result = await db.execute(sql`
    SELECT DISTINCT region
    FROM crude_grades
    WHERE region IS NOT NULL
    ORDER BY region;
  `);
  return (result.rows as Array<{ region: string }>).map((r) => r.region);
}

/**
 * Top `known_entities.tags` values whose tag matches a prefix
 * (e.g. `region:`, `compatible:`), counted by how many rows carry
 * the tag. Used to drive data-driven filter chips on the rolodex
 * — replaces hardcoded chip lists that go stale as new analyst
 * tags are added.
 *
 * Results are sorted by count DESC then tag ASC. The leading-prefix
 * filter is required (don't enumerate the full tag space — `tags`
 * is a freeform GIN-indexed array, the result set could be large).
 */
export async function listTopKnownEntityTagsByPrefix(
  prefix: string,
  limit = 20,
): Promise<Array<{ tag: string; count: number }>> {
  if (!prefix || prefix.length < 2) return [];
  const like = `${prefix}%`;
  const result = await db.execute(sql`
    SELECT tag, COUNT(*)::int AS count
    FROM (
      SELECT UNNEST(tags) AS tag
      FROM known_entities
      WHERE tags IS NOT NULL
    ) t
    WHERE tag LIKE ${like}
    GROUP BY tag
    ORDER BY count DESC, tag ASC
    LIMIT ${limit};
  `);
  return (result.rows as Array<{ tag: string; count: number }>).map((r) => ({
    tag: String(r.tag),
    count: Number(r.count),
  }));
}

// ─── Macro-signal exposure walker ─────────────────────────────────

/**
 * Geo / chokepoint → ISO-2 country expansion. Used by
 * `getMacroSignalExposure` when the signal is a passthrough
 * disruption that affects supply from multiple countries (Strait of
 * Hormuz routes for Saudi / Emirati / Iraqi / Iranian / Kuwaiti /
 * Qatari / Omani / Bahraini exports). The match each free-text
 * `source_entity_name` against this lookup before falling back to
 * `source_entity_country`.
 *
 * Keys are case-insensitive substring matches on the signal name.
 * Add as real chat traces surface new chokepoints.
 */
/**
 * Chokepoint coordinates — center point + ports radius. Used by the
 * proximity exposure pass: refineries within `radiusKm` of a chokepoint
 * face physical disruption (port closures, shipping insurance spikes,
 * crew/insurance constraints) regardless of whether the slate envelope
 * overlaps the affected origins.
 *
 * Radii are deliberately generous — a chokepoint event ripples to
 * the surrounding port complex, not just the literal narrows. Tune
 * downward if real signals show false positives.
 *
 * Match key is the SAME pattern as `CHOKEPOINT_COUNTRIES` so a single
 * regex hit gives both country expansion and coordinate.
 */
const CHOKEPOINT_COORDINATES: Array<{
  pattern: RegExp;
  name: string;
  lat: number;
  lng: number;
  radiusKm: number;
}> = [
  { pattern: /strait of hormuz|hormuz|persian gulf/i, name: 'Strait of Hormuz', lat: 26.566, lng: 56.25, radiusKm: 600 },
  { pattern: /bab[- ]el[- ]mandeb|red sea/i, name: 'Bab-el-Mandeb', lat: 12.583, lng: 43.333, radiusKm: 800 },
  { pattern: /suez canal|suez/i, name: 'Suez Canal', lat: 30.0, lng: 32.55, radiusKm: 400 },
  { pattern: /bosphorus|turkish strait|dardanelles/i, name: 'Bosphorus', lat: 41.0, lng: 29.0, radiusKm: 400 },
];

const CHOKEPOINT_COUNTRIES: Array<{ pattern: RegExp; countries: string[] }> = [
  {
    // Strait of Hormuz — exits the Persian Gulf. Captures
    // Saudi / UAE / Qatar / Iran / Iraq / Kuwait / Oman / Bahrain.
    pattern: /strait of hormuz|hormuz|persian gulf/i,
    countries: ['SA', 'AE', 'QA', 'IR', 'IQ', 'KW', 'OM', 'BH'],
  },
  {
    // Bab-el-Mandeb — Red Sea ↔ Gulf of Aden. Captures
    // Saudi / Sudanese / Yemeni / Eritrean exports.
    pattern: /bab[- ]el[- ]mandeb|red sea/i,
    countries: ['SA', 'SD', 'YE', 'ER', 'DJ', 'EG'],
  },
  {
    // Suez Canal — captures any cargo flowing from Med ↔ Red Sea.
    // Treated as a passthrough; affected origins are Mideast +
    // Russian Black Sea (which routes through Suez to reach Asia).
    pattern: /suez canal|suez/i,
    countries: ['SA', 'AE', 'QA', 'IR', 'IQ', 'KW', 'RU', 'EG'],
  },
  {
    // Turkish Straits (Bosphorus) — Russian Black Sea exports
    // out to the Med.
    pattern: /bosphorus|turkish strait|dardanelles/i,
    countries: ['RU', 'KZ', 'AZ', 'TR'],
  },
];

export type MacroSignalExposure = {
  /** match_queue.id of the source signal. */
  signalId: string;
  /** Which countries' supply is implicated by this signal. */
  affectedCountries: string[];
  /** Chokepoint hit (if any) — drives the proximity pass. */
  chokepoint: {
    name: string;
    lat: number;
    lng: number;
    radiusKm: number;
  } | null;
  /** Crude grades originating from those countries. */
  affectedGrades: Array<{
    slug: string;
    name: string;
    originCountry: string | null;
    apiGravity: number | null;
    sulfurPct: number | null;
  }>;
  /** Refineries the signal touches — by slate (their diet runs an
   *  affected grade), by proximity (within radiusKm of the chokepoint
   *  center), or both. Sorted: both-kinds first, then slate, then
   *  proximity; within each kind by affectedGradeCount DESC. */
  exposedRefineries: Array<{
    slug: string;
    name: string;
    country: string;
    /** 'slate' = grade-fit only, 'proximity' = within chokepoint
     *  radius only, 'both' = grade-fit AND in radius. */
    exposureKind: 'slate' | 'proximity' | 'both';
    /** How many of the affected grades fit the refinery's slate.
     *  0 for proximity-only refineries. */
    affectedGradeCount: number;
    /** Top 3 grades the refinery would lose (by API gravity DESC).
     *  Empty for proximity-only refineries. */
    primaryGradeNames: string[];
    /** Distance to chokepoint center in km. NULL for slate-only
     *  refineries (no chokepoint hit). */
    distanceKm: number | null;
  }>;
};

/**
 * Resolve which rolodex entities are exposed by a macro/geo signal.
 *
 * Strategy:
 *   1. Determine the affected country set:
 *      - chokepoint signals (Strait of Hormuz, Bab-el-Mandeb, Suez,
 *        Bosphorus) expand to multiple countries via
 *        CHOKEPOINT_COUNTRIES.
 *      - direct-country signals (Iran, Tuapse RU, …) use
 *        `match_queue.source_entity_country`.
 *   2. Pull `crude_grades` whose `origin_country` ∈ affected set.
 *   3. Pull refineries from `refinery_grade_compatibility` where
 *      `slate_compatible = TRUE` and `grade_slug` ∈ affected grades.
 *   4. Aggregate per refinery: count of affected grades, top 3
 *      grade names by API gravity.
 *
 * Returns null when the signal isn't a macro row (has known_entity
 * or external_supplier — caller should use the entity profile
 * instead) or when no affected countries can be inferred.
 */
export async function getMacroSignalExposure(
  signalId: string,
): Promise<MacroSignalExposure | null> {
  const [row] = await db
    .select({
      id: matchQueue.id,
      sourceEntityName: matchQueue.sourceEntityName,
      sourceEntityCountry: matchQueue.sourceEntityCountry,
      knownEntityId: matchQueue.knownEntityId,
      externalSupplierId: matchQueue.externalSupplierId,
    })
    .from(matchQueue)
    .where(eq(matchQueue.id, signalId))
    .limit(1);
  if (!row) return null;
  // Only macro rows — counterparty rows have their own entity profile.
  if (row.knownEntityId != null || row.externalSupplierId != null) return null;

  const affectedCountries = resolveAffectedCountries(
    row.sourceEntityName,
    row.sourceEntityCountry,
  );
  const chokepoint = resolveChokepoint(row.sourceEntityName);
  const exposure = await getExposureForCountries(affectedCountries, chokepoint);
  return { signalId, ...exposure };
}

/**
 * Free-text variant: takes a geo phrase ("Strait of Hormuz",
 * "Iran sanctions") or an ISO-2 country code and returns the same
 * grades + refineries shape as `getMacroSignalExposure` (without a
 * signalId). Powers the `analyze_macro_signal_exposure` chat tool
 * when the model is asked "what's exposed by Hormuz?" outside the
 * context of a specific match-queue row.
 *
 * Resolution order:
 *   1. Chokepoint pattern match against the phrase (case-insensitive)
 *   2. Two-letter ISO country code (uppercased)
 *   3. ISO-3 / country name fallback via `normalizeCountryCode`
 *      (lazy import to keep this file tree-shakable for surfaces
 *      that don't need country normalization).
 */
export async function getExposureForGeoPhrase(
  phrase: string,
): Promise<{
  resolvedFrom: 'chokepoint' | 'iso2' | 'country-name' | 'unresolved';
  matchedPattern: string | null;
  affectedCountries: string[];
  chokepoint: MacroSignalExposure['chokepoint'];
  affectedGrades: MacroSignalExposure['affectedGrades'];
  exposedRefineries: MacroSignalExposure['exposedRefineries'];
}> {
  const trimmed = phrase.trim();
  // Try chokepoint first — also pulls coordinates for the proximity pass.
  for (const cp of CHOKEPOINT_COUNTRIES) {
    if (cp.pattern.test(trimmed)) {
      const choke = resolveChokepoint(trimmed);
      const exposure = await getExposureForCountries(cp.countries, choke);
      return {
        resolvedFrom: 'chokepoint',
        matchedPattern: cp.pattern.source,
        ...exposure,
      };
    }
  }
  // ISO-2 short-circuit.
  if (/^[A-Za-z]{2}$/.test(trimmed)) {
    const code = trimmed.toUpperCase();
    const exposure = await getExposureForCountries([code], null);
    return { resolvedFrom: 'iso2', matchedPattern: null, ...exposure };
  }
  // Country-name normalization (e.g. "Russia", "Côte d'Ivoire").
  const { normalizeCountryCode } = await import('./country-codes');
  const normalized = normalizeCountryCode(trimmed);
  if (normalized) {
    const exposure = await getExposureForCountries([normalized], null);
    return { resolvedFrom: 'country-name', matchedPattern: null, ...exposure };
  }
  return {
    resolvedFrom: 'unresolved',
    matchedPattern: null,
    affectedCountries: [],
    chokepoint: null,
    affectedGrades: [],
    exposedRefineries: [],
  };
}

/** Inner walker: countries (and optional chokepoint) → affected
 *  grades → exposed refineries. Shared by both signal-id and
 *  free-text entry points.
 *
 *  Two parallel passes both contribute to `exposedRefineries`:
 *    1. Slate match — refineries whose configured envelope accepts
 *       at least one grade originating in `countries`.
 *    2. Proximity match — refineries within `chokepoint.radiusKm`
 *       of the chokepoint's center coordinate.
 *  Refineries that hit both are merged with `exposureKind: 'both'`.
 *  Sort order: both → slate → proximity, then affectedGradeCount
 *  DESC within each kind. */
async function getExposureForCountries(
  countries: string[],
  chokepoint: MacroSignalExposure['chokepoint'],
): Promise<{
  affectedCountries: string[];
  chokepoint: MacroSignalExposure['chokepoint'];
  affectedGrades: MacroSignalExposure['affectedGrades'];
  exposedRefineries: MacroSignalExposure['exposedRefineries'];
}> {
  if (countries.length === 0 && chokepoint == null) {
    return { affectedCountries: [], chokepoint: null, affectedGrades: [], exposedRefineries: [] };
  }

  // Affected grades from origin-country expansion.
  let affectedGrades: MacroSignalExposure['affectedGrades'] = [];
  if (countries.length > 0) {
    const gradesRow = await db.execute(sql`
      SELECT slug, name, origin_country, api_gravity, sulfur_pct
      FROM crude_grades
      WHERE origin_country = ANY(${pgArray(countries)})
      ORDER BY api_gravity DESC NULLS LAST;
    `);
    affectedGrades = (gradesRow.rows as Array<Record<string, unknown>>).map((g) => ({
      slug: String(g.slug),
      name: String(g.name),
      originCountry: g.origin_country == null ? null : String(g.origin_country),
      apiGravity: g.api_gravity == null ? null : Number.parseFloat(String(g.api_gravity)),
      sulfurPct: g.sulfur_pct == null ? null : Number.parseFloat(String(g.sulfur_pct)),
    }));
  }

  // Slate-match pass.
  type SlateRow = {
    slug: string;
    name: string;
    country: string;
    affectedGradeCount: number;
    primaryGradeNames: string[];
  };
  let slateRows: SlateRow[] = [];
  if (affectedGrades.length > 0) {
    const affectedSlugs = affectedGrades.map((g) => g.slug);
    const exposedRow = await db.execute(sql`
      SELECT
        refinery_slug,
        refinery_name,
        refinery_country,
        COUNT(*)::int AS affected_count,
        (
          ARRAY_AGG(grade_name ORDER BY grade_api_gravity DESC NULLS LAST)
        )[1:3] AS primary_grades
      FROM refinery_grade_compatibility
      WHERE slate_compatible = TRUE
        AND grade_slug = ANY(${pgArray(affectedSlugs)})
      GROUP BY refinery_slug, refinery_name, refinery_country
      ORDER BY affected_count DESC, refinery_name ASC
      LIMIT 50;
    `);
    slateRows = (exposedRow.rows as Array<Record<string, unknown>>).map((r) => ({
      slug: String(r.refinery_slug),
      name: String(r.refinery_name),
      country: String(r.refinery_country),
      affectedGradeCount: Number(r.affected_count),
      primaryGradeNames: Array.isArray(r.primary_grades)
        ? (r.primary_grades as string[])
        : [],
    }));
  }

  // Proximity pass — only when a chokepoint coordinate is supplied.
  // Uses haversine over `known_entities` for refineries with lat/lng
  // within `radiusKm`. Cap at 25 to keep the result envelope small;
  // this is a "who else is in the blast radius" lens, not a full
  // refinery census.
  type ProxRow = { slug: string; name: string; country: string; distanceKm: number };
  let proxRows: ProxRow[] = [];
  if (chokepoint) {
    const r = await db.execute(sql`
      SELECT
        slug,
        name,
        country,
        (
          6371 * acos(
            cos(radians(${chokepoint.lat})) * cos(radians(latitude::float8)) *
            cos(radians(longitude::float8) - radians(${chokepoint.lng})) +
            sin(radians(${chokepoint.lat})) * sin(radians(latitude::float8))
          )
        ) AS distance_km
      FROM known_entities
      WHERE role = 'refiner'
        AND latitude IS NOT NULL
        AND longitude IS NOT NULL
        AND (
          6371 * acos(
            cos(radians(${chokepoint.lat})) * cos(radians(latitude::float8)) *
            cos(radians(longitude::float8) - radians(${chokepoint.lng})) +
            sin(radians(${chokepoint.lat})) * sin(radians(latitude::float8))
          )
        ) <= ${chokepoint.radiusKm}
      ORDER BY distance_km ASC
      LIMIT 25;
    `);
    proxRows = (r.rows as Array<Record<string, unknown>>).map((row) => ({
      slug: String(row.slug),
      name: String(row.name),
      country: String(row.country),
      distanceKm: Number.parseFloat(String(row.distance_km)),
    }));
  }

  // Merge slate × proximity. Same refinery in both passes → 'both'.
  const bySlug = new Map<string, MacroSignalExposure['exposedRefineries'][number]>();
  for (const s of slateRows) {
    bySlug.set(s.slug, {
      slug: s.slug,
      name: s.name,
      country: s.country,
      exposureKind: 'slate',
      affectedGradeCount: s.affectedGradeCount,
      primaryGradeNames: s.primaryGradeNames,
      distanceKm: null,
    });
  }
  for (const p of proxRows) {
    const existing = bySlug.get(p.slug);
    if (existing) {
      bySlug.set(p.slug, {
        ...existing,
        exposureKind: 'both',
        distanceKm: p.distanceKm,
      });
    } else {
      bySlug.set(p.slug, {
        slug: p.slug,
        name: p.name,
        country: p.country,
        exposureKind: 'proximity',
        affectedGradeCount: 0,
        primaryGradeNames: [],
        distanceKm: p.distanceKm,
      });
    }
  }
  const kindRank = { both: 0, slate: 1, proximity: 2 } as const;
  const exposedRefineries = [...bySlug.values()].sort((a, b) => {
    const k = kindRank[a.exposureKind] - kindRank[b.exposureKind];
    if (k !== 0) return k;
    if (a.exposureKind === 'proximity' && b.exposureKind === 'proximity') {
      return (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity);
    }
    return b.affectedGradeCount - a.affectedGradeCount || a.name.localeCompare(b.name);
  });

  return { affectedCountries: countries, chokepoint, affectedGrades, exposedRefineries };
}

/** Resolve free-text → chokepoint coordinate record (or null). */
function resolveChokepoint(
  source: string,
): MacroSignalExposure['chokepoint'] {
  for (const cp of CHOKEPOINT_COORDINATES) {
    if (cp.pattern.test(source)) {
      return { name: cp.name, lat: cp.lat, lng: cp.lng, radiusKm: cp.radiusKm };
    }
  }
  return null;
}

function resolveAffectedCountries(
  sourceEntityName: string,
  sourceEntityCountry: string | null,
): string[] {
  // Chokepoint match takes precedence — "Strait of Hormuz" entries
  // typically have NULL country (they're passthroughs, not origins).
  for (const cp of CHOKEPOINT_COUNTRIES) {
    if (cp.pattern.test(sourceEntityName)) return cp.countries;
  }
  if (sourceEntityCountry) return [sourceEntityCountry];
  return [];
}
