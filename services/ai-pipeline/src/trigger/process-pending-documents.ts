import { schedules, tasks } from '@trigger.dev/sdk/v3';
import { eq } from 'drizzle-orm';
import { db, documents } from '@procur/db';
import { log } from '@procur/utils/logger';
import { processDocumentTask } from './process-document';

const SWEEP_BATCH_SIZE = 50;

/**
 * Self-healing sweep. Picks up `documents` rows that are still
 * `processing_status='pending'` and fans out processDocumentTask.
 *
 * Why this exists: enrich-opportunity triggers per-doc processing
 * inline after a scrape, but if (a) the scraper crashes between
 * INSERT and trigger, (b) the trigger.dev queue rejects, or
 * (c) a transient network blip exhausts retries, the doc would
 * sit in 'pending' forever. This task is the safety net.
 *
 * Running every 30 minutes is enough — scrapers run on 4-hour
 * cycles, and we want failures resolved well before the next scrape.
 */
export const processPendingDocumentsTask = schedules.task({
  id: 'document.process-pending-sweep',
  cron: '*/30 * * * *',
  maxDuration: 60,
  run: async () => {
    const pending = await db
      .select({ id: documents.id })
      .from(documents)
      .where(eq(documents.processingStatus, 'pending'))
      .limit(SWEEP_BATCH_SIZE);

    if (pending.length === 0) {
      log.info('document.sweep.empty');
      return { picked: 0 };
    }

    log.info('document.sweep.dispatching', { count: pending.length });
    await tasks.batchTrigger<typeof processDocumentTask>(
      processDocumentTask.id,
      pending.map((d) => ({ payload: { documentId: d.id } })),
    );
    return { picked: pending.length };
  },
});
