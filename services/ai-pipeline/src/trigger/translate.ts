import { task } from '@trigger.dev/sdk/v3';
import { eq } from 'drizzle-orm';
import { translateOpportunity } from '@procur/ai';
import { db, opportunities } from '@procur/db';
import { log } from '@procur/utils/logger';
import { loadOpportunity } from '../helpers';

export type TranslatePayload = {
  opportunityId: string;
  targetLanguage: string;
};

export const translateTask = task({
  id: 'opportunity.translate',
  maxDuration: 180,
  run: async (payload: TranslatePayload) => {
    const opp = await loadOpportunity(payload.opportunityId);
    if (!opp) throw new Error(`opportunity ${payload.opportunityId} not found`);

    const sourceLanguage = opp.language ?? 'en';
    if (sourceLanguage === payload.targetLanguage) {
      log.info('ai.translate.skipped', {
        opportunityId: opp.id,
        reason: 'source equals target',
      });
      return null;
    }

    const result = await translateOpportunity({
      title: opp.title,
      description: opp.description ?? undefined,
      sourceLanguage,
      targetLanguage: payload.targetLanguage,
    });

    const existing = (opp.parsedContent as Record<string, unknown> | null) ?? {};
    const translations =
      (existing.translations as Record<string, { title: string; description: string }>) ?? {};
    translations[payload.targetLanguage] = {
      title: result.title,
      description: result.description,
    };

    await db
      .update(opportunities)
      .set({
        parsedContent: { ...existing, translations },
        updatedAt: new Date(),
      })
      .where(eq(opportunities.id, opp.id));

    log.info('ai.translate', {
      opportunityId: opp.id,
      from: sourceLanguage,
      to: payload.targetLanguage,
      ...result.usage,
    });
    return result;
  },
});
