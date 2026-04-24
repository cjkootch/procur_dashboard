import 'server-only';
import { z } from 'zod';
import { defineTool } from '@procur/ai';
import { getPursuitById, getPursuitRaw, listPursuitTasks } from '../../capture-queries';

const input = z.object({
  pursuitId: z.string(),
});

/**
 * Full detail for one pursuit: stage, p_win, capture answers, tasks, assigned user.
 * Pair with get_proposal if the caller also needs the draft.
 */
export const getPursuitTool = defineTool({
  name: 'get_pursuit',
  description:
    "Return full detail for one pursuit by id: stage, bid decision, p_win, capture answers (win themes, competitors, differentiators, risks), notes, assigned user, and up to 25 tasks. Only returns pursuits owned by the current company.",
  kind: 'read',
  schema: input,
  handler: async (ctx, args) => {
    const [card, raw] = await Promise.all([
      getPursuitById(ctx.companyId, args.pursuitId),
      getPursuitRaw(ctx.companyId, args.pursuitId),
    ]);
    if (!card || !raw) return { error: 'not_found' };

    const tasks = (await listPursuitTasks(args.pursuitId)).slice(0, 25).map((t) => ({
      id: t.id,
      title: t.title,
      dueDate: t.dueDate,
      completed: t.completedAt !== null,
      priority: t.priority,
      category: t.category,
      assignedUser:
        [t.assignedUserFirstName, t.assignedUserLastName].filter(Boolean).join(' ') || null,
    }));

    return {
      id: card.id,
      stage: card.stage,
      pWin: card.pWin,
      bidDecision: raw.bidDecision,
      bidDecisionReasoning: raw.bidDecisionReasoning,
      captureAnswers: raw.captureAnswers ?? null,
      notes: card.notes,
      assignedUser: card.assignedUserName,
      opportunity: {
        id: card.opportunity.id,
        title: card.opportunity.title,
        agency: card.opportunity.agencyName,
        jurisdiction: card.opportunity.jurisdictionName,
        deadlineAt: card.opportunity.deadlineAt?.toISOString() ?? null,
        valueEstimate: card.opportunity.valueEstimate,
        valueEstimateUsd: card.opportunity.valueEstimateUsd,
        currency: card.opportunity.currency,
        referenceNumber: card.opportunity.referenceNumber,
      },
      tasks,
      submittedAt: raw.submittedAt?.toISOString() ?? null,
      wonAt: raw.wonAt?.toISOString() ?? null,
      lostAt: raw.lostAt?.toISOString() ?? null,
    };
  },
});
