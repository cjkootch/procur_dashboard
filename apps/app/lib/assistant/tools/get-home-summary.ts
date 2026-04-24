import 'server-only';
import { z } from 'zod';
import { defineTool } from '@procur/ai';
import { getHomeData } from '../../home-queries';

const input = z.object({});

/**
 * High-signal snapshot: counts, upcoming deadlines, drafting proposals
 * with compliance gaps, upcoming obligations, recent wins. Mirrors the
 * data backing the home dashboard.
 */
export const getHomeSummaryTool = defineTool({
  name: 'get_home_summary',
  description:
    "Return a summary of the user's pipeline: pursuit counts by state, upcoming pursuit deadlines (next 30 days), proposals in progress with compliance gaps, upcoming contract obligations (next 30 days), and recent wins (last 90 days). Use this when the user asks about their overall state, what's due, or recent activity.",
  kind: 'read',
  schema: input,
  handler: async (ctx) => {
    const data = await getHomeData(ctx.companyId);
    return {
      counts: {
        totalPursuits: data.totalPursuits,
        openPursuits: data.openPursuits,
        activeContracts: data.activeContracts,
        submittedProposals: data.submittedProposals,
      },
      upcomingDeadlines: data.upcomingDeadlines.map((d) => ({
        pursuitId: d.pursuitId,
        title: d.opportunityTitle,
        agency: d.agencyName,
        jurisdiction: d.jurisdictionName,
        deadlineAt: d.deadlineAt.toISOString(),
        stage: d.stage,
        pWin: d.pWin,
      })),
      draftingProposals: data.draftingProposals.map((p) => ({
        pursuitId: p.pursuitId,
        title: p.opportunityTitle,
        deadlineAt: p.deadlineAt?.toISOString() ?? null,
        status: p.status,
        unaddressedRequirements: p.unaddressedRequirements,
        totalRequirements: p.totalRequirements,
      })),
      upcomingObligations: data.upcomingObligations,
      recentWins: data.recentWins.map((w) => ({
        pursuitId: w.pursuitId,
        title: w.opportunityTitle,
        agency: w.agencyName,
        jurisdiction: w.jurisdictionName,
        awardedValueUsd: w.awardedValueUsd,
        updatedAt: w.updatedAt.toISOString(),
      })),
    };
  },
});
