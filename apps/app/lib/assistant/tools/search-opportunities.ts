import 'server-only';
import { z } from 'zod';
import { defineTool } from '@procur/ai';
import { and, asc, desc, eq, gt, ilike, inArray, lt, or, sql } from 'drizzle-orm';
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
 * Cross-market opportunity search. Public scope — returns active
 * opportunities regardless of whether the company has a pursuit for them.
 * Filters by keyword (ilike over title/description/reference), jurisdiction,
 * category, value range, deadline window. Defaults to top 20 most recent.
 */
export const searchOpportunitiesTool = defineTool({
  name: 'search_opportunities',
  description:
    "Search active government tender opportunities across all jurisdictions Procur scrapes. Filters: query (keyword), jurisdictionSlugs (e.g. ['jamaica', 'guyana']), categories, minValueUsd, maxValueUsd, deadlineBefore/deadlineAfter (ISO date), sort (deadline_asc|deadline_desc|value_desc|recent, default recent), limit (default 20). Use this for 'find me tenders about X' questions.",
  kind: 'read',
  schema: input,
  handler: async (_ctx, args) => {
    const conds = [eq(opportunities.status, 'active')];

    if (args.query) {
      const like = `%${args.query}%`;
      const clause = or(
        ilike(opportunities.title, like),
        ilike(opportunities.description, like),
        ilike(opportunities.referenceNumber, like),
        ilike(opportunities.aiSummary, like),
      );
      if (clause) conds.push(clause);
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
