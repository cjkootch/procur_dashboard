import { and, eq } from 'drizzle-orm';
import {
  approvals,
  db,
  events,
  revenueAssumptions,
  type AssumptionStatusValue,
  type AssumptionSubjectTypeValue,
  type AssumptionTypeValue,
  ASSUMPTION_TYPES,
  ASSUMPTION_STATUSES,
  ASSUMPTION_SUBJECT_TYPES,
} from '@procur/db';
import { createId } from '../agents/id';

/**
 * Executors for Revenue Assumption Map approvals
 * (assumption.save_map + assumption.record_test). Both are T1 —
 * metadata writes only, no outbound side effects.
 */

interface ExecutorResult {
  ok: boolean;
  appliedObjectId?: string;
  error?: string;
}

async function alreadyApplied(approvalId: string): Promise<boolean> {
  const rows = await db
    .select({ appliedAt: approvals.appliedAt })
    .from(approvals)
    .where(eq(approvals.id, approvalId))
    .limit(1);
  return rows[0]?.appliedAt != null;
}

// ----------------------------------------------------------------------------
// assumption.save_map — bulk insert/update generated map
// ----------------------------------------------------------------------------

export interface SaveAssumptionMapPayload {
  subjectType: AssumptionSubjectTypeValue;
  subjectId: string;
  generatorVersion: string;
  assumptions: Array<{
    assumptionType: AssumptionTypeValue;
    assumptionText: string;
    confidenceScore: number;
    fastestTest?: string;
    riskIfFalse?: string;
    recommendedActionType?: string | null;
  }>;
  rationale: string;
}

export function parseSaveAssumptionMapPayload(
  proposedPayload: Record<string, unknown> | null | undefined,
): SaveAssumptionMapPayload | null {
  if (!proposedPayload || typeof proposedPayload !== 'object') return null;
  const subjectType = proposedPayload['subjectType'];
  const subjectId = proposedPayload['subjectId'];
  const generatorVersion = proposedPayload['generatorVersion'];
  const assumptionsRaw = proposedPayload['assumptions'];
  const rationale = proposedPayload['rationale'];
  if (
    typeof subjectType !== 'string' ||
    !ASSUMPTION_SUBJECT_TYPES.includes(subjectType as AssumptionSubjectTypeValue) ||
    typeof subjectId !== 'string' ||
    typeof generatorVersion !== 'string' ||
    typeof rationale !== 'string' ||
    !Array.isArray(assumptionsRaw) ||
    assumptionsRaw.length === 0
  ) {
    return null;
  }
  const assumptions: SaveAssumptionMapPayload['assumptions'] = [];
  for (const a of assumptionsRaw) {
    if (!a || typeof a !== 'object') continue;
    const r = a as Record<string, unknown>;
    if (
      typeof r['assumptionType'] !== 'string' ||
      !ASSUMPTION_TYPES.includes(r['assumptionType'] as AssumptionTypeValue) ||
      typeof r['assumptionText'] !== 'string' ||
      typeof r['confidenceScore'] !== 'number'
    ) {
      continue;
    }
    assumptions.push({
      assumptionType: r['assumptionType'] as AssumptionTypeValue,
      assumptionText: r['assumptionText'] as string,
      confidenceScore: Math.max(
        0,
        Math.min(100, Math.round(r['confidenceScore'] as number)),
      ),
      ...(typeof r['fastestTest'] === 'string'
        ? { fastestTest: r['fastestTest'] as string }
        : {}),
      ...(typeof r['riskIfFalse'] === 'string'
        ? { riskIfFalse: r['riskIfFalse'] as string }
        : {}),
      ...(typeof r['recommendedActionType'] === 'string'
        ? { recommendedActionType: r['recommendedActionType'] as string }
        : r['recommendedActionType'] === null
          ? { recommendedActionType: null }
          : {}),
    });
  }
  if (assumptions.length === 0) return null;
  return {
    subjectType: subjectType as AssumptionSubjectTypeValue,
    subjectId,
    generatorVersion,
    assumptions,
    rationale,
  };
}

/**
 * Find an existing assumption row by composite key
 * (subject_type, subject_id, assumption_type). Returns the row id
 * when found, null otherwise. One assumption-of-each-type per subject;
 * re-saving with the same type updates in place.
 */
async function findExistingAssumption(
  subjectType: AssumptionSubjectTypeValue,
  subjectId: string,
  assumptionType: AssumptionTypeValue,
): Promise<string | null> {
  const rows = await db
    .select({ id: revenueAssumptions.id })
    .from(revenueAssumptions)
    .where(
      and(
        eq(revenueAssumptions.subjectType, subjectType),
        eq(revenueAssumptions.subjectId, subjectId),
        eq(revenueAssumptions.assumptionType, assumptionType),
      ),
    )
    .limit(1);
  return rows[0]?.id ?? null;
}

/**
 * Bulk upsert assumption rows for a subject. Idempotent on the
 * approval row (short-circuits via applied_at) and on the (subject,
 * type) tuple inside the loop (existing rows update instead of
 * duplicating). Stamps `applied_at` + emits a single
 * `assumption.map_saved` audit event with the count.
 */
