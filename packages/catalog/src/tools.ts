import 'server-only';
import { defineTool, withToolTelemetry, type ToolRegistry } from '@procur/ai';
import { z } from 'zod';
import {
  analyzeSupplier,
  briefOpportunity,
  findBuyersForCommodityOffer,
  findCompetingSellers,
  findSuppliersForTender,
  lookupKnownEntities,
  getCompanyProfile,
  listJurisdictions,
  listOpportunities,
  getOpportunityBySlug,
  pricingIntel,
  summarizeCatalog,
  whatsNewForUser,
  type OpportunityScope,
} from './queries';
import { addOpportunityToPursuit, createAlertProfile } from './mutations';

/**
 * Discover catalog URL base — opportunities are viewed on Discover
 * regardless of which app surface invokes the catalog tools, so this
 * constant is shared by every tool that returns an opportunity link.
 * Exported so apps consuming this package (apps/discover specifically)
 * can build sibling tools like build_filter_url against the same base.
 */
export const DISCOVER_BASE = 'https://discover.procur.app';

/**
 * Build a Discover catalog URL with the given filters pre-applied.
 * Mirrors the URL params accepted by /opportunities/page.tsx so a
 * user clicking the link lands on the same view they'd build by
 * clicking through the sidebar manually.
 *
 * Empty / nullish filters are omitted (cleaner URLs, no `?q=&jurisdiction=`).
 *
 * Exported so the Discover-only build_filter_url tool can reuse the
 * exact same URL shape that search_opportunities embeds in its
 * filterUrl response field.
 */
export function buildFilterUrl(filters: {
  query?: string | null;
  jurisdiction?: string | null;
  category?: string | null;
  country?: string | null;
  scope?: 'open' | 'past' | null;
}): string {
  const params = new URLSearchParams();
  if (filters.query) params.set('q', filters.query);
  if (filters.jurisdiction) params.set('jurisdiction', filters.jurisdiction);
  if (filters.category) params.set('category', filters.category);
  if (filters.country) params.set('country', filters.country);
  if (filters.scope === 'past') params.set('view', 'past');
  const qs = params.toString();
  return `${DISCOVER_BASE}/opportunities${qs ? `?${qs}` : ''}`;
}

/**
 * Human-readable summary of which filters got applied — exposed for the
 * Discover-side build_filter_url tool to produce a "Applied: Jamaica +
 * Petroleum and Fuels" summary alongside the URL. Empty when no filters
 * are set.
 */
export function describeFilters(input: {
  query?: string | null;
  jurisdiction?: string | null;
  category?: string | null;
  country?: string | null;
  scope?: 'open' | 'past' | null;
}): string {
  const parts: string[] = [];
  if (input.country) parts.push(input.country);
  if (input.jurisdiction) parts.push(`jurisdiction: ${input.jurisdiction}`);
  if (input.category) parts.push(`category: ${input.category}`);
  if (input.query) parts.push(`search: "${input.query}"`);
  if (input.scope === 'past') parts.push('past awards');
  return parts.join(' + ');
}

/**
 * Catalog tool registry shared between Discover (floating widget) and
 * the main app's assistant. Public-catalog read-tools + the two
 * write-tools that operate on the user's own company (alert profiles,
 * pursuit pipeline). The Discover-URL-shaped `build_filter_url` tool
 * is NOT included here — it lives only in apps/discover/lib/assistant-tools.ts
 * because the "navigate the user to a filtered Discover view" UX is a
 * Discover surface concern.
 */
