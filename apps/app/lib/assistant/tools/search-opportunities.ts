import 'server-only';
import { z } from 'zod';
import { defineTool } from '@procur/ai';
import { and, asc, desc, eq, gt, ilike, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { agencies, db, jurisdictions, opportunities } from '@procur/db';

const input = z.object({
  query: z.string().optional(),
  jurisdictionSlugs: z.array(z.string()).optional(),
  categories: z.array(z.string()).optional(),
  minValueUsd: z.number().optional(),
  maxValueUsd: z.number().optional(),
  deadlineBefore: z.string().optional(),
  deadlineAfter: z.string().optional(),
  sort: z.enum(['deadline_asc', 'deadline_desc', 'value_desc', 'recent']).optional(),
  limit: z.number().optional(),
});

/**
 * Common Spanish/English stop-words that hurt keyword matching when
 * present in a multi-word `query` ("any supply opportunities for fuel"
 * → ["supply", "fuel"]).
 */
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has',
  'have', 'in', 'is', 'it', 'me', 'my', 'of', 'on', 'or', 'show', 'that', 'the',
  'this', 'to', 'us', 'we', 'with', 'opportunity', 'opportunities', 'tender',
  'tenders',
  // es
  'el', 'la', 'los', 'las', 'de', 'del', 'en', 'por', 'para', 'con', 'una',
  'uno', 'que', 'es', 'su',
]);

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
}

/**
 * Cross-market opportunity search. Public scope — returns active
 * opportunities (deadline still in the future) regardless of whether
 * the company has a pursuit for them. Filters by keyword (token-AND
 * across title/description/reference/aiSummary), jurisdiction,
 * category, value range, deadline window. Defaults to top 20 most recent.
 */
export const searchOpportunitiesTool = defineTool({
  name: 'search_opportunities',
  description:
    "Search active government tender opportunities across all jurisdictions Procur scrapes. The `query` is tokenized and EVERY non-stopword token must appear somewhere in title/description/reference/AI summary (case-insensitive substring) — so 'fuel supply' matches both 'Supply of fuel' and 'Diesel fuel for the supply chain'. Pass broad single-domain words rather than long phrases (good: 'fuel'; better when needed: 'fuel diesel petroleum'). Filters: query (keyword), jurisdictionSlugs (e.g. ['jamaica', 'guyana']), categories, minValueUsd, maxValueUsd, deadlineBefore/deadlineAfter (ISO date), sort (deadline_asc|deadline_desc|value_desc|recent, default recent), limit (default 20). Use this for 'find me tenders about X' questions. RENDERING: when listing opportunities back to the user, ALWAYS format each title as a markdown link to its `detailUrl` — e.g. `[Supply of asphalt](https://discover.procur.app/opportunities/jm-2026-...)`. This makes rows clickable in the chat. Inside markdown tables, put the link in the title cell.",
  kind: 'read',
  schema: input,
  handler: async (_ctx, args) => {
    const conds = [
      eq(opportunities.status, 'active'),
      // Match the discover listing: only return tenders whose deadline
      // is still in the future (or unknown). Without this we surface
      // 2-year-old "active" rows that nobody can bid on.
      or(gt(opportunities.deadlineAt, sql`now()`), isNull(opportunities.deadlineAt))!,
    ];

    if (args.query) {
      const tokens = tokenize(args.query);
      // Each token must appear somewhere in any of the 4 text columns —
      // expressed as AND-of-OR-of-ilikes. Substring (ilike '%token%') so
      // we still match "petroleum" inside "petroleum-based" etc.
      for (const token of tokens) {
        const like = `%${token}%`;
        const clause = or(
          ilike(opportunities.title, like),
          ilike(opportunities.description, like),
          ilike(opportunities.referenceNumber, like),
          ilike(opportunities.aiSummary, like),
        );
        if (clause) conds.push(clause);
      }
      // If the query had no usable tokens (all stop-words), fall back
      // to the original substring match so we don't silently broaden
      // to "everything".
      if (tokens.length === 0) {
        const like = `%${args.query}%`;
        const clause = or(
          ilike(opportunities.title, like),
          ilike(opportunities.description, like),
          ilike(opportunities.referenceNumber, like),
          ilike(opportunities.aiSummary, like),
        );
        if (clause) conds.push(clause);
      }
    }
    if (args.jurisdictionSlugs && args.jurisdictionSlugs.length > 0) {
      conds.push(inArray(jurisdictions.slug, args.jurisdictionSlugs));
    }
    if (args.categories && args.categories.length > 0) {
      conds.push(inArray(opportunities.category, args.categories));
    }
    if (args.minValueUsd !== undefined) {
      conds.push(sql`${opportunities.valueEstimateUsd}::numeric >= ${args.minValueUsd}`);
    }
    if (args.maxValueUsd !== undefined) {
      conds.push(sql`${opportunities.valueEstimateUsd}::numeric <= ${args.maxValueUsd}`);
    }
    if (args.deadlineBefore) {
      conds.push(lt(opportunities.deadlineAt, new Date(args.deadlineBefore)));
    }
    if (args.deadlineAfter) {
      conds.push(gt(opportunities.deadlineAt, new Date(args.deadlineAfter)));
    }

    const sort = args.sort ?? 'recent';
    const orderBy =
      sort === 'deadline_asc'
        ? asc(opportunities.deadlineAt)
        : sort === 'deadline_desc'
          ? desc(opportunities.deadlineAt)
          : sort === 'value_desc'
            ? desc(sql`${opportunities.valueEstimateUsd}::numeric`)
            : desc(opportunities.publishedAt);

    const limit = Math.min(args.limit ?? 20, 50);

    const discoverBase = process.env.NEXT_PUBLIC_DISCOVER_URL ?? 'https://discover.procur.app';

    const rows = await db
      .select({
        id: opportunities.id,
        slug: opportunities.slug,
        title: opportunities.title,
        referenceNumber: opportunities.referenceNumber,
        category: opportunities.category,
        jurisdictionSlug: jurisdictions.slug,
        jurisdictionName: jurisdictions.name,
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
      .orderBy(orderBy)
      .limit(limit);

    return {
      count: rows.length,
      opportunities: rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        title: r.title,
        // Absolute URL to the Discover detail page. The chat client
        // renders markdown, so the model can wrap titles as
        // [Title](detailUrl) to make rows clickable. Falls back to the
        // listing for legacy rows that lost their slug.
        detailUrl: r.slug
          ? `${discoverBase}/opportunities/${r.slug}`
          : `${discoverBase}/opportunities`,
        referenceNumber: r.referenceNumber,
        category: r.category,
        jurisdictionSlug: r.jurisdictionSlug,
        jurisdiction: r.jurisdictionName,
        agency: r.agencyName,
        valueEstimate: r.valueEstimate,
        valueEstimateUsd: r.valueEstimateUsd,
        currency: r.currency,
        deadlineAt: r.deadlineAt?.toISOString() ?? null,
        publishedAt: r.publishedAt?.toISOString() ?? null,
        aiSummary: r.aiSummary?.slice(0, 280) ?? null,
      })),
    };
  },
});