export async function applySaveAssumptionMap(
  approvalId: string,
  payload: SaveAssumptionMapPayload,
  reviewerId: string | null,
): Promise<ExecutorResult> {
  if (await alreadyApplied(approvalId)) return { ok: true };

  const occurredAt = new Date();
  let inserted = 0;
  let updated = 0;
  for (const a of payload.assumptions) {
    const existingId = await findExistingAssumption(
      payload.subjectType,
      payload.subjectId,
      a.assumptionType,
    );
    if (existingId) {
      await db
        .update(revenueAssumptions)
        .set({
          assumptionText: a.assumptionText,
          confidenceScore: a.confidenceScore,
          ...(a.fastestTest !== undefined ? { fastestTest: a.fastestTest } : {}),
          ...(a.riskIfFalse !== undefined ? { riskIfFalse: a.riskIfFalse } : {}),
          ...(a.recommendedActionType !== undefined
            ? { recommendedActionType: a.recommendedActionType }
            : {}),
          generatorVersion: payload.generatorVersion,
          updatedAt: occurredAt,
        })
        .where(eq(revenueAssumptions.id, existingId));
      updated += 1;
    } else {
      await db.insert(revenueAssumptions).values({
        id: createId(),
        subjectType: payload.subjectType,
        subjectId: payload.subjectId,
        assumptionType: a.assumptionType,
        assumptionText: a.assumptionText,
        confidenceScore: a.confidenceScore,
        ...(a.fastestTest ? { fastestTest: a.fastestTest } : {}),
        ...(a.riskIfFalse ? { riskIfFalse: a.riskIfFalse } : {}),
        ...(a.recommendedActionType !== undefined
          ? { recommendedActionType: a.recommendedActionType }
          : {}),
        generatorVersion: payload.generatorVersion,
        createdBy: reviewerId,
      });
      inserted += 1;
    }
  }

  await db
    .update(approvals)
    .set({ appliedObjectId: payload.subjectId, appliedAt: occurredAt })
    .where(eq(approvals.id, approvalId));
  await db
    .insert(events)
    .values({
      id: createId(),
      verb: 'assumption.map_saved',
      subjectType: 'approval',
      subjectId: approvalId,
      actorType: 'system',
      actorId: 'revenue-assumptions-executor',
      objectType: payload.subjectType,
      objectId: payload.subjectId,
      occurredAt,
      idempotencyKey: `assumption.map_saved:${approvalId}`,
      metadata: {
        subject_type: payload.subjectType,
        subject_id: payload.subjectId,
        generator_version: payload.generatorVersion,
        assumptions_inserted: inserted,
        assumptions_updated: updated,
        assumptions_total: payload.assumptions.length,
      },
    })
    .onConflictDoNothing({
      target: [events.occurredAt, events.idempotencyKey],
    });

  return { ok: true, appliedObjectId: payload.subjectId };
}

// ----------------------------------------------------------------------------
// assumption.record_test — single-row test result write
// ----------------------------------------------------------------------------

export interface RecordAssumptionTestPayload {
  assumptionId: string;
  status: AssumptionStatusValue;
  result: string;
  confidenceScore?: number;
  resultEvidence?: Record<string, unknown>;
  rationale: string;
}

export function parseRecordAssumptionTestPayload(
  proposedPayload: Record<string, unknown> | null | undefined,
): RecordAssumptionTestPayload | null {
  if (!proposedPayload || typeof proposedPayload !== 'object') return null;
  const assumptionId = proposedPayload['assumptionId'];
  const status = proposedPayload['status'];
  const result = proposedPayload['result'];
  const rationale = proposedPayload['rationale'];
  if (
    typeof assumptionId !== 'string' ||
    typeof status !== 'string' ||
    !ASSUMPTION_STATUSES.includes(status as AssumptionStatusValue) ||
    typeof result !== 'string' ||
    typeof rationale !== 'string'
  ) {
    return null;
  }
  const out: RecordAssumptionTestPayload = {
    assumptionId,
    status: status as AssumptionStatusValue,
    result,
    rationale,
  };
  if (typeof proposedPayload['confidenceScore'] === 'number') {
    out.confidenceScore = Math.max(
      0,
      Math.min(100, Math.round(proposedPayload['confidenceScore'] as number)),
    );
  }
  if (
    proposedPayload['resultEvidence'] &&
    typeof proposedPayload['resultEvidence'] === 'object' &&
    !Array.isArray(proposedPayload['resultEvidence'])
  ) {
    out.resultEvidence = proposedPayload['resultEvidence'] as Record<
      string,
      unknown
    >;
  }
  return out;
}

export async function applyRecordAssumptionTest(
  approvalId: string,
  payload: RecordAssumptionTestPayload,
): Promise<ExecutorResult> {
  if (await alreadyApplied(approvalId)) return { ok: true };

  const occurredAt = new Date();
  await db
    .update(revenueAssumptions)
    .set({
      status: payload.status,
      result: payload.result,
      ...(payload.confidenceScore !== undefined
        ? { confidenceScore: payload.confidenceScore }
        : {}),
      ...(payload.resultEvidence
        ? { resultEvidence: payload.resultEvidence }
        : {}),
      testedAt: occurredAt,
      updatedAt: occurredAt,
    })
    .where(eq(revenueAssumptions.id, payload.assumptionId));

  await db
    .update(approvals)
    .set({ appliedObjectId: payload.assumptionId, appliedAt: occurredAt })
    .where(eq(approvals.id, approvalId));

  await db
    .insert(events)
    .values({
      id: createId(),
      verb: 'assumption.tested',
      subjectType: 'approval',
      subjectId: approvalId,
      actorType: 'system',
      actorId: 'revenue-assumptions-executor',
      objectType: 'revenue_assumption',
      objectId: payload.assumptionId,
      occurredAt,
      idempotencyKey: `assumption.tested:${approvalId}`,
      metadata: {
        assumption_id: payload.assumptionId,
        status: payload.status,
        confidence_score: payload.confidenceScore ?? null,
      },
    })
    .onConflictDoNothing({
      target: [events.occurredAt, events.idempotencyKey],
    });

  return { ok: true, appliedObjectId: payload.assumptionId };
}
