import 'server-only';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { defineTool } from '@procur/ai';
import { getPursuitById } from '../../capture-queries';

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
  pursuitId: z.string(),
  stage: z.enum(STAGES),
  reasoning: z.string().optional(),
});

export const proposeAdvanceStageTool = defineTool({
  name: 'propose_advance_stage',
  description:
    "Propose moving a pursuit to a new stage (identification, qualification, capture_planning, proposal_development, submitted, awarded, lost). Produces a confirmation card. Terminal stages (awarded, lost) record the outcome timestamp.",
  kind: 'write',
  schema: input,
  handler: async (ctx, args) => {
    const pursuit = await getPursuitById(ctx.companyId, args.pursuitId);
    if (!pursuit) return { error: 'pursuit_not_found' };
    if (pursuit.stage === args.stage) {
      return { error: 'already_at_stage', stage: pursuit.stage };
    }

    return {
      proposalId: randomUUID(),
      toolName: 'propose_advance_stage',
      title: `Move to ${args.stage.replace(/_/g, ' ')}: ${pursuit.opportunity.title.slice(0, 80)}`,
      description:
        args.reasoning ??
        `Change stage from ${pursuit.stage.replace(/_/g, ' ')} to ${args.stage.replace(/_/g, ' ')}.`,
      preview: {
        pursuitTitle: pursuit.opportunity.title,
        fromStage: pursuit.stage,
        toStage: args.stage,
      },
      applyPayload: {
        pursuitId: args.pursuitId,
        stage: args.stage,
      },
    };
  },
});
