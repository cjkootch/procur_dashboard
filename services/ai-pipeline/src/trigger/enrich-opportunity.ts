import { task, batch } from '@trigger.dev/sdk/v3';
import { eq, and } from 'drizzle-orm';
import { db, documents, opportunities, pursuits } from '@procur/db';
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
 *      + summary + confidence.
 *   2. translate to English if source language isn't English.
 *   3. extract-requirements ONLY IF any pursuit already exists for this
 *      opportunity. Saves Sonnet cost on the 90%+ of scraped opps that
 *      no one ever tracks. For Discover-tracked opps where the pursuit
 *      is created AFTER enrich ran, the create-pursuit handlers
 *      themselves fire extract-requirements (see
 *      apps/app/lib/trigger-extract-requirements.ts). The task is
 *      idempotent so concurrent paths are safe.
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

    // If any pursuit already exists for this opp (typical: uploaded
    // private bids where the pursuit is created BEFORE the enrich
    // runs), fire extract-requirements at the end. Discover-scraped
    // opps with no pursuit yet skip this — saves Sonnet cost on the
    // long tail. Idempotent task; concurrent fires are safe.
    const [existingPursuit] = await db
      .select({ id: pursuits.id })
      .from(pursuits)
      .where(eq(pursuits.opportunityId, opportunityId))
      .limit(1);

    if (existingPursuit) {
      await extractRequirementsTask.triggerAndWait({ opportunityId });
    }

    await db
      .update(opportunities)
      .set({ updatedAt: new Date() })
      .where(eq(opportunities.id, opportunityId));

    log.info('ai.enrich.completed', {
      opportunityId,
      hadPursuit: Boolean(existingPursuit),
    });
    return { opportunityId, hadPursuit: Boolean(existingPursuit) };
  },
});
