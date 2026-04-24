import 'server-only';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { defineTool } from '@procur/ai';
import { getProposalByPursuitId } from '../../proposal-queries';

const input = z.object({
  pursuitId: z.string(),
  sectionId: z.string(),
  userInstruction: z.string().optional(),
});

type OutlineEntry = {
  id: string;
  number: string;
  title: string;
};

type SectionEntry = {
  id: string;
  outlineId?: string;
  title: string;
  status: string;
  wordCount?: number;
};

export const proposeDraftProposalSectionTool = defineTool({
  name: 'propose_draft_proposal_section',
  description:
    'Propose AI-drafting a proposal section. Produces a confirmation card; the user applies it to kick off the draft (which runs the same proposal drafting pipeline as the /proposal UI). userInstruction is an optional hint for the draft.',
  kind: 'write',
  schema: input,
  handler: async (ctx, args) => {
    const detail = await getProposalByPursuitId(ctx.companyId, args.pursuitId);
    if (!detail) return { error: 'pursuit_not_found' };
    if (!detail.proposal) return { error: 'proposal_not_initialized' };

    const outline = (detail.proposal.outline as OutlineEntry[] | null) ?? [];
    const sections = (detail.proposal.sections as SectionEntry[] | null) ?? [];
    const section = sections.find((s) => s.id === args.sectionId);
    if (!section) return { error: 'section_not_found' };
    const outlineEntry = outline.find((o) => o.id === section.outlineId);

    const sectionLabel = outlineEntry
      ? `${outlineEntry.number} ${outlineEntry.title}`
      : section.title;

    return {
      proposalId: randomUUID(),
      toolName: 'propose_draft_proposal_section',
      title: `Draft section: ${sectionLabel.slice(0, 80)}`,
      description:
        args.userInstruction ??
        `Generate an AI draft for section "${sectionLabel}" on "${detail.opportunity.title.slice(0, 80)}". This will replace any existing draft for this section.`,
      preview: {
        opportunityTitle: detail.opportunity.title,
        sectionLabel,
        currentStatus: section.status,
        currentWordCount: section.wordCount ?? 0,
        userInstruction: args.userInstruction ?? null,
      },
      applyPayload: {
        pursuitId: args.pursuitId,
        sectionId: args.sectionId,
        userInstruction: args.userInstruction ?? null,
      },
    };
  },
});
