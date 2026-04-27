import { schedules } from '@trigger.dev/sdk/v3';
import { backfillTranslationsTask } from './backfill-translations';

/**
 * Daily safety net for the auto-translate orchestrator.
 *
 * The inline orchestrator (enrich-opportunity.ts) triggers translateTask
 * for every newly-scraped non-English opportunity. If that triggerAndWait
 * fails for any reason — Anthropic rate limit, transient network error,
 * trigger.dev queue rejection — the row stays in its source language
 * forever and the auto-translate appears broken for that opportunity.
 *
 * This cron picks up anything where `language != 'en'` AND
 * `parsed_content.translations.en IS NULL`, then fans out translateTask.
 * Acts as the "eventual consistency" backstop for the inline path.
 *
 * Scheduled at 02:00 UTC daily — middle of the night for the Caribbean
 * + LATAM scraper fleet, low load on Anthropic.
 */
export const backfillTranslationsCron = schedules.task({
  id: 'opportunity.backfill-translations-cron',
  cron: '0 2 * * *',
  maxDuration: 1800,
  run: async () => {
    const result = await backfillTranslationsTask.triggerAndWait({
      targetLanguage: 'en',
      limit: 5000,
    });
    return result;
  },
});
