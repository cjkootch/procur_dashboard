import { task } from '@trigger.dev/sdk/v3';
import { eq } from 'drizzle-orm';
import { enrichCore } from '@procur/ai';
import { db, opportunities } from '@procur/db';
import { log } from '@procur/utils/logger';
import { loadAgencyName, loadDocumentText, loadOpportunity, loadTaxonomy } from '../helpers';

export type EnrichCorePayload = { opportunityId: string };

/**
 * Combined replacement for detect-language + classify + summarize.
 *
 * One Haiku call writes language, category, subCategory,
 * aiCategoryConfidence, and aiSummary in a single DB update —
 * down from three round trips. The orchestrator (enrich-opportunity)
 * triggerAndWaits this once instead of fanning out three sub-tasks.
 *
 * The legacy detectLanguageTask / classifyTask / summarizeTask
 * still exist (they're cheap to keep deployed) but no longer fire
 * during the standard enrich flow. Safe to delete in a follow-up
 * once we're confident this combined task is producing equivalent
 * output across all jurisdictions.
 */
export const enrichCoreTask = task({
  id: 'opportunity.enrich-core',
  maxDuration: 120,
  run: async (payload: EnrichCorePayload) => {
    const opp = await loadOpportunity(payload.opportunityId);
    if (!opp) throw new Error(`opportunity ${payload.opportunityId} not found`);

    const [agencyName, docText, taxonomy] = await Promise.all([
      loadAgencyName(opp.agencyId),
      loadDocumentText(opp.id),
      loadTaxonomy(),
    ]);

    const result = await enrichCore({
      title: opp.title,
      description: opp.description ?? undefined,
      agency: agencyName,
      docText,
      taxonomy,
    });

    await db
      .update(opportunities)
      .set({
        language: result.language,
        category: result.category,
        subCategory: result.subCategory ?? null,
        aiCategoryConfidence: String(result.confidence),
        aiSummary: result.summary,
        updatedAt: new Date(),
      })
      .where(eq(opportunities.id, opp.id));

    log.info('ai.enrich-core', {
      opportunityId: opp.id,
      language: result.language,
      category: result.category,
      subCategory: result.subCategory,
      confidence: result.confidence,
      summaryLen: result.summary.length,
      ...result.usage,
    });

    return result;
  },
});
