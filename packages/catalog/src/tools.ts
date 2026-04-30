import 'server-only';
import { defineTool, withToolTelemetry, type ToolRegistry } from '@procur/ai';
import { z } from 'zod';
import {
  analyzeSupplier,
  briefOpportunity,
  buildEntityProfileUrl,
  findBuyersForCommodityOffer,
  findCompetingSellers,
  findSuppliersForTender,
  getMonthlyImportFlow,
  getTopImportersByPartner,
  getTopSourcesForReporter,
  lookupKnownEntities,
  listCrudeGrades,
  lookupRefineriesByGrade,
  getCommodityPriceContext,
  getCommoditySpread,
  getCommodityTicker,
  getCrudeBasis,
  findDistressedSuppliers,
  findRecentPortCalls,
  findRecentSimilarAwards,
  analyzeSupplierPricing,
  analyzeBuyerPricing,
  evaluateOfferAgainstHistory,
  getCompanyDealDefaults,
  getCompanyProfile,
  listJurisdictions,
  listOpportunities,
  getOpportunityBySlug,
  pricingIntel,
  summarizeCatalog,
  whatsNewForUser,
  type OpportunityScope,
} from './queries';
import {
  addOpportunityToPursuit,
  createAlertProfile,
  upsertSupplierApproval,
} from './mutations';
import { SUPPLIER_APPROVAL_STATUSES } from '@procur/db';
import { composeDealEconomics, type CompanyDealDefaults } from './deal-economics';
import {
  isFreightOriginRegion,
  lookupFreightEstimate,
  type FreightOriginRegion,
} from './freight-routes';
import {
  evaluateTargetPrice,
  evaluateMultiProductRfq,
  type ProductSlug,
} from './plausibility';

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

    set_supplier_approval: defineTool({
      name: 'set_supplier_approval',
      description:
        "Update the user company's KYC/approval state with a supplier entity. Use when the user " +
        'says things like "we got KYC approval from CEPSA", "mark Reficar as approved", "we ' +
        'are pending KYC with Vitol", "Trafigura\'s KYC just expired". Status taxonomy:\n' +
        '  • pending              — outreach started, no docs exchanged\n' +
        '  • kyc_in_progress      — KYC docs submitted, awaiting their review\n' +
        '  • approved_without_kyc — supplier accepts trade contractually, no formal KYC\n' +
        '  • approved_with_kyc    — full approval, KYC complete (the strongest state)\n' +
        '  • rejected             — supplier declined to onboard\n' +
        '  • expired              — KYC lapsed (typically 12-month re-cert)\n' +
        'IDEMPOTENT — re-engagement after rejection or expiry is a status update on the ' +
        'existing row, not a new row. Confirm the user\'s intent in plain language BEFORE ' +
        'calling — this writes to their account. After the write, surface the badge state ' +
        '("CEPSA Gibraltar is now flagged KYC Approved on the rolodex").',
      kind: 'write',
      schema: z.object({
        entitySlug: z
          .string()
          .min(1)
          .describe(
            'The slug returned in profileUrl by lookup_known_entities (e.g. ' +
              '"ft-es-cepsa-gibraltar-refinery") OR an external_suppliers.id ' +
              '(UUID). Whatever the entity profile page accepts as its slug ' +
              'parameter. Pull this from a prior tool result; do NOT invent.',
          ),
        entityName: z
          .string()
          .optional()
          .describe(
            "Display name snapshot — used by the settings summary panel " +
              "when the entity row hasn't been fetched. Pass the name you " +
              'just saw in lookup_known_entities.',
          ),
        status: z
          .enum(SUPPLIER_APPROVAL_STATUSES)
          .describe(
            'New approval status. See description for the taxonomy. Default ' +
              'to approved_with_kyc when the user says "approved" without ' +
              'qualifying — KYC-complete is the assumption for major ' +
              'counterparties.',
          ),
        expiresAt: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe(
            'YYYY-MM-DD. KYC re-cert date. Set when status is approved_with_kyc ' +
              'and you know the renewal cycle. Default unset (no expiry tracked).',
          ),
        notes: z
          .string()
          .max(2000)
          .optional()
          .describe(
            'Free-text notes about the approval — e.g. who signed off, any ' +
              'conditions, contract reference. Visible on the entity profile.',
          ),
      }),
      handler: async (ctx, input) => {
        const result = await upsertSupplierApproval({
          companyId: ctx.companyId,
          userId: ctx.userId,
          entitySlug: input.entitySlug,
          entityName: input.entityName ?? null,
          status: input.status,
          expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
          notes: input.notes ?? null,
        });
        return {
          ...result,
          status: input.status,
          entitySlug: input.entitySlug,
          profileUrl: buildEntityProfileUrl({
            kind: 'known_entity',
            slug: input.entitySlug,
          }),
        };
      },
    }),

    get_company_profile: defineTool({
      name: 'get_company_profile',
      description:
        "Snapshot of the user's own company — name, plan tier, capability list (categorized: " +
        "service / certification / technology / geography / personnel / past_performance), " +
        'sample past-performance projects with categories + NAICS codes + keywords, AND ' +
        'tradingPreferences (defaultSourcingRegion, targetGrossMarginPct, ' +
        'targetNetMarginPerUsg, monthlyFixedOverheadUsdDefault — desk-level economics ' +
        'defaults that compose_deal_economics applies automatically). Call this ' +
        'ONCE early in a conversation when the user asks for recommendations, "should I bid", ' +
        '"is this a fit for us", "what should I look at", any fuel-deal economics question ' +
        '(so you know which margin floor + sourcing region they trade off), or anything that ' +
        "requires understanding what they actually do. Don't re-fetch each turn — the data " +
        "doesn't change within a session. Use the returned context to bias subsequent " +
        "search_opportunities calls toward matching jurisdictions / categories / keywords, " +
        'and to answer fit questions concretely. When tradingPreferences fields are non-null ' +
        'mention them when narrating compose_deal_economics output (e.g. "above your 5% gross-' +
        'margin floor"); when null call out the calculator default ("at the default 4% floor").',
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
                profileUrl: buildEntityProfileUrl({ kind: 'supplier', id: s.supplierId }),
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
              activeSellers: result.activeSellers.map((s) => ({
                ...s,
                profileUrl: buildEntityProfileUrl({ kind: 'supplier', id: s.supplierId }),
              })),
              dormantSellers: result.dormantSellers.map((s) => ({
                ...s,
                profileUrl: buildEntityProfileUrl({ kind: 'supplier', id: s.supplierId }),
              })),
              caveat:
                'Public procurement data only. Private commercial flows (refiner-to-refiner, ' +
                'trader-to-trader) are not represented. Dormant flagging is by public-tender ' +
                'inactivity — a supplier may be active in private channels we can’t see.',
            };
          },
        ),
    }),

    lookup_customs_flows: defineTool({
      name: 'lookup_customs_flows',
      description:
        'Customs trade-flow data — works in both directions:\n' +
        '  • direction="imports" (default): given a partner country, returns top countries ' +
        'IMPORTING from it. Use for buy-side market sizing — "which countries import Libyan ' +
        'crude" tells you the buyer universe.\n' +
        '  • direction="sources": given a reporter country, returns top countries SUPPLYING ' +
        'it. Use for SELL-SIDE / sourcing — "Italy needs diesel for a tender; which countries ' +
        "currently supply Italy with diesel?\".\n" +
        'Sources: Eurostat Comext (EU reporters, monthly, EUR) + UN Comtrade (global, monthly, ' +
        'USD, ~3-month lag). Cross-source dedup prefers Eurostat for EU reporters. ' +
        'COUNTRY-LEVEL granularity, not per-cargo — pair with lookup_known_entities to drill ' +
        'down to specific refineries / suppliers within a candidate country. Not a replacement ' +
        'for paid AIS sources (Kpler/Vortexa) when per-cargo attribution matters.',
      kind: 'read',
      schema: z.object({
        direction: z
          .enum(['imports', 'sources'])
          .optional()
          .describe(
            "'imports' (default) ranks countries that IMPORT from partnerCountry. 'sources' " +
              'ranks countries that SUPPLY reporterCountry. Pick based on which direction the ' +
              'user is asking about — buy-side question = imports, sell-side / sourcing question = sources.',
          ),
        partnerCountry: z
          .string()
          .regex(
            /^[A-Z]{2}$/,
            'partnerCountry must be an ISO-2 country code (uppercase, e.g. CO for Colombia, LY for Libya, NG for Nigeria). Full country names like "Colombia" will fail.',
          )
          .optional()
          .describe(
            "ISO-2 country of origin. Required when direction='imports'. e.g. 'LY' for Libya, " +
              "'CO' for Colombia. Full country names like 'Colombia' will fail — pass the 2-letter code.",
          ),
        reporterCountry: z
          .string()
          .regex(
            /^[A-Z]{2}$/,
            'reporterCountry must be an ISO-2 country code (uppercase, e.g. IT for Italy, KE for Kenya, GH for Ghana). Full country names like "Italy" will fail.',
          )
          .optional()
          .describe(
            "ISO-2 country importing. Required when direction='sources'. e.g. 'IT' for Italy, " +
              "'KE' for Kenya. Full country names like 'Italy' will fail — pass the 2-letter code.",
          ),
        productCode: z
          .string()
          .optional()
          .describe(
            "HS code (2/4/6/8 digits). Common: '2709' = crude petroleum, '2710' = refined " +
              "fuel, '2711' = LNG/LPG. Use 4-digit HS to keep results aggregated. " +
              "Accepts the alias `hsCode` if you naturally reach for that name.",
          ),
        hsCode: z
          .string()
          .optional()
          .describe(
            "Alias for productCode — same HS-code value. Models often type " +
              "`hsCode` because the description above mentions HS codes; either " +
              "name works.",
          ),
        monthsLookback: z
          .number()
          .min(1)
          .max(60)
          .optional()
          .describe('Default 12 months.'),
        limit: z.number().min(1).max(50).optional(),
      }).refine(
        (d) =>
          (d.direction === 'sources' && d.reporterCountry) ||
          (d.direction !== 'sources' && d.partnerCountry),
        {
          message:
            "direction='imports' requires partnerCountry; direction='sources' requires reporterCountry.",
        },
      ).refine((d) => Boolean(d.productCode ?? d.hsCode), {
        message:
          'productCode (or hsCode alias) is required — pass an HS code like "2709" (crude) or "2710" (refined fuel).',
        path: ['productCode'],
      }),
      handler: async (ctx, input) => {
        // Coalesce the productCode / hsCode aliases. The model can pass
        // either; downstream queries take productCode. Refine() above
        // ensures at least one is present, so productCode is non-null
        // here.
        const productCode = (input.productCode ?? input.hsCode)!;
        return withToolTelemetry(
          {
            ctx,
            toolName: 'lookup_customs_flows',
            args: input,
            summarize: (out: { rankedCountries: { length: number } }) => ({
              resultCount: out.rankedCountries.length,
              resultSummary: {
                direction: input.direction ?? 'imports',
                productCode,
                pivotCountry: input.partnerCountry ?? input.reporterCountry,
              },
            }),
          },
          async () => {
            const direction = input.direction ?? 'imports';

            if (direction === 'sources') {
              const reporterCountry = input.reporterCountry!;
              const sources = await getTopSourcesForReporter(
                {
                  reporterCountry,
                  productCode,
                  monthsLookback: input.monthsLookback,
                  partnerCountry: input.partnerCountry,
                },
                input.limit ?? 25,
              );
              const noData = sources.length === 0;
              return {
                direction,
                reporterCountry,
                productCode,
                noData,
                narrative: noData
                  ? `No published HS ${productCode} sources for ${reporterCountry} in the last ` +
                    `${input.monthsLookback ?? 12} months across Eurostat Comext + UN Comtrade. ` +
                    `Either the corridor isn't covered or the flow is too small to surface. Try a ` +
                    `wider monthsLookback, a 4-digit HS code, or pair with lookup_known_entities ` +
                    `to find candidate suppliers directly.`
                  : null,
                rankedCountries: sources.map((r) => ({
                  country: r.partnerCountry,
                  role: 'source',
                  totalKt: r.totalQuantityKg != null ? Math.round(r.totalQuantityKg / 1_000) : null,
                  totalUsd: r.totalValueUsd,
                  monthsActive: r.monthsActive,
                  mostRecentPeriod: r.mostRecentPeriod,
                })),
                caveat:
                  'Country-level supply view. The countries listed are where the importer has ' +
                  'historically sourced from — pair with lookup_known_entities filtered by those ' +
                  "countries (and role='refiner' or 'producer') to surface candidate counterparties.",
              };
            }

            const partnerCountry = input.partnerCountry!;
            const filters = {
              partnerCountry,
              productCode,
              monthsLookback: input.monthsLookback,
              reporterCountry: input.reporterCountry,
            };
            const [topImporters, monthly] = await Promise.all([
              getTopImportersByPartner(filters, input.limit ?? 25),
              getMonthlyImportFlow(filters),
            ]);
            // Coverage gap signal: when neither the importer ranking nor
            // any month has a non-null value, the corridor isn't covered
            // by Eurostat/Comtrade for this period. Surfacing 12+ rows
            // of `null` forces the model to interpret an absence; a
            // single `noData: true` + narrative is unambiguous and lets
            // it lead with "no published flow recorded" instead of
            // narrating empty months one-by-one.
            const monthlyHasData = monthly.some(
              (b) => b.quantityKg != null || b.valueUsd != null,
            );
            const noData = topImporters.length === 0 && !monthlyHasData;
            return {
              direction,
              partnerCountry,
              productCode,
              noData,
              narrative: noData
                ? `No HS ${productCode} import flow from ${partnerCountry} recorded in the last ` +
                  `${input.monthsLookback ?? 12} months across Eurostat Comext + UN Comtrade. ` +
                  `Either the corridor isn't covered by these sources, or the flow is too small ` +
                  `to surface. Try a wider monthsLookback, a 4-digit HS code (e.g. 2710 instead ` +
                  `of 271019), or pair with lookup_known_entities to find candidate counterparties directly.`
                : null,
              rankedCountries: topImporters.map((r) => ({
                country: r.reporterCountry,
                role: 'importer',
                totalKt: r.totalQuantityKg != null ? Math.round(r.totalQuantityKg / 1_000) : null,
                totalUsd: r.totalValueUsd,
                totalEur: r.totalValueEur,
                monthsActive: r.monthsActive,
                mostRecentPeriod: r.mostRecentPeriod,
              })),
              monthlyFlow: monthly.map((b) => ({
                period: b.period,
                quantityKt: b.quantityKg != null ? Math.round(b.quantityKg / 1_000) : null,
                valueUsd: b.valueUsd,
              })),
              caveat:
                'Eurostat Comext (EU reporters) + UN Comtrade (global) merged with source-' +
                'priority dedup. Country-level, not per-cargo. For per-cargo buyer attribution, ' +
                'paid AIS/customs services (Kpler/Vortexa) are required. Pair with ' +
                'lookup_known_entities to attribute country imports to candidate refineries.',
            };
          },
        );
      },
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
        name: z
          .string()
          .optional()
          .describe(
            'Case-insensitive substring match against name, slug, AND ' +
              'aliases[]. Use this for "do we have X in the rolodex" ' +
              'questions — e.g. name="Petroilsa" finds an entity ' +
              'named "Petroilsa S.A." or aliased to "Petroilsa Colombia". ' +
              'Combine with country / role / categoryTag to narrow ' +
              'further. If you call this tool with no filters, you get ' +
              'the first 50 rows by country alphabetically — that\'s ' +
              'probably not what you want; always pass at least one ' +
              'filter.',
          ),
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
        approvalStatus: z
          .enum(['approved', 'pending', 'rejected', 'expired', 'none'])
          .optional()
          .describe(
            "Filter by the user's company KYC/approval state with this " +
              "supplier. 'approved' = approved_with_kyc OR approved_without_kyc " +
              "(can transact today). 'pending' = pending OR kyc_in_progress. " +
              "'expired' = KYC needs renewal. 'none' = no engagement yet. " +
              'When ranking suppliers for a deal, filter or sort by ' +
              "'approved' first — those are the only counterparties the user " +
              'can actually trade with this week.',
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
                name: input.name,
                categoryTag: input.categoryTag,
                country: input.country,
                role: input.role,
                tag: input.tag,
                approvalStatus: input.approvalStatus,
              },
            }),
          },
          async () => {
            const rows = await lookupKnownEntities({
              name: input.name,
              categoryTag: input.categoryTag,
              country: input.country,
              role: input.role,
              tag: input.tag,
              companyId: ctx.companyId,
              approvalStatus: input.approvalStatus,
              limit: input.limit ?? 50,
            });
            return {
              count: rows.length,
              entities: rows.map((r) => ({
                id: r.id,
                name: r.name,
                profileUrl: buildEntityProfileUrl({ kind: 'known_entity', slug: r.slug }),
                country: r.country,
                role: r.role,
                categories: r.categories,
                notes: r.notes,
                contactEntity: r.contactEntity,
                tags: r.tags,
                metadata: r.metadata,
                approvalStatus: r.approvalStatus,
                approvalApprovedAt: r.approvalApprovedAt,
                approvalExpiresAt: r.approvalExpiresAt,
              })),
              caveat:
                'Curated analyst rolodex — facts here are public-knowledge basics (refinery name, ' +
                'operator, country, capacity). Not a substitute for customs/AIS data (Kpler, Vortexa) ' +
                'when current import flows matter. The notes field captures editorial; treat it as a ' +
                'starting point, not ground truth. approvalStatus reflects the calling company\'s ' +
                'KYC/approval state with this entity (null = not engaged yet); lead with approved ' +
                'counterparties when ranking for a deal.',
            };
          },
        ),
    }),

    list_crude_grades: defineTool({
      name: 'list_crude_grades',
      description:
        'List crude oil grades (physical streams + pricing benchmarks) with their ' +
        'material properties — API gravity, sulfur %, TAN, characterization. Use this ' +
        'before lookup_refineries_compatible_with_grade when the user references a grade ' +
        'name informally and you need to confirm the slug, or when the user asks ' +
        '"what grades are similar to X" / "what competes with Es Sider in the Med pool".',
      kind: 'read',
      schema: z.object({
        region: z
          .enum([
            'mediterranean',
            'west-africa',
            'gulf',
            'caspian',
            'asia-pacific',
            'americas',
            'north-sea',
          ])
          .optional()
          .describe('Filter to one production region.'),
        originCountry: z
          .string()
          .length(2)
          .optional()
          .describe('ISO-2 country of production. e.g. LY for Libyan grades.'),
      }),
      handler: async (ctx, input) =>
        withToolTelemetry(
          {
            ctx,
            toolName: 'list_crude_grades',
            args: input,
            summarize: (out: { count: number }) => ({
              resultCount: out.count,
              resultSummary: { region: input.region, originCountry: input.originCountry },
            }),
          },
          async () => {
            const rows = await listCrudeGrades({
              region: input.region,
              originCountry: input.originCountry,
            });
            return {
              count: rows.length,
              grades: rows,
            };
          },
        ),
    }),

    lookup_refineries_compatible_with_grade: defineTool({
      name: 'lookup_refineries_compatible_with_grade',
      description:
        'Given a crude grade slug (e.g. "es-sider", "bonny-light", "arab-light"), return ' +
        'the refineries in the rolodex that can run it. Two match paths are unioned: ' +
        '(1) explicit analyst-curated `compatible:<grade>` tag — highest confidence; ' +
        '(2) slate-window — the grade fits inside the refinery\'s configured API + sulfur ' +
        'window. Use this whenever the user asks "who can buy X crude" or "which ' +
        'Mediterranean refiners run Libyan grade". For Libyan barrels: try "es-sider" or ' +
        '"sirtica" first. For Nigerian: "bonny-light" or "qua-iboe". Use list_crude_grades ' +
        'first if the user references a grade by an informal name.',
      kind: 'read',
      schema: z.object({
        gradeSlug: z
          .string()
          .describe(
            'crude_grades.slug — must match an existing grade. Use list_crude_grades to discover.',
          ),
        country: z
          .string()
          .length(2)
          .optional()
          .describe('Restrict to refineries in this ISO-2 country.'),
        limit: z.number().min(1).max(200).optional(),
      }),
      handler: async (ctx, input) =>
        withToolTelemetry(
          {
            ctx,
            toolName: 'lookup_refineries_compatible_with_grade',
            args: input,
            summarize: (out: { count: number }) => ({
              resultCount: out.count,
              resultSummary: { gradeSlug: input.gradeSlug, country: input.country },
            }),
          },
          async () => {
            const rows = await lookupRefineriesByGrade(input.gradeSlug, {
              country: input.country,
              limit: input.limit,
            });
            return {
              count: rows.length,
              gradeSlug: input.gradeSlug,
              refineries: rows.map((r) => ({
                name: r.name,
                country: r.country,
                profileUrl: buildEntityProfileUrl({ kind: 'known_entity', slug: r.slug }),
                capacityBpd: r.capacityBpd,
                operator: r.operator,
                notes: r.notes,
                matchSource: r.matchSource,
                slateNotes: r.slateNotes,
              })),
            };
          },
        ),
    }),

    get_crude_basis: defineTool({
      name: 'get_crude_basis',
      description:
        'Resolve a named crude grade to its pricing marker + live spot + ' +
        'structural differential, with the fair-value all-in price computed. ' +
        'Use whenever the user references a named crude (Azeri Light, Es Sider, ' +
        'Bonny Light, Urals, Maya, etc.) and wants to know fair value or ' +
        'whether an offer is in-band. Returns markerSlug + differentialUsdPerBbl ' +
        '+ markerSpotUsdPerBbl + fairValueUsdPerBbl + asOf. Composes cleanly ' +
        'with get_market_snapshot — call this first for the basis, then ' +
        'compose_deal_economics with productCostPerBbl set to the fair value ' +
        'for the deal model. Differentials are hand-curated (refresh quarterly); ' +
        'they reflect the structural quality / logistics / sanctions context, ' +
        'not transient day-to-day moves.',
      kind: 'read',
      schema: z.object({
        gradeSlug: z
          .string()
          .min(1)
          .describe(
            "crude_grades.slug. Common values: 'es-sider', 'sharara', 'sirtica', " +
              "'bonny-light', 'qua-iboe', 'azeri-light', 'cpc-blend', 'kirkuk', " +
              "'arab-light', 'arab-medium', 'arab-heavy', 'iran-heavy', " +
              "'basrah-light', 'maya', 'wcs', 'merey'. For markers themselves " +
              "(brent, wti, dubai, urals): returns the marker's own spot.",
          ),
      }),
      handler: async (ctx, input) =>
        withToolTelemetry(
          {
            ctx,
            toolName: 'get_crude_basis',
            args: input,
            summarize: (out: unknown) => ({
              resultCount: out == null ? 0 : 1,
              resultSummary: { gradeSlug: input.gradeSlug },
            }),
          },
          async () => {
            const result = await getCrudeBasis(input.gradeSlug);
            if (!result) {
              return {
                error: 'unknown_grade',
                gradeSlug: input.gradeSlug,
                hint: 'Use list_crude_grades to discover available slugs.',
              };
            }
            return result;
          },
        ),
    }),

    get_commodity_price_context: defineTool({
      name: 'get_commodity_price_context',
      description:
        'MANDATORY before quoting any spot, benchmark level, or differential. ' +
        'Returns latest spot + 30-day moving average + window high/low + ' +
        '% change for one commodity series. Series slugs: \'brent\' (Europe ' +
        'spot), \'wti\' (Cushing OK), \'nyh-diesel\' (NY Harbor ULSD, $/gal), ' +
        "'nyh-gasoline' ($/gal), 'nyh-heating-oil' ($/gal). " +
        'For multi-series narratives (any answer touching more than one ' +
        'benchmark, or a "current market" framing) call get_market_snapshot ' +
        'first, then drill in here only if you need MA / window stats. ' +
        'If noData=true, say so explicitly — do not fabricate a price from ' +
        'training data; pre-cutoff prices are wrong by default.',
      kind: 'read',
      schema: z.object({
        seriesSlug: z
          .string()
          .describe(
            "commodity_prices.series_slug. Common values: 'brent', 'wti', 'nyh-diesel', " +
              "'nyh-gasoline', 'nyh-heating-oil'.",
          ),
        windowDays: z
          .number()
          .int()
          .min(1)
          .max(365)
          .optional()
          .describe('Lookback window for moving avg / high / low. Default 30.'),
      }),
      handler: async (ctx, input) =>
        withToolTelemetry(
          {
            ctx,
            toolName: 'get_commodity_price_context',
            args: input,
            summarize: (out: { noData: boolean }) => ({
              resultCount: out.noData ? 0 : 1,
              resultSummary: { seriesSlug: input.seriesSlug, windowDays: input.windowDays ?? 30 },
            }),
          },
          async () => getCommodityPriceContext(input.seriesSlug, input.windowDays ?? 30),
        ),
    }),

    get_commodity_spread: defineTool({
      name: 'get_commodity_spread',
      description:
        "Today's spread between two commodity series — e.g. Brent–WTI, Brent–Urals. Use " +
        "when the user asks about differentials, when explaining a Russian-crude discount, " +
        "or when quoting where a non-marker grade trades relative to its benchmark. " +
        "Returns base_price - target_price along with both raw prices and the as-of date. " +
        "Returns null spread if either series hasn't been ingested.",
      kind: 'read',
      schema: z.object({
        baseSlug: z
          .string()
          .describe("Reference series. Typically 'brent' or 'wti'."),
        targetSlug: z
          .string()
          .describe(
            "Series to subtract — the spread is base_price - target_price. " +
              "For Urals discount: base='brent', target='urals' (positive = Urals trades below Brent).",
          ),
      }),
      handler: async (ctx, input) =>
        withToolTelemetry(
          {
            ctx,
            toolName: 'get_commodity_spread',
            args: input,
            summarize: (out: { spread: number | null }) => ({
              resultCount: out.spread != null ? 1 : 0,
              resultSummary: input,
            }),
          },
          async () => getCommoditySpread(input.baseSlug, input.targetSlug),
        ),
    }),

    get_market_snapshot: defineTool({
      name: 'get_market_snapshot',
      description:
        'PRIMARY pricing primer. One round-trip returns the latest spot for ' +
        'every major energy benchmark we ingest (brent, wti, nyh-diesel, ' +
        'nyh-gasoline, nyh-heating-oil) plus the Brent–WTI spread, each with ' +
        'the as-of date and 30-day % change. Call this first for any ' +
        'response that touches pricing, market commentary, "is this fair", ' +
        'crude/refined differentials, or a deal-composition pricing-context ' +
        'section. Cheap, no arguments, idempotent. Drill into ' +
        "get_commodity_price_context only if you need a single series' MA " +
        'or 30-day high/low; use get_commodity_spread for non-Brent–WTI ' +
        'spreads. If a series shows latestPrice=null it has not been ' +
        'ingested yet — say so; never substitute a training-data price.',
      kind: 'read',
      schema: z.object({}),
      handler: async (ctx, _input) =>
        withToolTelemetry(
          {
            ctx,
            toolName: 'get_market_snapshot',
            args: {},
            summarize: (out: { series: Array<{ latestPrice: number | null }> }) => ({
              resultCount: out.series.filter((s) => s.latestPrice != null).length,
              resultSummary: { totalSeries: out.series.length },
            }),
          },
          async () => {
            const ticker = await getCommodityTicker([
              'brent',
              'wti',
              'nyh-diesel',
              'nyh-gasoline',
              'nyh-heating-oil',
            ]);
            const bySlug = new Map(ticker.map((t) => [t.seriesSlug, t]));
            const brent = bySlug.get('brent');
            const wti = bySlug.get('wti');
            const brentWtiSpread =
              brent?.latestPrice != null && wti?.latestPrice != null
                ? {
                    base: 'brent',
                    target: 'wti',
                    spread: brent.latestPrice - wti.latestPrice,
                    asOf: brent.latestDate,
                  }
                : null;
            return {
              series: ticker.map((t) => ({
                seriesSlug: t.seriesSlug,
                latestPrice: t.latestPrice,
                asOf: t.latestDate,
                unit: t.unit,
                pctChange30d: t.pctChange30d,
              })),
              brentWtiSpread,
              note:
                'Procur ingests FRED (Brent/WTI, $/bbl) and EIA NY Harbor ' +
                '(diesel/gasoline/heating-oil, $/gal). Crude grades not in ' +
                'this list (Azeri Light, Urals, Es Sider, etc.) are commercial ' +
                'differentials to a marker — quote them as a typical premium/' +
                'discount range over the live marker price returned here.',
            };
          },
        ),
    }),

    get_freight_estimate: defineTool({
      name: 'get_freight_estimate',
      description:
        'Lump-sum / per-MT freight bands for product or crude routes ' +
        'into West/East Africa, Caribbean, and Mediterranean refinery ' +
        'ports. Use whenever a deal involves shipping cost — "how much ' +
        'is freight Med to Lomé", "what does NWE→Mombasa cost on an ' +
        'MR1", "is $40/MT realistic for USGC→Tema". Returns USD/MT band ' +
        '(low/high) plus the typical vessel class. If destPortSlug is ' +
        'omitted you get all routes for the origin region; if origin is ' +
        'omitted you see every sourcing option for that destination — ' +
        "useful for cheapest-source comparisons. Data is analyst-curated, " +
        'refreshed quarterly — not a live broker quote.',
      kind: 'read',
      schema: z.object({
        originRegion: z
          .enum([
            'med',
            'nwe',
            'usgc',
            'singapore',
            'mideast',
            'india',
            'west-africa',
            'east-africa',
            'black-sea',
          ])
          .optional()
          .describe(
            'Sourcing region. med = Mediterranean (incl. NAfrica), nwe = NW ' +
              'Europe / ARA (Rotterdam/Antwerp/Amsterdam), usgc = US Gulf ' +
              'Coast, mideast = AG (Fujairah/Jubail), india = Indian export ' +
              'refineries, etc.',
          ),
        destPortSlug: z
          .string()
          .optional()
          .describe(
            "Destination port slug as seeded in the ports table " +
              "(e.g. 'lome-port', 'mombasa-port', 'tema-port'). Find via " +
              'find_recent_port_calls or the entity profile.',
          ),
        destCountry: z
          .string()
          .regex(/^[A-Z]{2}$/, 'destCountry must be an ISO-2 country code (uppercase, e.g. GH, KE, TG). Full country names like "Ghana" will fail.')
          .optional()
          .describe(
            'ISO-2 country code (e.g. \'GH\', \'KE\', \'TG\', \'NG\'). ' +
              'Full country names like \'Ghana\' will fail — pass the 2-letter ' +
              'code. Use when you want all ports in a country (e.g. ' +
              "destCountry='KE' returns Mombasa + any other Kenyan ports).",
          ),
        productType: z
          .enum(['clean', 'crude'])
          .optional()
          .describe(
            'clean = refined products (diesel, gasoline, jet, kero); ' +
              'crude = crude oil cargoes.',
          ),
      }),
      handler: async (ctx, input) =>
        withToolTelemetry(
          {
            ctx,
            toolName: 'get_freight_estimate',
            args: input,
            summarize: (out: { count: number }) => ({
              resultCount: out.count,
              resultSummary: input,
            }),
          },
          async () => {
            const routes = lookupFreightEstimate({
              originRegion: input.originRegion as FreightOriginRegion | undefined,
              destPortSlug: input.destPortSlug,
              destCountry: input.destCountry,
              productType: input.productType,
            });
            return {
              count: routes.length,
              routes,
              caveat:
                'Analyst-curated freight bands, refreshed quarterly. ' +
                'Real spot rates fluctuate daily with vessel availability ' +
                'and seasonal premiums (e.g. Suez disruption, winter ' +
                'demand). Treat as a sanity-check anchor, not a live ' +
                'charter quote.',
            };
          },
        ),
    }),

    evaluate_target_price: defineTool({
      name: 'evaluate_target_price',
      description:
        "Plausibility check on a buyer's target CIF price OR a " +
        '"what should I quote?" CIF estimator. Given a product, ' +
        'delivery port, and (optional) target price, computes a ' +
        'realistic CIF range from live spot benchmark + crack spread + ' +
        'freight + typical seller margin.\n\n' +
        'Two modes:\n' +
        '  1. WITH target → returns % gap + verdict (overpriced | ' +
        'plausible | aggressive | unrealistic | scam-flag). Use when ' +
        'the user shares a buyer target ("they want $430/MT CIF Lomé").\n' +
        '  2. WITHOUT target → returns realistic CIF range only with ' +
        "verdict='no-target'. Use when the user asks \"what should I " +
        'quote for X?" — gives a sourcing-cost anchor before they ' +
        "decide pricing.\n\n" +
        'Especially critical for West/East Africa RFQs in target mode ' +
        '— broker-chain anchors often run 30-50% below physical cost.',
      kind: 'read',
      schema: z
        .object({
          product: z
            .enum([
              'en590-ulsd',
              'gasoline-super',
              'jet-a1',
              'kerosene',
              'gasoil-0.5pct',
              'hsfo',
              'crude-light-sweet',
              'crude-medium-sour',
            ])
            .describe(
              'Product slug. en590-ulsd = European 10ppm diesel; ' +
                'gasoline-super = 95RON+ gasoline; jet-a1 = aviation ' +
                'kerosene; kerosene = lamp/heating kerosene; ' +
                'gasoil-0.5pct = low-sulfur marine gasoil; hsfo = high-' +
                'sulfur fuel oil; crude-light-sweet = Brent-spec generic; ' +
                'crude-medium-sour = Dubai-spec generic.',
            ),
          targetCifUsdPerMt: z
            .number()
            .positive()
            .optional()
            .describe(
              "Buyer's target CIF in USD per metric ton. Optional — " +
                'omit (along with targetCifUsdPerBbl) to get realistic ' +
                'CIF range only without a verdict.',
            ),
          targetCifUsdPerBbl: z
            .number()
            .positive()
            .optional()
            .describe(
              "Buyer's target CIF in USD per barrel. Optional — same " +
                'as above.',
            ),
          destPortSlug: z
            .string()
            .describe(
              "Delivery port slug (e.g. 'lome-port', 'mombasa-port').",
            ),
          originRegion: z
            .enum([
              'med',
              'nwe',
              'usgc',
              'singapore',
              'mideast',
              'india',
              'west-africa',
              'east-africa',
              'black-sea',
            ])
            .optional()
            .describe(
              'Most likely sourcing region. If omitted, the cheapest ' +
                'matching route across all origins is used (gives the ' +
                'most generous plausibility check).',
            ),
          volumeMt: z
            .number()
            .positive()
            .optional()
            .describe('Optional volume hint, used only for output context.'),
        }),
      handler: async (ctx, input) =>
        withToolTelemetry(
          {
            ctx,
            toolName: 'evaluate_target_price',
            args: input,
            summarize: (out: { verdict: string; pctGapVsMid: number | null }) => ({
              resultCount: 1,
              resultSummary: {
                product: input.product,
                destPortSlug: input.destPortSlug,
                verdict: out.verdict,
                pctGapVsMid: out.pctGapVsMid,
              },
            }),
          },
          async () =>
            evaluateTargetPrice({
              product: input.product as ProductSlug,
              targetCifUsdPerMt: input.targetCifUsdPerMt,
              targetCifUsdPerBbl: input.targetCifUsdPerBbl,
              destPortSlug: input.destPortSlug,
              originRegion: input.originRegion as FreightOriginRegion | undefined,
              volumeMt: input.volumeMt,
            }),
        ),
    }),

    evaluate_multi_product_rfq: defineTool({
      name: 'evaluate_multi_product_rfq',
      description:
        'Bulk evaluator for multi-product RFQs. Two modes:\n\n' +
        '  1. WITH per-line targets → plausibility check. Returns per-' +
        'line verdicts + consolidated scorecard (worst-line verdict, ' +
        "weighted-avg % gap, total $ at buyer's target vs realistic). " +
        'Use when the user pastes a buyer RFQ that includes target ' +
        'prices ("EN590 @ $430/MT CIF Lomé").\n\n' +
        '  2. WITHOUT per-line targets → realistic CIF range per line ' +
        'only. Use when the user has products + ports + volumes but ' +
        "hasn't quoted a target — answers \"what should I quote?\" for " +
        'the whole package in one call.\n\n' +
        'Targets are optional PER LINE — you can mix targeted and non-' +
        'targeted lines in one call. Saves the model from chaining N ' +
        'separate evaluate_target_price calls. Typical Senegal/Lagos/' +
        'Mombasa pattern: EN590 + gasoline + jet + kerosene to West/' +
        'East Africa.',
      kind: 'read',
      schema: z.object({
        lines: z
          .array(
            z.object({
              product: z.enum([
                'en590-ulsd',
                'gasoline-super',
                'jet-a1',
                'kerosene',
                'gasoil-0.5pct',
                'hsfo',
                'crude-light-sweet',
                'crude-medium-sour',
              ]),
              volumeMt: z.number().positive().optional(),
              targetCifUsdPerMt: z.number().positive().optional(),
              targetCifUsdPerBbl: z.number().positive().optional(),
              destPortSlug: z.string(),
            }),
          )
          .min(1)
          .max(20)
          .describe(
            'Array of RFQ lines, 1-20 entries. Each line needs product + ' +
              'destPortSlug; volume + target prices are optional.',
          ),
        originRegion: z
          .enum([
            'med',
            'nwe',
            'usgc',
            'singapore',
            'mideast',
            'india',
            'west-africa',
            'east-africa',
            'black-sea',
          ])
          .optional()
          .describe(
            'Most likely sourcing region for all lines. If omitted, the ' +
              'cheapest matching route per line is used.',
          ),
      }),
      handler: async (ctx, input) =>
        withToolTelemetry(
          {
            ctx,
            toolName: 'evaluate_multi_product_rfq',
            args: input,
            summarize: (out: {
              worstVerdict: string;
              flaggedLineCount: number;
              lines: Array<unknown>;
            }) => ({
              resultCount: out.lines.length,
              resultSummary: {
                worstVerdict: out.worstVerdict,
                flaggedLineCount: out.flaggedLineCount,
                lineCount: input.lines.length,
              },
            }),
          },
          async () =>
            evaluateMultiProductRfq({
              lines: input.lines.map((l) => ({
                product: l.product as ProductSlug,
                volumeMt: l.volumeMt,
                targetCifUsdPerMt: l.targetCifUsdPerMt,
                targetCifUsdPerBbl: l.targetCifUsdPerBbl,
                destPortSlug: l.destPortSlug,
              })),
              originRegion: input.originRegion as FreightOriginRegion | undefined,
            }),
        ),
    }),

    compose_deal_economics: defineTool({
      name: 'compose_deal_economics',
      description:
        'Run the fuel-deal calculator on a candidate deal. Use whenever the ' +
        'user asks "is this a good deal", "what\'s our margin", "build me ' +
        'a deal at X $/USG", "model an Azeri Light cargo at $76 net CIF", ' +
        '"what does the P&L look like at $3.10 sell / $2.05 cost". Returns ' +
        'per-USG margin, gross/net profit, scorecard recommendation ' +
        '(strong | acceptable | marginal | do_not_proceed), warnings ' +
        '(severity-graded), breakevens (max product cost, max freight, min ' +
        'sell price), peak cash exposure, and a 9-step freight-rate ' +
        'sensitivity grid. The chat surface renders this with adjustable ' +
        'sliders so the user can probe different assumptions without ' +
        'another tool call.\n\n' +
        'REQUIRED: product, exactly one of (volumeUsg | volumeBbls | volumeMt), ' +
        'and exactly one of (sellPricePerUsg | sellPricePerBbl). If any are ' +
        'missing the tool returns ALL missing fields in one error — do not ' +
        'retry one field at a time.\n\n' +
        'productCost is auto-pulled when omitted. The cost model depends on ' +
        '`sourcingRegion`: USGC (or omitted) uses NYH spot — appropriate for ' +
        'Houston-origin cargoes. Any other origin (med, mideast, india, ' +
        'singapore, …) uses Brent + typical crack spread — appropriate for ' +
        'cargoes lifted from those refineries, since NYH spot can overstate ' +
        'cost by $15-25/bbl and produce false do_not_proceed verdicts. For ' +
        'products without a Brent+crack mapping (lng, lpg, biodiesel) or a ' +
        'spot feed (avgas), supply productCostPerUsg or productCostPerBbl ' +
        'explicitly — otherwise the tool errors.\n\n' +
        'CRITICAL: if your sell price is below the auto-pulled cost the ' +
        'result will include a top-level `topLevelWarning` and the scorecard ' +
        'will be do_not_proceed. LEAD with that warning in your response — ' +
        'do not present the line as part of "the plan." Before treating the ' +
        'verdict as final, double-check that `sourcingRegion` matches where ' +
        'the cargo is actually being lifted from; an unset region defaults ' +
        'to NYH which biases cost high for non-USGC sourcing.',
      kind: 'read',
      schema: z.object({
        product: z
          .enum([
            'ulsd',
            'gasoline_87',
            'gasoline_91',
            'jet_a',
            'jet_a1',
            'kerosene',
            'avgas',
            'lfo',
            'hfo',
            'lng',
            'lpg',
            'biodiesel_b20',
          ])
          .describe(
            "Product code. Use 'kerosene' for kerosene specifically (NOT 'lfo' " +
              "which is light fuel oil — different product). For crude grades " +
              "(Azeri Light, Brent, etc.) use 'lfo' for light-sweet (~0.85 kg/L) " +
              "or 'hfo' for heavier sour. The choice drives density default + " +
              "benchmark lookup; cost-stack semantics are the same.",
          ),
        volumeUsg: z
          .number()
          .positive()
          .optional()
          .describe(
            'Deal volume in US gallons. Provide one of volumeUsg / volumeBbls / volumeMt.',
          ),
        volumeBbls: z
          .number()
          .positive()
          .optional()
          .describe('Deal volume in barrels (1 bbl = 42 USG). Use for crude / bunker.'),
        volumeMt: z
          .number()
          .positive()
          .optional()
          .describe(
            'Deal volume in metric tonnes — useful for buyer RFQs that quote in ' +
              'MT (e.g. "200,000 MT EN590"). Internally converted to USG via the ' +
              "product's density.",
          ),
        sellPricePerUsg: z
          .number()
          .positive()
          .optional()
          .describe('Sell price to buyer in USD per US gallon.'),
        sellPricePerBbl: z
          .number()
          .positive()
          .optional()
          .describe('Sell price in USD per barrel. Use for crude / bunker.'),
        productCostPerUsg: z
          .number()
          .positive()
          .optional()
          .describe(
            'Acquisition cost in USD/USG. Omit to auto-pull from the cost ' +
              'model selected by sourcingRegion (NYH spot for usgc, Brent+crack ' +
              'for any other origin).',
          ),
        productCostPerBbl: z
          .number()
          .positive()
          .optional()
          .describe('Acquisition cost in USD/bbl.'),
        sourcingRegion: z
          .enum([
            'med',
            'nwe',
            'usgc',
            'singapore',
            'mideast',
            'india',
            'west-africa',
            'east-africa',
            'black-sea',
          ])
          .optional()
          .describe(
            'Where the cargo is being lifted from. Drives the productCost ' +
              'fallback when productCostPer* is omitted: usgc → NYH spot ' +
              'benchmark; any other region → Brent + typical crack spread (the ' +
              'cost model used by evaluate_target_price). Omit only when the ' +
              'cargo is genuinely USGC-origin or when you are providing an ' +
              'explicit productCost. Defaulting to omitted for non-USGC sourcing ' +
              'biases cost high and can flag viable deals as do_not_proceed.',
          ),
        freightPerUsg: z
          .number()
          .nonnegative()
          .optional()
          .describe('Freight cost in USD/USG. Default 0.'),
        freightRateUsdPerMt: z
          .number()
          .positive()
          .optional()
          .describe(
            'Freight rate in USD per metric tonne. If set, overrides freightPerUsg.',
          ),
        densityKgL: z
          .number()
          .positive()
          .optional()
          .describe(
            'Product density in kg/L. Defaulted by product if omitted: ULSD 0.84, ' +
              'gasoline 0.74–0.745, jet 0.81, light crude / LFO 0.86, HFO 0.96.',
          ),
        incoterm: z
          .enum(['fob', 'cif', 'cfr', 'dap', 'exw', 'fas'])
          .optional()
          .describe('Default cfr.'),
        demurrageDays: z.number().nonnegative().optional(),
        demurrageRatePerDay: z
          .number()
          .positive()
          .optional()
          .describe('USD/day. Provide alongside demurrageDays for the demurrage warning.'),
        dischargeHandlingPerUsg: z.number().nonnegative().optional(),
        compliancePerUsg: z.number().nonnegative().optional(),
        tradeFinancePerUsg: z.number().nonnegative().optional(),
        intermediaryFeePerUsg: z.number().nonnegative().optional(),
        vtcVariableOpsPerUsg: z.number().nonnegative().optional(),
        counterpartyRiskScore: z
          .number()
          .min(0)
          .max(100)
          .optional()
          .describe('0–100. Default 50.'),
        countryRiskScore: z
          .number()
          .min(0)
          .max(100)
          .optional()
          .describe('0–100. Default 50.'),
        monthlyFixedOverheadUsd: z.number().nonnegative().optional(),
        asOf: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe('YYYY-MM-DD. Used for benchmark lookup. Default today.'),
        dealRef: z
          .string()
          .max(80)
          .optional()
          .describe('Free-form deal label that flows into the result.'),
      }),
      handler: async (ctx, input) =>
        withToolTelemetry(
          {
            ctx,
            toolName: 'compose_deal_economics',
            args: input,
            summarize: (out: { results: { scorecard: { recommendation: string } } }) => ({
              resultCount: 1,
              resultSummary: { recommendation: out.results.scorecard.recommendation },
            }),
          },
          async () => {
            // Resolve per-company trading defaults (default sourcing
            // region, target margin floors, monthly overhead) once
            // and pass into the calculator. The per-call input still
            // wins so the user can override on a deal-by-deal basis.
            const row = await getCompanyDealDefaults(ctx.companyId);
            const defaults: CompanyDealDefaults = row
              ? {
                  defaultSourcingRegion:
                    isFreightOriginRegion(row.defaultSourcingRegion)
                      ? row.defaultSourcingRegion
                      : null,
                  targetGrossMarginPct: row.targetGrossMarginPct,
                  targetNetMarginPerUsg: row.targetNetMarginPerUsg,
                  monthlyFixedOverheadUsdDefault:
                    row.monthlyFixedOverheadUsdDefault,
                }
              : {};
            return composeDealEconomics(input, defaults);
          },
        ),
    }),

    find_distressed_suppliers: defineTool({
      name: 'find_distressed_suppliers',
      description:
        'Find suppliers showing distress signals — sharp drops in award ' +
        'velocity (last 90d vs prior 90d), plus any associated public news ' +
        'events (bankruptcy filings, leadership changes, force-majeure ' +
        "press, sanctions actions). Use when the user asks \"who's slowing " +
        'down", "who has open inventory", "who needs to deal", or any ' +
        'origination-side question about counterparty motivation. Returns ' +
        'velocityChangePct (negative = distress), recent news events ' +
        '(empty until ingest workers ship; entity_news_events table exists ' +
        'as of 0048), and a plain-text reasons array. Filter by ' +
        'categoryTag, countries (ISO-2 array), or velocityChangeMax (e.g. ' +
        '-0.7 for "down 70%+"). minPrevAwards (default 3) filters out ' +
        'suppliers who never won much — drops from 1 to 0 are noise. ' +
        'Surface this alongside find_buyers_for_offer when composing a ' +
        'back-to-back deal: a distressed supplier paired with an aligned ' +
        "buyer is the highest-leverage origination move you can make.",
      kind: 'read',
      schema: z.object({
        categoryTag: z
          .string()
          .optional()
          .describe(
            "Category tag — 'crude-oil', 'diesel', 'gasoline', 'jet-fuel', " +
              "'lpg', 'marine-bunker', 'food-commodities', 'vehicles', " +
              "'petroleum-fuels'. Filters to suppliers with at least one " +
              'award in this category.',
          ),
        countries: z
          .array(z.string().length(2))
          .optional()
          .describe('ISO-2 country list. Empty = all.'),
        minPrevAwards: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('Minimum prior-period award count. Default 3.'),
        velocityChangeMax: z
          .number()
          .min(-1)
          .max(0)
          .optional()
          .describe(
            'Velocity drop threshold. -0.5 = "dropped 50%+". Default -0.5. ' +
              'Use -0.7 to surface only the sharpest declines.',
          ),
        includeNewsEvents: z
          .boolean()
          .optional()
          .describe('Default true. Set false to skip the news-event JOIN.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Default 25.'),
      }),
      handler: async (ctx, input) =>
        withToolTelemetry(
          {
            ctx,
            toolName: 'find_distressed_suppliers',
            args: input,
            summarize: (out: Array<unknown>) => ({
              resultCount: out.length,
              resultSummary: input,
            }),
          },
          async () => findDistressedSuppliers(input),
        ),
    }),

    find_recent_similar_awards: defineTool({
      name: 'find_recent_similar_awards',
      description:
        'Recent past awards filtered to (buyerCountry × categoryTag). Use as a bid-' +
        'amount anchor when composing a deal package or evaluating an offer — "the ' +
        "last 5 DR diesel awards averaged $X across these suppliers\". Returns " +
        'award_date, buyer, supplier, title, commodity_description, and ' +
        'contract_value_usd. Order is recency-then-value.',
      kind: 'read',
      schema: z.object({
        buyerCountry: z
          .string()
          .length(2)
          .optional()
          .describe('ISO-2 country code. Omit to scan globally.'),
        categoryTag: z
          .string()
          .optional()
          .describe(
            "Internal category tag — 'diesel', 'gasoline', 'crude-oil', etc. Omit to scan all categories.",
          ),
        daysBack: z.number().int().min(7).max(1825).optional()
          .describe('Lookback window in days. Default 365.'),
        limit: z.number().int().min(1).max(50).optional()
          .describe('Max rows. Default 10.'),
      }),
      handler: async (ctx, input) =>
        withToolTelemetry(
          {
            ctx,
            toolName: 'find_recent_similar_awards',
            args: input,
            summarize: (out: Array<unknown>) => ({
              resultCount: out.length,
              resultSummary: {
                buyerCountry: input.buyerCountry,
                categoryTag: input.categoryTag,
              },
            }),
          },
          async () => findRecentSimilarAwards(input),
        ),
    }),

    find_recent_port_calls: defineTool({
      name: 'find_recent_port_calls',
      description:
        "Vessel intelligence: find tankers seen at a port (or set of ports) in the last N " +
        "days. Inferred from AIS positions — a 'call' is any cluster of slow-moving (<2 " +
        "kn) tanker positions inside a port's geofence. Use whenever the user asks 'who " +
        "loaded at Es Sider this month', 'which tankers visited Sannazzaro', or 'is X " +
        "refinery actively receiving cargoes today'. Filter by portSlug (single port), " +
        "country (all ports in a country), or portType ('crude-loading' | 'refinery' | " +
        "'transshipment' | 'mixed'). Returns vessels with name, MMSI, flag, ship type, " +
        "arrival/last-seen timestamps, and a positionCount confidence proxy. Pair with " +
        "lookup_known_entities to map refinery calls back to the buyer entity. If the " +
        "result set is empty, the AISStream worker may not have run recently — say so " +
        "rather than concluding no traffic.",
      kind: 'read',
      schema: z.object({
        portSlug: z
          .string()
          .optional()
          .describe(
            "ports.slug — e.g. 'es-sider', 'sannazzaro-refinery', 'paradip-port'.",
          ),
        country: z
          .string()
          .length(2)
          .optional()
          .describe('ISO-2 country code — restricts to ports in that country.'),
        portType: z
          .enum(['crude-loading', 'refinery', 'transshipment', 'mixed'])
          .optional()
          .describe(
            "Restrict to one port category. 'crude-loading' for export-side " +
              "(\"who loaded crude in Libya\"); 'refinery' for buy-side (\"who's " +
              'discharging at refineries").',
          ),
        daysBack: z
          .number()
          .int()
          .min(1)
          .max(365)
          .optional()
          .describe('Lookback in days. Default 30.'),
        limit: z.number().int().min(1).max(200).optional(),
      }),
      handler: async (ctx, input) =>
        withToolTelemetry(
          {
            ctx,
            toolName: 'find_recent_port_calls',
            args: input,
            summarize: (out: { count: number }) => ({
              resultCount: out.count,
              resultSummary: {
                portSlug: input.portSlug,
                country: input.country,
                portType: input.portType,
              },
            }),
          },
          async () => {
            const rows = await findRecentPortCalls({
              portSlug: input.portSlug,
              country: input.country,
              portType: input.portType,
              daysBack: input.daysBack ?? 30,
              limit: input.limit,
            });
            return { count: rows.length, calls: rows };
          },
        ),
    }),

    analyze_supplier_pricing: defineTool({
      name: 'analyze_supplier_pricing',
      description:
        'Per-supplier pricing pattern vs. benchmark, derived from the award_price_deltas ' +
        'materialized view. Answers "does this supplier price high or low" / "is their ' +
        'pricing consistent". Returns the supplier\'s award count, average + median delta ' +
        'over benchmark in $/bbl, standard deviation, and 5 most-recent samples for ' +
        'narrative grounding. Confidence ≥0.6 by default. If awardCount is 0, the ' +
        'supplier has no awards we could price against — say so explicitly rather than ' +
        'fabricating a profile.',
      kind: 'read',
      schema: z.object({
        supplierId: z
          .string()
          .uuid()
          .describe('external_suppliers.id — get this from analyze_supplier or find_buyers_for_offer.'),
        minConfidence: z.number().min(0).max(1).optional()
          .describe('Minimum overall_confidence threshold. Default 0.6.'),
        daysBack: z.number().int().min(30).max(3650).optional()
          .describe('Lookback window in days. Default 1095 (~3y).'),
      }),
      handler: async (ctx, input) =>
        withToolTelemetry(
          {
            ctx,
            toolName: 'analyze_supplier_pricing',
            args: input,
            summarize: (out: { awardCount: number }) => ({
              resultCount: out.awardCount,
              resultSummary: { supplierId: input.supplierId },
            }),
          },
          async () =>
            analyzeSupplierPricing({
              supplierId: input.supplierId,
              minConfidence: input.minConfidence,
              daysBack: input.daysBack,
            }),
        ),
    }),

    analyze_buyer_pricing: defineTool({
      name: 'analyze_buyer_pricing',
      description:
        'Per-(country × category) pricing distribution — the empirical premium a buyer ' +
        'pool pays over the relevant benchmark. Answers "what does the Caribbean diesel ' +
        'premium over NY Harbor look like" / "what does Italy typically pay over Brent". ' +
        'Returns p25/median/p75 + average delta in $/bbl. The (p25, p75) pair is the ' +
        'empirical pricing band — anything inside it is "normal market", outside is ' +
        'flagged. Use this before evaluate_offer_against_history to anchor the user on ' +
        'what historical pricing looks like.',
      kind: 'read',
      schema: z.object({
        buyerCountry: z.string().length(2).describe('ISO-2 country code.'),
        categoryTag: z.string().describe(
          "Internal category tag — 'diesel', 'gasoline', 'jet-fuel', 'heating-oil', 'crude-oil', etc.",
        ),
        minConfidence: z.number().min(0).max(1).optional(),
        daysBack: z.number().int().min(30).max(3650).optional(),
      }),
      handler: async (ctx, input) =>
        withToolTelemetry(
          {
            ctx,
            toolName: 'analyze_buyer_pricing',
            args: input,
            summarize: (out: { awardCount: number }) => ({
              resultCount: out.awardCount,
              resultSummary: { buyerCountry: input.buyerCountry, categoryTag: input.categoryTag },
            }),
          },
          async () =>
            analyzeBuyerPricing({
              buyerCountry: input.buyerCountry,
              categoryTag: input.categoryTag,
              minConfidence: input.minConfidence,
              daysBack: input.daysBack,
            }),
        ),
    }),

    evaluate_offer_against_history: defineTool({
      name: 'evaluate_offer_against_history',
      description:
        '"Is this offer competitive?" — given a buyer + category + offer price ($/bbl), ' +
        'score it against the empirical historical distribution. Returns the current ' +
        'benchmark spot, the expected price the buyer\'s history predicts, the actual ' +
        'offer\'s delta, a z-score (using IQR-derived sigma), and a verdict: ' +
        '\'inside-band\' | \'above-band\' | \'below-band\' | \'no-history\' | ' +
        '\'no-benchmark\'. \'no-history\' = the buyer pool has no priced awards in the ' +
        'window; \'no-benchmark\' = no commodity_prices ingested for the category. ' +
        'Always quote the verdict + the dollar amounts, not just z-score.',
      kind: 'read',
      schema: z.object({
        buyerCountry: z.string().length(2),
        categoryTag: z.string(),
        offerPriceUsdPerBbl: z.number().positive().describe(
          'Offer price in USD per barrel. Convert from $/gal × 42 or $/MT ÷ category-SG before passing.',
        ),
        minConfidence: z.number().min(0).max(1).optional(),
        daysBack: z.number().int().min(30).max(3650).optional(),
      }),
      handler: async (ctx, input) =>
        withToolTelemetry(
          {
            ctx,
            toolName: 'evaluate_offer_against_history',
            args: input,
            summarize: (out: { verdict: string }) => ({
              resultCount: 1,
              resultSummary: {
                buyerCountry: input.buyerCountry,
                categoryTag: input.categoryTag,
                verdict: out.verdict,
              },
            }),
          },
          async () =>
            evaluateOfferAgainstHistory({
              buyerCountry: input.buyerCountry,
              categoryTag: input.categoryTag,
              offerPriceUsdPerBbl: input.offerPriceUsdPerBbl,
              minConfidence: input.minConfidence,
              daysBack: input.daysBack,
            }),
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
              profileUrl: buildEntityProfileUrl({ kind: 'supplier', id: c.supplierId }),
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
            profileUrl: buildEntityProfileUrl({ kind: 'supplier', id: result.supplier.id }),
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
