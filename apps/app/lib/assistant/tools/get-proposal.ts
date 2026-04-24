import 'server-only';
import { z } from 'zod';
import { defineTool } from '@procur/ai';
import { getProposalByPursuitId } from '../../proposal-queries';

const input = z.object({
  pursuitId: z.string(),
});

type OutlineEntry = {
  id: string;
  number: string;
  title: string;
  description?: string;
  pageLimit?: number;
};

type SectionEntry = {
  id: string;
  outlineId?: string;
  title: string;
  status: string;
  wordCount?: number;
};

type ComplianceEntry = {
  requirementId?: string;
  requirementText: string;
  status: string;
  addressedInSection?: string;
};

/**
 * Compact summary of a proposal. We trim full section bodies so the model
 * sees the structure + status, not 20k tokens of prose. If the caller
 * needs a specific section's content, add a follow-up tool later.
 */
export const getProposalTool = defineTool({
  name: 'get_proposal',
  description:
    "Return the proposal for a pursuit: outline entries, section statuses and word counts, and a compliance summary (addressed vs unaddressed requirements). Section bodies are excluded to keep responses compact. Only returns proposals owned by the current company.",
  kind: 'read',
  schema: input,
  handler: async (ctx, args) => {
    const detail = await getProposalByPursuitId(ctx.companyId, args.pursuitId);
    if (!detail) return { error: 'not_found' };
    if (!detail.proposal) {
      return {
        pursuitId: args.pursuitId,
        opportunityTitle: detail.opportunity.title,
        status: 'no_proposal_yet' as const,
      };
    }

    const p = detail.proposal;
    const outline = (p.outline as OutlineEntry[] | null) ?? [];
    const sections = (p.sections as SectionEntry[] | null) ?? [];
    const compliance = (p.complianceMatrix as ComplianceEntry[] | null) ?? [];

    const addressed = compliance.filter(
      (c) => c.status === 'fully_addressed' || c.status === 'confirmed',
    ).length;

    return {
      proposalId: p.id,
      pursuitId: args.pursuitId,
      status: p.status,
      opportunity: {
        title: detail.opportunity.title,
        agency: detail.opportunity.agencyName,
        jurisdiction: detail.opportunity.jurisdictionName,
        deadlineAt: detail.opportunity.deadlineAt?.toISOString() ?? null,
      },
      outline: outline.map((o) => ({
        id: o.id,
        number: o.number,
        title: o.title,
        description: o.description,
        pageLimit: o.pageLimit,
      })),
      sections: sections.map((s) => ({
        id: s.id,
        outlineId: s.outlineId,
        title: s.title,
        status: s.status,
        wordCount: s.wordCount ?? 0,
      })),
      compliance: {
        total: compliance.length,
        addressed,
        gaps: compliance
          .filter((c) => c.status === 'not_addressed' || c.status === 'partially_addressed')
          .slice(0, 25)
          .map((c) => ({
            requirement: c.requirementText.slice(0, 300),
            status: c.status,
            addressedInSection: c.addressedInSection ?? null,
          })),
      },
      submittedAt: p.submittedAt?.toISOString() ?? null,
    };
  },
});
