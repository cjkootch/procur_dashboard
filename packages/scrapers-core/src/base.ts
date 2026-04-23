import { log, type Logger } from '@procur/utils/logger';
import {
  finishScraperRun,
  getJurisdictionBySlug,
  startScraperRun,
  upsertOpportunity,
} from './upsert';
import type {
  NormalizedOpportunity,
  RawOpportunity,
  ScraperError,
  ScraperResult,
} from './types';

export type ScraperRunOptions = {
  triggerRunId?: string;
  logger?: Logger;
};

export abstract class TenderScraper {
  abstract readonly jurisdictionSlug: string;
  abstract readonly sourceName: string;
  abstract readonly portalUrl: string;

  abstract fetch(): Promise<RawOpportunity[]>;
  abstract parse(raw: RawOpportunity): Promise<NormalizedOpportunity | null>;

  async run(options: ScraperRunOptions = {}): Promise<ScraperResult> {
    const started = Date.now();
    const errors: ScraperError[] = [];
    let recordsFound = 0;
    let recordsNew = 0;
    let recordsUpdated = 0;
    let recordsSkipped = 0;
    let runId: string | undefined;
    let jurisdictionId: string | undefined;

    const logger = (options.logger ?? log).child({
      scraper: this.jurisdictionSlug,
      source: this.sourceName,
    });

    try {
      const jurisdiction = await getJurisdictionBySlug(this.jurisdictionSlug);
      if (!jurisdiction) {
        throw new Error(
          `jurisdiction '${this.jurisdictionSlug}' not found — run db:seed first`,
        );
      }
      jurisdictionId = jurisdiction.id;
      runId = await startScraperRun(jurisdictionId);
      logger.info('scraper.started', { runId });

      const raws = await this.fetch();
      recordsFound = raws.length;
      logger.info('scraper.fetched', { recordsFound });

      for (const raw of raws) {
        try {
          const normalized = await this.parse(raw);
          if (!normalized) {
            recordsSkipped += 1;
            continue;
          }
          const outcome = await upsertOpportunity(jurisdictionId, this.jurisdictionSlug, normalized);
          if (outcome === 'inserted') recordsNew += 1;
          else if (outcome === 'updated') recordsUpdated += 1;
          else recordsSkipped += 1;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const stack = err instanceof Error ? err.stack : undefined;
          errors.push({
            message,
            stack,
            context: { sourceReferenceId: raw.sourceReferenceId, sourceUrl: raw.sourceUrl },
          });
          logger.warn('scraper.parse_error', { sourceReferenceId: raw.sourceReferenceId, message });
        }
      }

      const status: ScraperResult['status'] =
        errors.length === 0
          ? 'success'
          : errors.length < recordsFound
            ? 'partial'
            : 'failed';

      const durationMs = Date.now() - started;
      await finishScraperRun({
        runId,
        jurisdictionId,
        status,
        recordsFound,
        recordsNew,
        recordsUpdated,
        recordsSkipped,
        errors,
        durationMs,
        triggerRunId: options.triggerRunId,
      });
      logger.info('scraper.finished', {
        status,
        recordsFound,
        recordsNew,
        recordsUpdated,
        recordsSkipped,
        errorCount: errors.length,
        durationMs,
      });

      return {
        status,
        recordsFound,
        recordsNew,
        recordsUpdated,
        recordsSkipped,
        errors,
        durationMs,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      errors.push({ message, stack });
      const durationMs = Date.now() - started;
      logger.error('scraper.failed', { message, durationMs });
      if (runId && jurisdictionId) {
        await finishScraperRun({
          runId,
          jurisdictionId,
          status: 'failed',
          recordsFound,
          recordsNew,
          recordsUpdated,
          recordsSkipped,
          errors,
          durationMs,
          triggerRunId: options.triggerRunId,
        });
      }
      return {
        status: 'failed',
        recordsFound,
        recordsNew,
        recordsUpdated,
        recordsSkipped,
        errors,
        durationMs,
      };
    }
  }
}
