import { task } from '@trigger.dev/sdk/v3';
import { eq } from 'drizzle-orm';
import { classifyOpportunity } from '@procur/ai';
import { db, opportunities } from '@procur/db';
import { log } from '@procur/utils/logger';
import { loadAgencyName, loadDocumentText, loadOpportunity, loadTaxonomy } from '../helpers';

export type ClassifyPayload = { opportunityId: string };

export const classifyTask = task({
  id: 'opportunity.classify',
  maxDuration: 120,
  run: async (payload: ClassifyPayload) => {
    const opp = await loadOpportunity(payload.opportunityId);
    if (!opp) throw new Error(`opportunity ${payload.opportunityId} not found`);

    const [agencyName, docText, taxonomy] = await Promise.all([
      loadAgencyName(opp.agencyId),
      loadDocumentText(opp.id),
      loadTaxonomy(),
    ]);

    const result = await classifyOpportunity({
      title: opp.title,
      description: opp.description ?? undefined,
      agency: agencyName,
      docText,
      taxonomy,
    });

    await db
      .update(opportunities)
      .set({
        category: result.category,
        subCategory: result.subCategory ?? null,
        aiCategoryConfidence: String(result.confidence),
        updatedAt: new Date(),
      })
      .where(eq(opportunities.id, opp.id));

    log.info('ai.classify', {
      opportunityId: opp.id,
      category: result.category,
      confidence: result.confidence,
      ...result.usage,
    });

    return result;
  },
});
