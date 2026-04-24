import 'server-only';
import { z } from 'zod';
import { defineTool } from '@procur/ai';
import { listCompanyPursuits } from '../../capture-queries';

const STAGES = [
  'identification',
  'qualification',
  'capture_planning',
  'proposal_development',
  'submitted',
  'awarded',
  'lost',
] as const;

const input = z.object({
  stage: z.enum(STAGES).optional(),
  limit: z.number().optional(),
  overdueOnly: z.boolean().optional(),
});

/**
 * Flat list of pursuits. Output is trimmed vs PursuitCard to keep the
 * model context small — enough for disambiguation and ranking.
 */
export const listPursuitsTool = defineTool({
  name: 'list_pursuits',
  description:
    "List the company's pursuits. Optional filters: stage (one of identification, qualification, capture_planning, proposal_development, submitted, awarded, lost), overdue_only (deadline in the past), limit (default 25). Returns id, title, stage, agency, jurisdiction, deadline, p_win, value_estimate_usd, and task counts.",
  kind: 'read',
  schema: input,
  handler: async (ctx, args) => {
    const limit = args.limit ?? 25;
    const all = await listCompanyPursuits(ctx.companyId);
    const now = new Date();

    const filtered = all.filter((p) => {
      if (args.stage && p.stage !== args.stage) return false;
      if (args.overdueOnly) {
        if (!p.opportunity.deadlineAt) return false;
        if (p.opportunity.deadlineAt >= now) return false;
      }
      return true;
    });

    return {
      totalMatching: filtered.length,
      pursuits: filtered.slice(0, limit).map((p) => ({
        id: p.id,
        title: p.opportunity.title,
        stage: p.stage,
        agency: p.opportunity.agencyName,
        jurisdiction: p.opportunity.jurisdictionName,
        deadlineAt: p.opportunity.deadlineAt?.toISOString() ?? null,
        pWin: p.pWin,
        valueEstimateUsd: p.opportunity.valueEstimateUsd,
        currency: p.opportunity.currency,
        assignedUser: p.assignedUserName,
        tasks: p.tasks,
      })),
    };
  },
});
