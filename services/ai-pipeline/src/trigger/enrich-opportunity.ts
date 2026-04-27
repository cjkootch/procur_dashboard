import { task, batch } from '@trigger.dev/sdk/v3';
import { eq, and } from 'drizzle-orm';
import { db, documents, opportunities } from '@procur/db';
import { log } from '@procur/utils/logger';
import { enrichCoreTask } from './enrich-core';
import { extractRequirementsTask } from './extract-requirements';
import { processDocumentTask } from './process-document';
import { translateTask } from './translate';
import { loadOpportunity } from '../helpers';

export type EnrichOpportunityPayload = { opportunityId: string };

/**
 * Orchestrator. Fired by scraper.run() after it upserts a new opportunity.
 *
 * Flow:
 *   0. process-document for every pending doc (download → Blob → extract text)
 *   1. enrich-core: ONE Haiku call producing language + category + subCategory
 *      + summary + confidence. Replaces the old fan-out to detect-language +
 *      classify + summarize (cuts ~60% of per-opp AI cost — same input is
 *      sent once, system prompt is cache-friendly across the corpus).
 *   2. translate to English if source language isn't English.
 *   3. extract-requirements if the opportunity has processed documents
 *      (Sonnet, slower).
 *
 * Step 0 must finish before step 1 because enrich-core can read the
 * extracted document text. Prompt caching kicks in for step 3: the
 * doc text was already read by enrich-core in step 1, so Anthropic has
 * already cached the prefix.
 */
export const enrichOpportunityTask = task({
  id: 'opportunity.enrich',
  maxDuration: 900,
  run: async (payload: EnrichOpportunityPayload) => {
    const { opportunityId } = payload;
    log.info('ai.enrich.started', { opportunityId });

    const pendingDocs = await db
      .select({ id: documents.id })
      .from(documents)
      .where(
        and(
          eq(documents.opportunityId, opportunityId),
          eq(documents.processingStatus, 'pending'),
        ),
      );

    if (pendingDocs.length > 0) {
      log.info('ai.enrich.processing-documents', {
        opportunityId,
        count: pendingDocs.length,
      });
      await batch.triggerByTaskAndWait(
        pendingDocs.map((d) => ({
          task: processDocumentTask,
          payload: { documentId: d.id },
        })),
      );
    }

    await enrichCoreTask.triggerAndWait({ opportunityId });

    // Auto-translate to English when the source language is not English.
    // Discover renders the translated copy when the user's
    // Accept-Language is en-*. Re-load after the parallel batch since
    // detect-language may have just updated `language`.
    const refreshed = await loadOpportunity(opportunityId);
    if (refreshed && refreshed.language && refreshed.language !== 'en') {
      await translateTask.triggerAndWait({
        opportunityId,
        targetLanguage: 'en',
      });
    }

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
