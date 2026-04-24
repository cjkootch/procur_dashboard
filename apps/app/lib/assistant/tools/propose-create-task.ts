import 'server-only';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { defineTool } from '@procur/ai';
import { getPursuitById } from '../../capture-queries';

const input = z.object({
  pursuitId: z.string(),
  title: z.string(),
  description: z.string().optional(),
  dueDate: z.string().optional(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
  category: z.enum(['research', 'outreach', 'drafting', 'review', 'submission']).optional(),
});

export const proposeCreateTaskTool = defineTool({
  name: 'propose_create_task',
  description:
    "Propose creating a task on a pursuit. Produces a confirmation card. dueDate is ISO-8601 date (YYYY-MM-DD). Priority defaults to medium; category defaults to research.",
  kind: 'write',
  schema: input,
  handler: async (ctx, args) => {
    const pursuit = await getPursuitById(ctx.companyId, args.pursuitId);
    if (!pursuit) return { error: 'pursuit_not_found' };

    return {
      proposalId: randomUUID(),
      toolName: 'propose_create_task',
      title: `Task: ${args.title.slice(0, 80)}`,
      description: `Add to pursuit "${pursuit.opportunity.title.slice(0, 80)}"${args.dueDate ? `, due ${args.dueDate}` : ''}.`,
      preview: {
        pursuitTitle: pursuit.opportunity.title,
        taskTitle: args.title,
        taskDescription: args.description ?? null,
        dueDate: args.dueDate ?? null,
        priority: args.priority ?? 'medium',
        category: args.category ?? 'research',
      },
      applyPayload: {
        pursuitId: args.pursuitId,
        title: args.title,
        description: args.description ?? null,
        dueDate: args.dueDate ?? null,
        priority: args.priority ?? 'medium',
        category: args.category ?? 'research',
      },
    };
  },
});
