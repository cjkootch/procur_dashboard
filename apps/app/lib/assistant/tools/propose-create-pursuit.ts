import 'server-only';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { defineTool } from '@procur/ai';
import { agencies, db, jurisdictions, opportunities, pursuits } from '@procur/db';

const input = z.object({
  opportunityId: z.string(),
  notes: z.string().optional(),
});

/**
 * Propose creating a pursuit from an opportunity. Does not write. If a
 * pursuit already exists for (company, opportunity), returns that fact
 * so the model can tell the user instead of proposing a duplicate.
 */
export const proposeCreatePursuitTool = defineTool({
  name: 'propose_create_pursuit',
  description:
    'Propose creating a pursuit for an opportunity. Produces a confirmation card; the user applies it manually. Requires opportunityId. Optional notes are included on the created pursuit. Returns an error shape if a pursuit already exists.',
  kind: 'write',
  schema: input,
  handler: async (ctx, args) => {
    const opp = await db
      .select({
        id: opportunities.id,
        title: opportunities.title,
        referenceNumber: opportunities.referenceNumber,
        deadlineAt: opportunities.deadlineAt,
        valueEstimateUsd: opportunities.valueEstimateUsd,
        currency: opportunities.currency,
        jurisdictionName: jurisdictions.name,
        agencyName: agencies.name,
      })
      .from(opportunities)
      .innerJoin(jurisdictions, eq(jurisdictions.id, opportunities.jurisdictionId))
      .leftJoin(agencies, eq(agencies.id, opportunities.agencyId))
      .where(eq(opportunities.id, args.opportunityId))
      .limit(1);

    if (opp.length === 0) {
      return { error: 'opportunity_not_found' };
    }
    const o = opp[0]!;

    const existing = await db.query.pursuits.findFirst({
      where: and(
        eq(pursuits.companyId, ctx.companyId),
        eq(pursuits.opportunityId, args.opportunityId),
      ),
    });
    if (existing) {
      return {
        error: 'pursuit_already_exists',
        pursuitId: existing.id,
        stage: existing.stage,
      };
    }

    return {
      proposalId: randomUUID(),
      toolName: 'propose_create_pursuit',
      title: `Create pursuit: ${o.title.slice(0, 100)}`,
      description: `Start tracking "${o.title.slice(0, 120)}" from ${o.agencyName ?? o.jurisdictionName}. Initial stage will be Identification.`,
      preview: {
        opportunityTitle: o.title,
        agency: o.agencyName,
        jurisdiction: o.jurisdictionName,
        referenceNumber: o.referenceNumber,
        deadlineAt: o.deadlineAt?.toISOString() ?? null,
        valueEstimateUsd: o.valueEstimateUsd,
        currency: o.currency,
        notes: args.notes ?? null,
      },
      applyPayload: {
        opportunityId: args.opportunityId,
        notes: args.notes ?? null,
      },
    };
  },
});
