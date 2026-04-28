import 'server-only';
import { defineTool, type ToolRegistry } from '@procur/ai';
import { z } from 'zod';
import {
  briefOpportunity,
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

const DISCOVER_BASE = 'https://discover.procur.app';

/**
 * Build a Discover catalog URL with the given filters pre-applied.
 * Mirrors the URL params accepted by /opportunities/page.tsx so a
 * user clicking the link lands on the same view they'd build by
 * clicking through the sidebar manually.
 *
 * Empty / nullish filters are omitted (cleaner URLs, no `?q=&jurisdiction=`).
 */
/**
 * Human-readable summary of which filters got applied — gives the
 * model something to verbalize alongside the URL ("Applied: Jamaica
 * + Petroleum and Fuels"). Empty when no filters are set.
 */
function describeFilters(input: {
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

function buildFilterUrl(filters: {
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
 * Discover-side tool registry for the AI assistant.
 *
 * Surface: the public opportunity catalog. None of these tools touch
 * company-scoped data — the assistant on Discover helps users *find*
 * opportunities, not manage their pursuits. Authenticated user context
 * is verified upstream via the handshake token before the agent loop
 * runs; once inside a tool handler we don't need company-scoped queries.
 *
 * Tools mirror the catalog's faceted-browse model (jurisdiction /
 * category / beneficiary country / keyword) so the assistant can
 * compose the same filter combinations a user would build manually
 * via the sidebar.
 */
export function buildDiscoverTools(): ToolRegistry {
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

    build_filter_url: defineTool({
      name: 'build_filter_url',
      description:
        'Build a Discover catalog URL with the given filters pre-applied. Use this when the user wants to BROWSE rather than read a list — phrases like "take me to", "open", "filter to", "narrow to", "show the catalog filtered to". The returned URL lands the user on the Discover sidebar view with the same filters checked. Prefer this over search_opportunities when the user clearly wants to explore the catalog UI rather than have the assistant summarize results in chat.',
      kind: 'read',
      schema: z.object({
        query: z.string().optional().describe('Free-text search keyword'),
        jurisdiction: z
          .string()
          .optional()
          .describe('Jurisdiction slug (e.g. "us-federal", "canada-federal", "eu-ted", "uk-fts", "un")'),
        category: z
          .string()
          .optional()
          .describe(
            '"food-commodities", "petroleum-fuels", "vehicles-fleet", "minerals-metals", or other taxonomy slug',
          ),
        country: z.string().optional().describe('Beneficiary country name (e.g. "Jamaica", "Haiti", "Germany")'),
        scope: z.enum(['open', 'past']).optional().describe('"open" (default) or "past" awards'),
      }),
      handler: async (_ctx, input) => {
        const url = buildFilterUrl({
          query: input.query,
          jurisdiction: input.jurisdiction,
          category: input.category,
          country: input.country,
          scope: input.scope,
        });
        const description = describeFilters(input);
        return { url, description };
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
  };
}
