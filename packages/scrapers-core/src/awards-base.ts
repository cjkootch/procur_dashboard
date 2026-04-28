import { log, type Logger } from '@procur/utils/logger';
import {
  finishScraperRun,
  getJurisdictionBySlug,
  startScraperRun,
} from './upsert';
import {
  upsertAward,
  upsertExternalSupplier,
  upsertSupplierAlias,
  linkAwardAwardee,
  type UpsertAwardInput,
  type UpsertExternalSupplierInput,
} from './awards-upsert';
import type { ScraperError, ScraperResult } from './types';

export type AwardsExtractorRunOptions = {
  triggerRunId?: string;
  logger?: Logger;
};

/**
 * One normalized award row + its awardees, ready for upsert. Mirrors
 * the OCDS shape collapsed for the supplier-graph schema:
 *
 *   - one award (sourcePortal + sourceAwardId)
 *   - 1..N awardees (per-supplier link with role + optional consortium share)
 *
 * Each awardee carries its own external_suppliers + supplier_aliases
 * payload so the extractor can resolve and upsert in one pass.
 */
export type NormalizedAward = {
  award: Omit<UpsertAwardInput, 'jurisdictionId'>;
  awardees: Array<{
    supplier: Omit<UpsertExternalSupplierInput, 'jurisdictionId'>;
    role?: 'prime' | 'subcontractor' | 'consortium_member' | 'consortium_lead';
    sharePct?: number | null;
    /** Verbatim portal-source name(s) to alias against the canonical supplier. */
    aliases?: string[];
  }>;
};

/**
 * Sister to TenderScraper but for backward-looking award data — the
 * supplier-graph upsert pipeline. Subclasses produce a stream of
 * `NormalizedAward` rows; the base handles run tracking, jurisdiction
 * lookup, error accumulation, and ordered upserts (suppliers + aliases
 * first, then awards, then award_awardees).
 *
 * Why a separate base from TenderScraper:
 *  - Different cadence (monthly OCDS bulk vs hourly HTML)
 *  - Different target tables (awards + award_awardees vs opportunities)
 *  - Awardees vary per row (1..N), unlike the 1:1 raw→opportunity case
 *
 * Subclasses implement `streamAwards()` which yields normalized rows.
 * Streaming (vs return-array) matters because OCDS bulk files for a
 * full year can be 100k+ rows; loading them all into memory before
 * upserting risks OOM in trigger.dev workers (1GB limit).
 */
export abstract class AwardsExtractor {
  abstract readonly jurisdictionSlug: string;
  abstract readonly sourcePortal: string;

  /**
   * Async iterator over normalized awards. Subclasses do the
   * portal-specific download + parse + filter; the base just consumes
   * and upserts.
   */
  abstract streamAwards(): AsyncIterable<NormalizedAward>;

  async run(options: AwardsExtractorRunOptions = {}): Promise<ScraperResult> {
    const started = Date.now();
    const errors: ScraperError[] = [];
    let recordsFound = 0;
    let recordsNew = 0;
    let recordsUpdated = 0;
    let recordsSkipped = 0;
    let runId: string | undefined;
    let jurisdictionId: string | undefined;

    const logger = (options.logger ?? log).child({
      extractor: this.jurisdictionSlug,
      source: this.sourcePortal,
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
      logger.info('awards.started', { runId });

      for await (const normalized of this.streamAwards()) {
        recordsFound += 1;
        try {
          // Resolve all awardees first so award_awardees has FKs to
          // hit. Aliases come along for the ride.
          const awardeeIds: Array<{
            supplierId: string;
            role?: NormalizedAward['awardees'][number]['role'];
            sharePct?: number | null;
          }> = [];
          for (const a of normalized.awardees) {
            const supplierId = await upsertExternalSupplier({
              ...a.supplier,
              jurisdictionId,
            });
            for (const alias of a.aliases ?? [a.supplier.organisationName]) {
              await upsertSupplierAlias({
                supplierId,
                alias,
                sourcePortal: this.sourcePortal,
                confidence: 1.0,
                verified: true,
              });
            }
            awardeeIds.push({ supplierId, role: a.role, sharePct: a.sharePct });
          }

          const { awardId, outcome } = await upsertAward({
            ...normalized.award,
            jurisdictionId,
          });

          for (const ae of awardeeIds) {
            await linkAwardAwardee({
              awardId,
              supplierId: ae.supplierId,
              role: ae.role,
              sharePct: ae.sharePct ?? null,
            });
          }

          if (outcome === 'inserted') recordsNew += 1;
          else recordsUpdated += 1;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const stack = err instanceof Error ? err.stack : undefined;
          errors.push({
            message,
            stack,
            context: {
              sourceAwardId: normalized.award.sourceAwardId,
              sourcePortal: this.sourcePortal,
            },
          });
          recordsSkipped += 1;
          logger.warn('awards.upsert_error', {
            sourceAwardId: normalized.award.sourceAwardId,
            message,
          });
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
      logger.info('awards.finished', {
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
        insertedIds: [],
        errors,
        durationMs,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      errors.push({ message, stack });
      const durationMs = Date.now() - started;
      logger.error('awards.failed', { message, durationMs });
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
        insertedIds: [],
        errors,
        durationMs,
      };
    }
  }
}
