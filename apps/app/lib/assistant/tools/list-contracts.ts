import 'server-only';
import { z } from 'zod';
import { defineTool } from '@procur/ai';
import { listContracts } from '../../contract-queries';

const input = z.object({
  status: z.enum(['active', 'completed', 'terminated']).optional(),
  limit: z.number().optional(),
});

export const listContractsTool = defineTool({
  name: 'list_contracts',
  description:
    "List the company's contracts. Optional filters: status (active|completed|terminated), limit (default 25). Returns title, agency, number, status, start/end dates, total value, and obligation counts.",
  kind: 'read',
  schema: input,
  handler: async (ctx, args) => {
    const all = await listContracts(ctx.companyId);
    const filtered = args.status ? all.filter((c) => c.status === args.status) : all;
    const limit = Math.min(args.limit ?? 25, 50);
    return {
      totalMatching: filtered.length,
      contracts: filtered.slice(0, limit).map((c) => ({
        id: c.id,
        title: c.awardTitle,
        agency: c.awardingAgency,
        tier: c.tier,
        status: c.status,
        contractNumber: c.contractNumber,
        startDate: c.startDate,
        endDate: c.endDate,
        totalValue: c.totalValue,
        totalValueUsd: c.totalValueUsd,
        currency: c.currency,
        obligations: {
          total: c.obligationCount,
          open: c.openObligationCount,
        },
      })),
    };
  },
});
