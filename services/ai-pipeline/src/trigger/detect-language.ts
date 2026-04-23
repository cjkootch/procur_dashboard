import { task } from '@trigger.dev/sdk/v3';
import { eq } from 'drizzle-orm';
import { detectLanguage } from '@procur/ai';
import { db, opportunities } from '@procur/db';
import { log } from '@procur/utils/logger';
import { loadOpportunity } from '../helpers';

export type DetectLanguagePayload = { opportunityId: string };

export const detectLanguageTask = task({
  id: 'opportunity.detect-language',
  maxDuration: 60,
  run: async (payload: DetectLanguagePayload) => {
    const opp = await loadOpportunity(payload.opportunityId);
    if (!opp) throw new Error(`opportunity ${payload.opportunityId} not found`);

    const result = await detectLanguage({
      title: opp.title,
      description: opp.description ?? undefined,
    });

    await db
      .update(opportunities)
      .set({ language: result.language, updatedAt: new Date() })
      .where(eq(opportunities.id, opp.id));

    log.info('ai.detect-language', {
      opportunityId: opp.id,
      language: result.language,
      confidence: result.confidence,
      ...result.usage,
    });
    return result;
  },
});