export function buildCatalogTools(): ToolRegistry {
  return {
    search_opportunities: defineTool({
      name: 'search_opportunities',
      description:
        'Search the Procur Discover public catalog of government tenders. ' +
        'Use this whenever the user asks to find, narrow, or filter opportunities. ' +
        'Combine filters as needed. Returns up to 20 matching opportunities with ' +
        'title, agency, jurisdiction, deadline, value (USD), category, and a Discover URL.',
      kind: 'read',
      schema: z.object({
        query: z
          .string()
          .optional()
          .describe('Free-text search across title, agency name, reference number'),
        jurisdiction: z
          .string()
          .optional()
          .describe(
            'Jurisdiction slug (e.g. "us-federal", "canada-federal", "eu-ted", "uk-fts", "un", "jamaica")',
          ),
        category: z
          .string()
          .optional()
          .describe(
            'Category slug ("food-commodities", "petroleum-fuels", "vehicles-fleet", "minerals-metals", or other taxonomy slug)',
          ),
        country: z
          .string()
          .optional()
          .describe(
            'Beneficiary country name (e.g. "Antigua and Barbuda", "Haiti", "Germany"). ' +
              'Filters cross-jurisdiction notices to a target country.',
          ),
        scope: z
          .enum(['open', 'past'])
          .optional()
          .describe('"open" for active tenders (default), "past" for awarded/closed'),
        closingWithinDays: z
          .number()
          .int()
          .min(1)
          .max(365)
          .optional()
          .describe(
            'Limit to tenders whose deadline is within the next N days. ' +
              'Use this for "closes this week" (7), "next 14 days" (14), urgency queries.',
          ),
        postedWithinDays: z
          .number()
          .int()
          .min(1)
          .max(365)
          .optional()
          .describe(
            'Limit to tenders posted (or first ingested) within the last N days. ' +
              'Use for "new today" (1), "posted this week" (7), recency queries.',
          ),
        minValueUsd: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Minimum estimated value in USD'),
        maxValueUsd: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Maximum estimated value in USD'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe('How many results to return — capped at 20 to keep tool output readable'),
      }),
      handler: async (_ctx, input) => {
        const scope: OpportunityScope = input.scope ?? 'open';
        const now = Date.now();
        const deadlineBefore = input.closingWithinDays
          ? new Date(now + input.closingWithinDays * 24 * 60 * 60 * 1000)
          : undefined;
        const publishedAfter = input.postedWithinDays
          ? new Date(now - input.postedWithinDays * 24 * 60 * 60 * 1000)
          : undefined;
        const { rows, total } = await listOpportunities({
          q: input.query,
          jurisdiction: input.jurisdiction,
          category: input.category,
          beneficiaryCountry: input.country,
          minValueUsd: input.minValueUsd,
          maxValueUsd: input.maxValueUsd,
          deadlineBefore,
          publishedAfter,
          page: 1,
          perPage: input.limit ?? 10,
          sort: scope === 'past' ? 'deadline-desc' : 'deadline-asc',
          scope,
        });
        return {
          total,
          shown: rows.length,
          // URL the user can click to land on Discover with these
          // exact filters applied — surface alongside individual
          // opportunity links when total > shown so the user can
          // browse beyond what fits in the chat panel.
          filterUrl: buildFilterUrl({
            query: input.query,
            jurisdiction: input.jurisdiction,
            category: input.category,
            country: input.country,
            scope,
          }),
          opportunities: rows.map((o) => ({
            slug: o.slug,
            title: o.title,
            jurisdiction: o.jurisdictionName,
            beneficiaryCountry: o.beneficiaryCountry ?? null,
            agency: o.agencyShort ?? o.agencyName ?? null,
            deadlineAt: o.deadlineAt?.toISOString() ?? null,
            valueUsd: o.valueEstimateUsd ?? null,
            category: o.category ?? null,
            url: o.slug ? `${DISCOVER_BASE}/opportunities/${o.slug}` : null,
          })),
        };
      },
    }),

    get_opportunity: defineTool({
      name: 'get_opportunity',
      description:
        'Fetch full details for a single opportunity by its slug — useful when the user asks ' +
        '"tell me more about X" after a search. Returns title, description, agency, deadline, ' +
        'value, status, and the source-portal URL.',
      kind: 'read',
      schema: z.object({
        slug: z.string().describe('The opportunity slug (the path segment after /opportunities/)'),
      }),
      handler: async (_ctx, input) => {
        const op = await getOpportunityBySlug(input.slug);
        if (!op) return { found: false };
        return {
          found: true,
          slug: op.slug,
          title: op.title,
          description: op.description?.slice(0, 4000) ?? null,
          aiSummary: op.aiSummary ?? null,
          referenceNumber: op.referenceNumber ?? null,
          jurisdiction: op.jurisdictionName,
          beneficiaryCountry: op.beneficiaryCountry ?? null,
          agency: op.agencyName ?? null,
          deadlineAt: op.deadlineAt?.toISOString() ?? null,
          publishedAt: op.publishedAt?.toISOString() ?? null,
          valueEstimate: op.valueEstimate ?? null,
          valueEstimateUsd: op.valueEstimateUsd ?? null,
          currency: op.currency ?? null,
          category: op.category ?? null,
          status: op.status,
          sourceUrl: op.sourceUrl ?? null,
          discoverUrl: op.slug ? `${DISCOVER_BASE}/opportunities/${op.slug}` : null,
        };
      },
    }),

    pricing_intel: defineTool({
      name: 'pricing_intel',
      description:
        'Aggregate competitive pricing intel from past awards in the catalog. Returns ' +
        'median / p90 / mean / total awarded values grouped by currency, plus the top 5 ' +
        'winning suppliers and recent award examples. Use this when the user asks "what do ' +
        'these go for", "what should I bid", "who wins these contracts", "competitive ' +
        'pricing", or any market-research / pricing-context question. Filters work the ' +
        'same as search_opportunities. Currencies are kept separate (no FX conversion) ' +
        'so users see real numbers in the right unit.',
      kind: 'read',
      schema: z.object({
        jurisdiction: z
          .string()
          .optional()
          .describe('Jurisdiction slug (us-federal, canada-federal, eu-ted, uk-fts, un, …)'),
        category: z
          .string()
          .optional()
          .describe(
            'Category slug ("food-commodities", "petroleum-fuels", "vehicles-fleet", "minerals-metals")',
          ),
        country: z
          .string()
          .optional()
          .describe('Beneficiary country name (e.g. "Jamaica", "Haiti", "Germany")'),
        withinDays: z
          .number()
          .int()
          .min(1)
          .max(3650)
          .optional()
          .describe(
            'Limit to awards in the last N days. Default = all-time. ' +
              'Use 365 for "last year", 90 for "last quarter", etc.',
          ),
      }),
      handler: async (_ctx, input) => {
        return pricingIntel({
          jurisdiction: input.jurisdiction,
          category: input.category,
          beneficiaryCountry: input.country,
          withinDays: input.withinDays,
        });
      },
    }),

    summarize_catalog: defineTool({
      name: 'summarize_catalog',
      description:
        'Aggregate the public catalog into market-sizing buckets — count + total estimated ' +
        'USD value grouped by jurisdiction, category, beneficiary country, agency, or ' +
        'currency. Use for questions like "how many fuel tenders by country?", "where is ' +
        'most procurement happening?", "top agencies by activity", "what categories are ' +
        'biggest right now?". Returns up to 30 buckets sorted by count descending. Filter ' +
        'inputs work the same as search_opportunities so you can ask narrow questions like ' +
        '"of fuel tenders posted this week, which jurisdictions have the most?".',
      kind: 'read',
      schema: z.object({
        groupBy: z
          .enum(['jurisdiction', 'category', 'country', 'agency', 'currency'])
          .describe('Which dimension to bucket on. Pick the one that answers the question.'),
        jurisdiction: z
          .string()
          .optional()
          .describe('Pre-filter to one jurisdiction slug (us-federal, eu-ted, etc) before grouping'),
        category: z
          .string()
          .optional()
          .describe('Pre-filter to one category slug (food-commodities, petroleum-fuels, etc)'),
        country: z
          .string()
          .optional()
          .describe('Pre-filter to one beneficiary country (e.g. "Jamaica")'),
        scope: z
          .enum(['open', 'past'])
          .optional()
          .describe('"open" for active tenders (default), "past" for awarded/closed'),
        postedWithinDays: z
          .number()
          .int()
          .min(1)
          .max(365)
          .optional()
          .describe('Limit to opportunities posted in the last N days'),
      }),
      handler: async (_ctx, input) => {
        return summarizeCatalog(
          {
            jurisdiction: input.jurisdiction,
            category: input.category,
            beneficiaryCountry: input.country,
            scope: input.scope,
            postedWithinDays: input.postedWithinDays,
          },
          input.groupBy,
        );
      },
    }),

    create_alert_profile: defineTool({
      name: 'create_alert_profile',
      description:
        'Create a new alert so the user gets notified when matching opportunities are ' +
        'posted. Use when the user says things like "alert me when X gets posted", ' +
        '"notify me about Y", "set up a daily digest for Z", "watch for new fuel tenders". ' +
        'Profile is active + email-enabled by default; user can manage in the main app ' +
        'after creation. Match logic mirrors search_opportunities filter slugs (jurisdiction, ' +
        'category, country) plus arbitrary keywords. Confirm the user\'s intent in plain ' +
        'language BEFORE calling — this writes to their account.',
      kind: 'write',
      schema: z.object({
        name: z
          .string()
          .min(1)
          .max(200)
          .describe(
            'Short human-readable name the user will see in their alerts list. ' +
              'Default to a description of the filters (e.g. "Caribbean fuel tenders").',
          ),
        jurisdictions: z
          .array(z.string())
          .optional()
          .describe('Array of jurisdiction slugs to match (us-federal, eu-ted, jamaica, …)'),
        categories: z
          .array(z.string())
          .optional()
          .describe(
            'Array of category slugs to match (food-commodities, petroleum-fuels, ' +
              'vehicles-fleet, minerals-metals)',
          ),
        keywords: z
          .array(z.string())
          .optional()
          .describe(
            'Free-text keywords; opportunity matches if any keyword appears in title or ' +
              'description (case-insensitive)',
          ),
        excludeKeywords: z
          .array(z.string())
          .optional()
          .describe('Keywords that DISQUALIFY a match — e.g., ["consultancy", "advisory"]'),
        minValueUsd: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Skip opportunities below this estimated USD value'),
        maxValueUsd: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Skip opportunities above this estimated USD value'),
        frequency: z
          .enum(['instant', 'daily', 'weekly'])
          .optional()
          .describe('How often to receive the digest. Default: daily.'),
      }),
      handler: async (ctx, input) => {
        return createAlertProfile({
          userId: ctx.userId,
          companyId: ctx.companyId,
          name: input.name,
          jurisdictions: input.jurisdictions,
          categories: input.categories,
          keywords: input.keywords,
          excludeKeywords: input.excludeKeywords,
          minValueUsd: input.minValueUsd,
          maxValueUsd: input.maxValueUsd,
          frequency: input.frequency,
        });
      },
    }),

    add_to_pursuit_pipeline: defineTool({
      name: 'add_to_pursuit_pipeline',
      description:
        'Save an opportunity to the user\'s company pursuit pipeline so they can work it ' +
        'in the main app (capture answers, bid/no-bid, proposal drafting). Use when the ' +
        'user says things like "save this", "track this for me", "add to my pipeline", ' +
        '"I\'ll bid on this", "I want to pursue this", "let me work this one". Idempotent — ' +
        'returns the existing pursuit if the opportunity is already in the pipeline. ' +
        'Confirm the user\'s intent in plain language BEFORE calling — this writes to their ' +
        'account. After creation, surface the returned manageUrl as a "Open in Capture →" link.',
      kind: 'write',
      schema: z.object({
        opportunitySlug: z
          .string()
          .describe(
            'The opportunity slug (the path segment after /opportunities/ in a Discover URL). ' +
              'Get from a prior search_opportunities or get_opportunity call.',
          ),
      }),
      handler: async (ctx, input) => {
        return addOpportunityToPursuit({
          companyId: ctx.companyId,
          opportunitySlug: input.opportunitySlug,
        });
      },
    }),

    get_company_profile: defineTool({
      name: 'get_company_profile',
      description:
        "Snapshot of the user's own company — name, plan tier, capability list (categorized: " +
        "service / certification / technology / geography / personnel / past_performance), and " +
        'sample past-performance projects with categories + NAICS codes + keywords. Call this ' +
        'ONCE early in a conversation when the user asks for recommendations, "should I bid", ' +
        '"is this a fit for us", "what should I look at", or anything that requires understanding ' +
        "what they actually do. Don't re-fetch each turn — the data doesn't change within a " +
        "session. Use the returned context to bias subsequent search_opportunities calls toward " +
        "matching jurisdictions / categories / keywords, and to answer fit questions concretely.",
      kind: 'read',
      schema: z.object({}),
      handler: async (ctx) => {
        const profile = await getCompanyProfile(ctx.companyId);
        if (!profile) return { found: false };
        return { found: true, ...profile };
      },
    }),

    brief_opportunity: defineTool({
      name: 'brief_opportunity',
      description:
        "One-shot 'Should We Bid' briefing — combines opportunity details, the user's company " +
        'capability/past-performance context, AND comparable past-award pricing for the same ' +
        'category/country, all in a single call. Use this whenever the user asks for a deeper ' +
        'evaluation of one opportunity: "should I bid on X", "brief me on X", "tell me everything ' +
        'about X", "is X worth pursuing", "give me a fit assessment for X". Prefer this over ' +
        'chaining get_opportunity + get_company_profile + pricing_intel separately — it returns ' +
        'all three in one call. Format the response as: 1) one-paragraph fit assessment, 2) ' +
        '"What it is" 2-3 lines, 3) "Pricing context" with median/p90 of comparable awards, ' +
        '4) "Recommendation" — one of: pursue / borderline / skip with rationale.',
      kind: 'read',
      schema: z.object({
        slug: z
          .string()
          .describe('The opportunity slug (the path segment after /opportunities/ in a Discover URL)'),
      }),
      handler: async (ctx, input) => {
        return briefOpportunity(ctx.companyId, input.slug);
      },
    }),

    whats_new_for_me: defineTool({
      name: 'whats_new_for_me',
      description:
        "Personalized what's-new digest. Returns opportunities posted (or first ingested) " +
        "since the LAST time the user invoked this tool — automatically tracked per-user " +
        "via the lastAssistantSeenAt timestamp on their account. First call falls back to " +
        'the past 7 days. Use when the user says "what\'s new", "catch me up", "anything new ' +
        'since I last looked", "new since yesterday/last week", or starts a fresh session and ' +
        'asks "what should I look at first". Returns total count + breakdowns by jurisdiction ' +
        'and category + top 10 most-recent opportunities. Bumps the lastAssistantSeenAt ' +
        'timestamp atomically — safe to call once per session at the start.',
      kind: 'read',
      schema: z.object({}),
      handler: async (ctx) => {
        return whatsNewForUser(ctx.userId);
      },
    }),

    list_jurisdictions: defineTool({
      name: 'list_jurisdictions',
      description:
        'Return the full list of jurisdictions Procur Discover ingests, with their slugs, ' +
        'country, and how many active opportunities each currently has. Use this to answer ' +
        '"what countries do you cover?" or to map a user-spoken country name onto a slug for ' +
        'a follow-up search_opportunities call.',
      kind: 'read',
      schema: z.object({}),
      handler: async () => {
        const rows = await listJurisdictions();
        return {
          jurisdictions: rows.map((j) => ({
            slug: j.slug,
            name: j.name,
            countryCode: j.countryCode,
            region: j.region,
            active: j.active,
            activeOpportunities: j.opportunitiesCount ?? 0,
          })),
        };
      },
    }),

    // ─── Supplier graph ──────────────────────────────────────────────
    // Three reverse-lookup tools that ride on the awards / supplier_aliases
    // tables added in migration 0032. Public-domain — no companyId
    // scoping. See docs/assistant-tools-spec.md for the rationale.

    find_buyers_for_offer: defineTool({
      name: 'find_buyers_for_offer',
      description:
        'Reverse search: given a commodity offer (crude grade, refined product, food ' +
        'commodity, vehicle type), find public buyers who have demonstrably bought that ' +
        'commodity in recent history. Returns a ranked list ordered by recency × volume, ' +
        'with award counts, total USD value, agency names, and beneficiary countries. Use ' +
        "this when the user describes a supplier offer or cargo position and asks 'who " +
        "would buy this' / 'who's a likely buyer' / 'who has purchased this before'. " +
        'Public-tender data only — does NOT cover private refiner-to-refiner or ' +
        'trader-to-trader flows. For crude oil specifically, results skew toward national ' +
        "oil companies and state refiners; private major refiners (ENI, Saras, Reliance) " +
        "won't appear.",
      kind: 'read',
      schema: z.object({
        categoryTag: z
          .enum([
            'crude-oil',
            'diesel',
            'gasoline',
            'jet-fuel',
            'lpg',
            'marine-bunker',
            'heating-oil',
            'heavy-fuel-oil',
            'food-commodities',
            'vehicles',
          ])
          .describe(
            'Internal taxonomy tag for the commodity being offered. Pick the closest match. ' +
              "For Azeri Light or Brent or Bonny Light, use 'crude-oil'. For Jet A-1, use 'jet-fuel'.",
          ),
        descriptionKeywords: z
          .array(z.string())
          .optional()
          .describe(
            'Optional keywords matched (case-insensitive) against commodity_description. ' +
              "Use to narrow within a category — e.g. ['light sweet', 'azeri'] for Azeri Light. " +
              'Empty array = match all within the category.',
          ),
        buyerCountries: z
          .array(z.string().length(2))
          .optional()
          .describe(
            "Optional ISO-3166-1 alpha-2 country codes (e.g. ['IT','ES','GR','TR']). " +
              'Use when the cargo has geographic constraints (CIF Mediterranean, FOB Asia, etc). ' +
              'Empty = global search.',
          ),
        yearsLookback: z
          .number()
          .min(1)
          .max(10)
          .optional()
          .describe('How far back to search award history. Default 5 years.'),
        minAwards: z
          .number()
          .min(1)
          .optional()
          .describe(
            'Minimum number of matching awards a buyer must have to qualify. ' +
              'Higher = more proven, fewer results. Default 2.',
          ),
        limit: z.number().min(1).max(100).optional(),
      }),
      handler: async (ctx, input) =>
        withToolTelemetry(
          {
            ctx,
            toolName: 'find_buyers_for_offer',
            args: input,
            summarize: (out: { count: number }) => ({
              resultCount: out.count,
              resultSummary: {
                categoryTag: input.categoryTag,
                buyerCountriesCount: input.buyerCountries?.length ?? 0,
              },
            }),
          },
          async () => {
            const buyers = await findBuyersForCommodityOffer({
              categoryTag: input.categoryTag,
              descriptionKeywords: input.descriptionKeywords,
              buyerCountries: input.buyerCountries,
              yearsLookback: input.yearsLookback,
              minAwards: input.minAwards,
              limit: input.limit ?? 30,
            });

            return {
              count: buyers.length,
              categoryTag: input.categoryTag,
              buyers: buyers.map((b) => ({
                buyerName: b.buyerName,
                buyerCountry: b.buyerCountry,
                awardsCount: b.awardsCount,
                totalValueUsd: b.totalValueUsd,
                mostRecentAwardDate: b.mostRecentAwardDate,
                agencies: b.agencies?.slice(0, 5) ?? [],
                sampleCommodities: b.commoditiesBought?.slice(0, 3) ?? [],
                beneficiaryCountries: b.beneficiaryCountries ?? [],
              })),
              // Hard-coded so the LLM always sees the gap, even when the
              // system-prompt block isn't present (e.g., the Discover
              // surfaceContext compresses the static block).
              caveat:
                'Public procurement data only. Private commercial flows (major refiner crude purchases, ' +
                'trader-to-trader) are not represented. For crude grades specifically, augment with ' +
                'customs data (Kpler/Vortexa) and refinery configuration data (Argus/Platts) before ' +
                'committing to a buyer list.',
            };
          },
        ),
    }),

    find_suppliers_for_tender: defineTool({
      name: 'find_suppliers_for_tender',
      description:
        'Given a public tender (either by opportunity ID or by explicit category/country ' +
        'fields), return suppliers who have won similar awards in recent history and are ' +
        'plausible bidders. Results are ranked by relevance signals: how many similar ' +
        'awards they have won, recency, geographic overlap with the buyer or beneficiary ' +
        "country, and total contract value. Use this when the user says 'who could bid on " +
        "this' / 'who has won similar tenders' / 'should I partner with anyone for this'. " +
        'Returns supplier name, country, awards count for matching category, recent ' +
        'buyers, and a brief match-reason summary.',
      kind: 'read',
      schema: z.object({
        opportunityId: z
          .string()
          .uuid()
          .optional()
          .describe(
            'If provided, the tool derives category/keywords/jurisdiction from the ' +
              'opportunity record. Use this when the user is looking at a specific tender. ' +
              'If null, fall back to the explicit fields below.',
          ),
        categoryTag: z
          .string()
          .optional()
          .describe(
            'Internal commodity category — required if opportunityId is not provided. ' +
              'Same vocabulary as find_buyers_for_offer.',
          ),
        descriptionKeywords: z.array(z.string()).optional(),
        buyerCountry: z
          .string()
          .length(2)
          .optional()
          .describe(
            "ISO-2 country code of the buyer. When set, suppliers who've previously won in " +
              'this country rank higher.',
          ),
        beneficiaryCountry: z
          .string()
          .length(2)
          .optional()
          .describe(
            'ISO-2 of the beneficiary country (where the work is delivered). For UN/' +
              'development-bank tenders, this is the actual target country.',
          ),
        yearsLookback: z.number().min(1).max(10).optional(),
        limit: z.number().min(1).max(50).optional(),
      }),
      handler: async (ctx, input) =>
        withToolTelemetry(
          {
            ctx,
            toolName: 'find_suppliers_for_tender',
            args: input,
            summarize: (out: { count: number; categoryTag: string | null; derivedFrom: string }) => ({
              resultCount: out.count,
              resultSummary: {
                categoryTag: out.categoryTag,
                derivedFrom: out.derivedFrom,
              },
            }),
          },
          async () => {
            const result = await findSuppliersForTender(ctx.companyId, {
              opportunityId: input.opportunityId,
              categoryTag: input.categoryTag,
              descriptionKeywords: input.descriptionKeywords,
              buyerCountry: input.buyerCountry,
              beneficiaryCountry: input.beneficiaryCountry,
              yearsLookback: input.yearsLookback,
              limit: input.limit ?? 15,
            });
            return {
              count: result.suppliers.length,
              derivedFrom: result.derivedFrom,
              categoryTag: result.categoryTag,
              suppliers: result.suppliers.map((s) => ({
                supplierId: s.supplierId,
                supplierName: s.supplierName,
                country: s.country,
                matchingAwardsCount: s.matchingAwardsCount,
                totalValueUsd: s.totalValueUsd,
                mostRecentAwardDate: s.mostRecentAwardDate,
                recentBuyers: s.recentBuyers?.slice(0, 5) ?? [],
                matchReasons: s.matchReasons,
              })),
            };
          },
        ),
    }),

    find_competing_sellers: defineTool({
      name: 'find_competing_sellers',
      description:
        'Sell-side market intel: given a commodity + geography, return who has been winning ' +
        'awards lately (active sellers) AND who has the capability but has gone quiet (dormant ' +
        'sellers). Distinct from find_suppliers_for_tender — that ranks plausible bidders for a ' +
        "specific tender; this surfaces the COMPETITIVE LANDSCAPE for a category. Use when the " +
        "user asks 'who else is selling X', 'who's competing for diesel in the Caribbean', " +
        "'show me dormant suppliers we could pitch back-to-back', or 'what's the going price for " +
        "X awards lately'. Returns market price-band stats (median + p25/p75 of contract " +
        '$USD) so you can sanity-check a broker offer without a separate query. The dormant ' +
        'slice is strategically valuable: capability + no recent wins = high responsiveness ' +
        'to alternative deal structures (back-to-back, off-take, blending arrangements). ' +
        'Public-tender data only — same coverage caveat as find_buyers_for_offer.',
      kind: 'read',
      schema: z.object({
        categoryTag: z
          .enum([
            'crude-oil',
            'diesel',
            'gasoline',
            'jet-fuel',
            'lpg',
            'marine-bunker',
            'heating-oil',
            'heavy-fuel-oil',
            'food-commodities',
            'vehicles',
          ])
          .describe('Same vocabulary as find_buyers_for_offer.'),
        buyerCountries: z
          .array(z.string().length(2))
          .optional()
          .describe(
            "ISO-2 codes filtering award geography. e.g. ['DO','JM','TT'] for the Caribbean. " +
              'Empty = global.',
          ),
        monthsLookback: z
          .number()
          .min(1)
          .max(60)
          .optional()
          .describe('Active-window length in months. Default 12.'),
        dormantLookbackMonths: z
          .number()
          .min(6)
          .max(120)
          .optional()
          .describe(
            'Total history considered for "dormant capable" identification. Suppliers who won ' +
              'between dormantLookback and active-window are flagged as dormant. Default 36.',
          ),
        limit: z.number().min(1).max(100).optional(),
      }),
      handler: async (ctx, input) =>
        withToolTelemetry(
          {
            ctx,
            toolName: 'find_competing_sellers',
            args: input,
            summarize: (out: {
              activeSellers: { length: number };
              dormantSellers: { length: number };
            }) => ({
              resultCount: out.activeSellers.length + out.dormantSellers.length,
              resultSummary: {
                categoryTag: input.categoryTag,
                activeCount: out.activeSellers.length,
                dormantCount: out.dormantSellers.length,
              },
            }),
          },
          async () => {
            const result = await findCompetingSellers({
              categoryTag: input.categoryTag,
              buyerCountries: input.buyerCountries,
              monthsLookback: input.monthsLookback,
              dormantLookbackMonths: input.dormantLookbackMonths,
              limit: input.limit ?? 25,
            });
            return {
              categoryTag: result.categoryTag,
              marketStats: result.marketStats,
              activeSellers: result.activeSellers,
              dormantSellers: result.dormantSellers,
              caveat:
                'Public procurement data only. Private commercial flows (refiner-to-refiner, ' +
                'trader-to-trader) are not represented. Dormant flagging is by public-tender ' +
                'inactivity — a supplier may be active in private channels we can’t see.',
            };
          },
        ),
    }),

    lookup_known_entities: defineTool({
      name: 'lookup_known_entities',
      description:
        'Query the analyst-curated rolodex of buyers / sellers / traders / refiners — the ' +
        'entities VTC has researched as relevant to its deal flow. DISTINCT from the supplier-' +
        'graph queries (find_buyers_for_offer / find_competing_sellers / analyze_supplier), ' +
        "which only see entities that appear in public-tender award data. Use this tool when " +
        "the user asks about entities that may not have public-tender activity: Mediterranean " +
        "private refiners, major trading houses (Vitol/Glencore/Trafigura), or any 'who could " +
        "buy X' question where private commercial flows dominate the market (crude oil, jet " +
        "fuel, marine bunker). Filter by category (crude-oil, diesel, etc), country, role " +
        "(refiner | trader | producer | state-buyer), or tag (e.g. 'region:mediterranean', " +
        "'public-tender-visible', 'libya-historic'). Returns entity name, country, role, " +
        'capability notes, and any contact entity that has been recorded.',
      kind: 'read',
      schema: z.object({
        categoryTag: z
          .string()
          .optional()
          .describe(
            'Internal commodity tag — same vocabulary as find_buyers_for_offer. e.g. crude-oil, ' +
              'diesel, jet-fuel.',
          ),
        country: z
          .string()
          .length(2)
          .optional()
          .describe('ISO-2 country code.'),
        role: z
          .enum(['refiner', 'trader', 'producer', 'state-buyer'])
          .optional()
          .describe('Filter to a single role.'),
        tag: z
          .string()
          .optional()
          .describe(
            "Free-text tag filter — exact match. Useful tags: 'region:mediterranean', " +
              "'region:asia-state', 'public-tender-visible', 'libya-historic', 'sweet-crude-runner', " +
              "'top-tier' (for trading houses), 'size:mega'.",
          ),
        limit: z.number().min(1).max(200).optional(),
      }),
      handler: async (ctx, input) =>
        withToolTelemetry(
          {
            ctx,
            toolName: 'lookup_known_entities',
            args: input,
            summarize: (out: { count: number }) => ({
              resultCount: out.count,
              resultSummary: {
                categoryTag: input.categoryTag,
                country: input.country,
                role: input.role,
                tag: input.tag,
              },
            }),
          },
          async () => {
            const rows = await lookupKnownEntities({
              categoryTag: input.categoryTag,
              country: input.country,
              role: input.role,
              tag: input.tag,
              limit: input.limit ?? 50,
            });
            return {
              count: rows.length,
              entities: rows.map((r) => ({
                id: r.id,
                name: r.name,
                country: r.country,
                role: r.role,
                categories: r.categories,
                notes: r.notes,
                contactEntity: r.contactEntity,
                tags: r.tags,
                metadata: r.metadata,
              })),
              caveat:
                'Curated analyst rolodex — facts here are public-knowledge basics (refinery name, ' +
                'operator, country, capacity). Not a substitute for customs/AIS data (Kpler, Vortexa) ' +
                'when current import flows matter. The notes field captures editorial; treat it as a ' +
                'starting point, not ground truth.',
            };
          },
        ),
    }),

    analyze_supplier: defineTool({
      name: 'analyze_supplier',
      description:
        'Deep-dive on a single supplier. Returns full capability profile: total awards ' +
        'across categories, top buyers, geographic footprint (where they have sold), most ' +
        'recent activity, and any private signals VTC has captured (RFQ responsiveness, ' +
        'capability confirmations, OFAC/credit screen results). Use this when the user ' +
        "names a specific supplier and wants to know: 'are they a real player', 'what's " +
        "their capability', 'who do they sell to', 'when did they last win something', or " +
        "'have we engaged with them before'. Accepts either supplierId or supplierName " +
        '(fuzzy-matched). When the tool returns kind=disambiguation_needed, ask the user ' +
        'to pick a candidate rather than guessing.',
      kind: 'read',
      schema: z
        .object({
          supplierId: z
            .string()
            .uuid()
            .optional()
            .describe('Canonical external_suppliers.id. Use when the supplier is already known.'),
          supplierName: z
            .string()
            .optional()
            .describe(
              'Free-text supplier name. Tool resolves via supplier_aliases (trigram fuzzy match). ' +
                'If multiple matches above similarity threshold, returns disambiguation options.',
            ),
          yearsLookback: z
            .number()
            .min(1)
            .max(20)
            .optional()
            .describe('How far back to summarize. Default 10 years for the full picture.'),
        })
        .refine((d) => d.supplierId || d.supplierName, {
          message: 'Provide either supplierId or supplierName',
        }),
      handler: async (ctx, input) =>
        withToolTelemetry(
          {
            ctx,
            toolName: 'analyze_supplier',
            args: input,
            summarize: (out: { kind: string }) => ({
              resultSummary: { kind: out.kind },
            }),
          },
          async () => {
        const result = await analyzeSupplier({
          supplierId: input.supplierId,
          supplierName: input.supplierName,
          yearsLookback: input.yearsLookback,
        });

        if (result.kind === 'disambiguation_needed') {
          return {
            kind: 'disambiguation_needed',
            candidates: result.candidates.map((c) => ({
              supplierId: c.supplierId,
              supplierName: c.canonicalName,
              country: c.country,
              totalAwards: c.totalAwards,
              similarityScore: c.similarityScore,
            })),
            message:
              'Multiple suppliers match that name. Ask the user to pick one (or call this ' +
              'tool again with the supplierId of the intended match).',
          };
        }

        if (result.kind === 'not_found') {
          return {
            kind: 'not_found',
            searchedFor: input.supplierName ?? input.supplierId,
            suggestion:
              'No supplier matches this name in the public award database. They may be a ' +
              'private commercial supplier (not visible in public tender data), a new ' +
              'entrant, or a name variant we have not yet aliased.',
          };
        }

        return {
          kind: 'profile',
          supplier: {
            id: result.supplier.id,
            canonicalName: result.supplier.canonicalName,
            country: result.supplier.country,
            aliases: result.supplier.aliases?.slice(0, 5) ?? [],
          },
          capabilities: {
            totalAwards: result.summary.totalAwards,
            totalValueUsd: result.summary.totalValueUsd,
            firstAwardDate: result.summary.firstAwardDate,
            mostRecentAwardDate: result.summary.mostRecentAwardDate,
            awardsByCategory: result.summary.awardsByCategory,
          },
          topBuyers: result.topBuyers.slice(0, 10),
          geography: {
            buyerCountries: result.summary.buyerCountries,
            beneficiaryCountries: result.summary.beneficiaryCountries,
          },
          recentAwards: result.recentAwards.slice(0, 5).map((a) => ({
            awardDate: a.awardDate,
            buyerName: a.buyerName,
            buyerCountry: a.buyerCountry,
            title: a.title,
            valueUsd: a.contractValueUsd,
          })),
          // Private behavioral signals — TENANT SCOPING TODO: filter by
          // ctx.companyId once the table starts holding private data.
          // See packages/db/src/schema/supplier-signals.ts.
          signals: result.signals?.slice(0, 10) ?? [],
        };
          },
        ),
    }),
  };
}
