import 'server-only';
import { z } from 'zod';
import { defineTool } from '@procur/ai';
import { db, companies } from '@procur/db';
import { eq } from 'drizzle-orm';
import { getRecommendedOpportunities } from '../../recommended-queries';

const input = z.object({
  limit: z.number().optional(),
});

export const listRecommendedOpportunitiesTool = defineTool({
  name: 'list_recommended_opportunities',
  description:
    "Return active opportunities matched to the company's declared capabilities, preferred categories, and preferred jurisdictions, excluding those already pursued or saved. Use this when the user asks 'what should I bid on' or 'show me good matches'. Returns title, agency, jurisdiction, deadline, value, and match reasons.",
  kind: 'read',
  schema: input,
  handler: async (ctx, args) => {
    const company = await db.query.companies.findFirst({
      where: eq(companies.id, ctx.companyId),
    });
    if (!company) return { error: 'company_not_found' };
    const limit = Math.min(args.limit ?? 6, 20);
    const rows = await getRecommendedOpportunities(company, ctx.userId, limit);
    return {
      count: rows.length,
      opportunities: rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        title: r.title,
        agency: r.agencyName,
        jurisdiction: r.jurisdictionName,
        category: r.category,
        valueEstimate: r.valueEstimate,
        valueEstimateUsd: r.valueEstimateUsd,
        currency: r.currency,
        deadlineAt: r.deadlineAt?.toISOString() ?? null,
        aiSummary: r.aiSummary?.slice(0, 280) ?? null,
        matchReasons: r.matchReasons,
      })),
    };
  },
});
