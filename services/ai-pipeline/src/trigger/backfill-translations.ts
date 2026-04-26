import { task, batch } from '@trigger.dev/sdk/v3';
import { and, eq, isNotNull, ne, sql } from 'drizzle-orm';
import { db, opportunities } from '@procur/db';
import { log } from '@procur/utils/logger';
import { translateTask } from './translate';

/**
 * One-off backfill — translate every active opportunity whose source
 * language isn't English to English. Trigger manually from the
 * Trigger.dev dashboard after the auto-translate orchestrator wiring
 * lands; subsequent ingests handle themselves.
 *
 * Skips rows that already have a non-empty `parsed_content.translations.en`
 * so it's safe to re-run.
 */
export const backfillTranslationsTask = task({
  id: 'opportunity.backfill-translations',
  maxDuration: 1800,
  run: async (payload: { targetLanguage?: string; limit?: number } = {}) => {
    const targetLanguage = payload.targetLanguage ?? 'en';
    const max = payload.limit ?? 5000;

    const rows = await db
      .select({ id: opportunities.id, language: opportunities.language })
      .from(opportunities)
      .where(
        and(
          eq(opportunities.status, 'active'),
          isNotNull(opportunities.language),
          ne(opportunities.language, targetLanguage),
          // Skip rows we've already translated.
          sql`(${opportunities.parsedContent}->'translations'->>${targetLanguage}) IS NULL`,
        ),
      )
      .limit(max);

    log.info('ai.backfill.scheduled', {
      candidateCount: rows.length,
      targetLanguage,
    });

    if (rows.length === 0) return { scheduled: 0 };

    // Trigger.dev caps a batchTrigger at 100 items per call; chunk to be safe.
    const chunkSize = 100;
    let scheduled = 0;
    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      await batch.triggerByTask(
        chunk.map((r) => ({
          task: translateTask,
          payload: { opportunityId: r.id, targetLanguage },
        })),
      );
      scheduled += chunk.length;
    }

    return { scheduled, targetLanguage };
  },
});
