import { task } from '@trigger.dev/sdk/v3';
import { eq } from 'drizzle-orm';
import { summarizeOpportunity } from '@procur/ai';
import { db, opportunities } from '@procur/db';
import { log } from '@procur/utils/logger';
import { loadAgencyName, loadDocumentText, loadOpportunity } from '../helpers';

export type SummarizePayload = { opportunityId: string };

export const summarizeTask = task({
  id: 'opportunity.summarize',
  maxDuration: 120,
  run: async (payload: SummarizePayload) => {
    const opp = await loadOpportunity(payload.opportunityId);
    if (!opp) throw new Error(`opportunity ${payload.opportunityId} not found`);

    const [agencyName, docText] = await Promise.all([
      loadAgencyName(opp.agencyId),
      loadDocumentText(opp.id),
    ]);

    const result = await summarizeOpportunity({
      title: opp.title,
      description: opp.description ?? undefined,
      agency: agencyName,
      docText,
    });

    await db
      .update(opportunities)
      .set({ aiSummary: result.summary, updatedAt: new Date() })
      .where(eq(opportunities.id, opp.id));

    log.info('ai.summarize', { opportunityId: opp.id, ...result.usage });
    return result;
  },
});
