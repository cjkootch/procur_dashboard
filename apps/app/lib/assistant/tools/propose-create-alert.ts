import 'server-only';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { defineTool } from '@procur/ai';

const input = z.object({
  name: z.string(),
  jurisdictions: z.array(z.string()).optional(),
  categories: z.array(z.string()).optional(),
  keywords: z.array(z.string()).optional(),
  excludeKeywords: z.array(z.string()).optional(),
  minValue: z.number().optional(),
  maxValue: z.number().optional(),
  frequency: z.enum(['instant', 'daily', 'weekly']).optional(),
});

export const proposeCreateAlertTool = defineTool({
  name: 'propose_create_alert_profile',
  description:
    "Propose creating a new opportunity-match alert for the current user. At least one of jurisdictions / categories / keywords must be provided. Frequency defaults to daily.",
  kind: 'write',
  schema: input,
  handler: async (_ctx, args) => {
    const criteriaCount =
      (args.jurisdictions?.length ?? 0) +
      (args.categories?.length ?? 0) +
      (args.keywords?.length ?? 0);
    if (criteriaCount === 0) {
      return { error: 'no_criteria', message: 'at least one filter is required' };
    }

    return {
      proposalId: randomUUID(),
      toolName: 'propose_create_alert_profile',
      title: `Alert: ${args.name.slice(0, 80)}`,
      description: `Deliver matching opportunities ${args.frequency ?? 'daily'} by email.`,
      preview: {
        name: args.name,
        jurisdictions: args.jurisdictions ?? [],
        categories: args.categories ?? [],
        keywords: args.keywords ?? [],
        excludeKeywords: args.excludeKeywords ?? [],
        minValue: args.minValue ?? null,
        maxValue: args.maxValue ?? null,
        frequency: args.frequency ?? 'daily',
      },
      applyPayload: {
        name: args.name,
        jurisdictions: args.jurisdictions ?? null,
        categories: args.categories ?? null,
        keywords: args.keywords ?? null,
        excludeKeywords: args.excludeKeywords ?? null,
        minValue: args.minValue ?? null,
        maxValue: args.maxValue ?? null,
        frequency: args.frequency ?? 'daily',
      },
    };
  },
});
