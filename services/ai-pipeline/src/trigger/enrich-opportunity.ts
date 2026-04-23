import { task, batch } from '@trigger.dev/sdk/v3';
import { eq, and } from 'drizzle-orm';
import { db, documents, opportunities } from '@procur/db';
import { log } from '@procur/utils/logger';
import { classifyTask } from './classify';
import { summarizeTask } from './summarize';
import { detectLanguageTask } from './detect-language';
import { extractRequirementsTask } from './extract-requirements';

export type EnrichOpportunityPayload = { opportunityId: string };

/**
 * Orchestrator. Fired by scraper.run() after it upserts a new opportunity.
 *
 * Flow:
 *   1. detect-language + classify + summarize in parallel (all Haiku, fast)
 *   2. extract-requirements if the opportunity has processed documents (Sonnet, slower)
 *
 * Prompt caching kicks in for step 2: the same doc text was read by classify
 * and summarize in step 1, so Anthropic has already cached the prefix.
 */
export const enrichOpportunityTask = task({
  id: 'opportunity.enrich',
  maxDuration: 900,
  run: async (payload: EnrichOpportunityPayload) => {
    const { opportunityId } = payload;
    log.info('ai.enrich.started', { opportunityId });

    await batch.triggerByTaskAndWait([
      { task: detectLanguageTask, payload: { opportunityId } },
      { task: classifyTask, payload: { opportunityId } },
      { task: summarizeTask, payload: { opportunityId } },
    ]);

    const [hasDocs] = await db
      .select({ id: documents.id })
      .from(documents)
      .where(
        and(
          eq(documents.opportunityId, opportunityId),
          eq(documents.processingStatus, 'completed'),
        ),
      )
      .limit(1);

    if (hasDocs) {
      await extractRequirementsTask.triggerAndWait({ opportunityId });
    }

    await db
      .update(opportunities)
      .set({ updatedAt: new Date() })
      .where(eq(opportunities.id, opportunityId));

    log.info('ai.enrich.completed', {
      opportunityId,
      hadDocuments: Boolean(hasDocs),
    });
    return { opportunityId, hadDocuments: Boolean(hasDocs) };
  },
});
