import { task } from '@trigger.dev/sdk/v3';
import { eq } from 'drizzle-orm';
import { extractRequirements } from '@procur/ai';
import { db, opportunities } from '@procur/db';
import { log } from '@procur/utils/logger';
import { loadDocumentText, loadOpportunity } from '../helpers';

export type ExtractRequirementsPayload = { opportunityId: string };

export const extractRequirementsTask = task({
  id: 'opportunity.extract-requirements',
  maxDuration: 600,
  run: async (payload: ExtractRequirementsPayload) => {
    const opp = await loadOpportunity(payload.opportunityId);
    if (!opp) throw new Error(`opportunity ${payload.opportunityId} not found`);

    // Idempotency: this task moved from the per-scrape enrich path
    // (where it ran exactly once) to the pursuit-create path (where
    // multiple users from one or different tenants can race the same
    // opportunity). Skip work if requirements were already extracted.
    if (opp.extractedRequirements && opp.extractedRequirements.length > 0) {
      log.info('ai.extract-requirements.skipped', {
        opportunityId: opp.id,
        reason: 'already extracted',
      });
      return null;
    }

    const docText = await loadDocumentText(opp.id);
    if (!docText) {
      log.info('ai.extract-requirements.skipped', {
        opportunityId: opp.id,
        reason: 'no processed documents',
      });
      return null;
    }

    const result = await extractRequirements({
      title: opp.title,
      description: opp.description ?? undefined,
      docText,
    });

    await db
      .update(opportunities)
      .set({
        extractedRequirements: result.requirements,
        extractedCriteria: result.criteria,
        mandatoryDocuments: result.mandatoryDocuments,
        extractionConfidence: String(result.confidence),
        updatedAt: new Date(),
      })
      .where(eq(opportunities.id, opp.id));

    log.info('ai.extract-requirements', {
      opportunityId: opp.id,
      requirementsCount: result.requirements.length,
      criteriaCount: result.criteria.length,
      docCount: result.mandatoryDocuments.length,
      confidence: result.confidence,
      ...result.usage,
    });
    return result;
  },
});
