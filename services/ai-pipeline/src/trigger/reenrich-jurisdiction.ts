import { task, tasks } from '@trigger.dev/sdk/v3';
import { eq } from 'drizzle-orm';
import { db, jurisdictions, opportunities } from '@procur/db';
import { log } from '@procur/utils/logger';

const BATCH_SIZE = 100; // trigger.dev caps batchTrigger at 100 items per call

export type ReenrichJurisdictionPayload = {
  /** Jurisdiction slug (e.g. 'un', 'jamaica', 'colombia'). */
  jurisdictionSlug: string;
  /** Cap on how many rows to re-enrich. Default 5000. */
  limit?: number;
};

/**
 * One-shot task to re-fire opportunity.enrich on every active row in a
 * given jurisdiction. Useful when:
 *
 *   - A scraper bug wrote wrong titles/descriptions that detect-language
 *     then misclassified (UNGM had this — Spanish notices got labeled
 *     'en' because detect-language ran on placeholder anchor text).
 *   - The enrich-core prompt or model is updated and we want to
 *     re-process a corpus to benefit from the change.
 *
 * Trigger manually from the trigger.dev dashboard with payload:
 *   { "jurisdictionSlug": "un" }
 *
 * Each child enrich run is idempotent — if a doc is already extracted
 * or a translation is already cached, the inner tasks short-circuit.
 */
export const reenrichJurisdictionTask = task({
  id: 'opportunity.reenrich-jurisdiction',
  maxDuration: 1800,
  run: async (payload: ReenrichJurisdictionPayload) => {
    const max = payload.limit ?? 5000;

    const [jur] = await db
      .select({ id: jurisdictions.id, slug: jurisdictions.slug })
      .from(jurisdictions)
      .where(eq(jurisdictions.slug, payload.jurisdictionSlug))
      .limit(1);
    if (!jur) {
      log.warn('reenrich-jurisdiction.not-found', { slug: payload.jurisdictionSlug });
      return { scheduled: 0, reason: 'jurisdiction not found' };
    }

    const rows = await db
      .select({ id: opportunities.id })
      .from(opportunities)
      .where(eq(opportunities.jurisdictionId, jur.id))
      .limit(max);

    log.info('reenrich-jurisdiction.scheduled', {
      slug: jur.slug,
      candidateCount: rows.length,
    });

    if (rows.length === 0) return { scheduled: 0, jurisdictionSlug: jur.slug };

    let scheduled = 0;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const chunk = rows.slice(i, i + BATCH_SIZE);
      await tasks.batchTrigger(
        'opportunity.enrich',
        chunk.map((r) => ({ payload: { opportunityId: r.id } })),
      );
      scheduled += chunk.length;
    }

    return { scheduled, jurisdictionSlug: jur.slug };
  },
});
