import 'server-only';
import {
  achievementsEarned,
  db,
  users,
  xpLedger,
  type NewXpLedgerRow,
} from '@procur/db';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { pgArray } from '../queries';
import { xpRuleFor } from './xp-rules';

export interface BackfillSummary {
  rowsScanned: number;
  rowsCredited: number;
  totalXpCredited: number;
  attributedToUserId: string;
}

/**
 * One-shot scanner that replays historical activity into the XP
 * ledger. Idempotent on `(source_table, source_id, verb)` via the
 * unique partial index on xp_ledger — re-running is safe (the
 * conflicting rows just don't insert).
 *
 * Single-user lock-in (Phase 0): all credit goes to the first
 * `users` row with a non-null company_id. When multi-user lands,
 * this function should accept a per-source attribution map
 * (events.actorId → user when it parses as UUID, fall back to a
 * default operator).
 *
 * Sources scanned:
 *   - events (outreach.* verbs)
 *   - feedback_events (kind → feedback.<kind>)
 *   - extracted_entities (resolved_entity_slug non-null → mention.resolved)
 *   - deal_retrospectives (completed_at non-null → retrospective.completed)
 *   - supplier_approvals (status in approved/rejected → kyc.<status>)
 */
export async function backfillGamificationLedger(): Promise<BackfillSummary> {
  const operator = await db
    .select({ id: users.id })
    .from(users)
    .where(isNotNull(users.companyId))
    .orderBy(users.createdAt)
    .limit(1);
  const userId = operator[0]?.id;
  if (!userId) {
    throw new Error('backfill: no operator user (users.companyId is null for all rows)');
  }

  let rowsScanned = 0;
  let rowsCredited = 0;
  let totalXpCredited = 0;

  // 1. Outreach lifecycle from events table.
  const outreachVerbs = [
    'outreach.proposed',
    'outreach.approved',
    'outreach.sent',
    'outreach.replied',
    'outreach.meeting_booked',
    'outreach.converted_to_lead',
    'outreach.converted_to_deal',
    'outreach.disqualified',
  ];
  const outreachRows = await db.execute<{
    id: string;
    verb: string;
    occurred_at: Date;
  }>(sql`
    SELECT id, verb, occurred_at
    FROM events
    WHERE verb = ANY(${pgArray(outreachVerbs)})
    ORDER BY occurred_at
  `);
  for (const r of outreachRows.rows) {
    rowsScanned += 1;
    const rule = xpRuleFor(r.verb);
    if (!rule || rule.points === 0) continue;
    const occurredAt =
      r.occurred_at instanceof Date ? r.occurred_at : new Date(r.occurred_at);
    const inserted = await insertCredit({
      userId,
      eventId: r.id,
      sourceTable: 'events',
      sourceId: r.id,
      verb: r.verb,
      points: rule.points,
      reason: rule.reason,
      occurredAt,
    });
    if (inserted) {
      rowsCredited += 1;
      totalXpCredited += rule.points;
    }
  }

  // 2. Feedback events.
  const feedbackRows = await db.execute<{
    id: string;
    kind: string;
    created_at: Date;
  }>(sql`
    SELECT id, kind, created_at
    FROM feedback_events
    WHERE revoked_at IS NULL
    ORDER BY created_at
  `);
  for (const r of feedbackRows.rows) {
    rowsScanned += 1;
    const verb = `feedback.${r.kind}`;
    const rule = xpRuleFor(verb);
    if (!rule || rule.points === 0) continue;
    const occurredAt =
      r.created_at instanceof Date ? r.created_at : new Date(r.created_at);
    const inserted = await insertCredit({
      userId,
      eventId: null,
      sourceTable: 'feedback_events',
      sourceId: r.id,
      verb,
      points: rule.points,
      reason: rule.reason,
      occurredAt,
    });
    if (inserted) {
      rowsCredited += 1;
      totalXpCredited += rule.points;
    }
  }

  // 3. Mention resolutions.
  const mentionRows = await db.execute<{ id: string; updated_at: Date }>(sql`
    SELECT id, updated_at
    FROM extracted_entities
    WHERE resolved_entity_slug IS NOT NULL
    ORDER BY updated_at
  `);
  const mentionRule = xpRuleFor('mention.resolved');
  if (mentionRule && mentionRule.points > 0) {
    for (const r of mentionRows.rows) {
      rowsScanned += 1;
      const occurredAt =
        r.updated_at instanceof Date ? r.updated_at : new Date(r.updated_at);
      const inserted = await insertCredit({
        userId,
        eventId: null,
        sourceTable: 'extracted_entities',
        sourceId: r.id,
        verb: 'mention.resolved',
        points: mentionRule.points,
        reason: mentionRule.reason,
        occurredAt,
      });
      if (inserted) {
        rowsCredited += 1;
        totalXpCredited += mentionRule.points;
      }
    }
  }

  // 4. Completed deal retrospectives.
  const retroRows = await db.execute<{
    id: string;
    completed_at: Date;
  }>(sql`
    SELECT id, completed_at
    FROM deal_retrospectives
    WHERE completed_at IS NOT NULL
    ORDER BY completed_at
  `);
  const retroRule = xpRuleFor('retrospective.completed');
  if (retroRule && retroRule.points > 0) {
    for (const r of retroRows.rows) {
      rowsScanned += 1;
      const occurredAt =
        r.completed_at instanceof Date
          ? r.completed_at
          : new Date(r.completed_at);
      const inserted = await insertCredit({
        userId,
        eventId: null,
        sourceTable: 'deal_retrospectives',
        sourceId: r.id,
        verb: 'retrospective.completed',
        points: retroRule.points,
        reason: retroRule.reason,
        occurredAt,
      });
      if (inserted) {
        rowsCredited += 1;
        totalXpCredited += retroRule.points;
      }
    }
  }

  // 5. Supplier approval status milestones. We award once per row's
  // current status — a row that flipped through multiple states will
  // only reflect its latest. Acceptable for backfill; live awards
  // (via the upsertSupplierApproval hook) capture every transition
  // going forward.
  const kycVerbMap: Record<string, string> = {
    approved_with_kyc: 'kyc.approved_with_kyc',
    approved_without_kyc: 'kyc.approved_without_kyc',
    rejected: 'kyc.rejected',
  };
  const supplierRows = await db.execute<{
    id: string;
    status: string;
    updated_at: Date;
  }>(sql`
    SELECT id, status, updated_at
    FROM supplier_approvals
    WHERE status IN ('approved_with_kyc', 'approved_without_kyc', 'rejected')
    ORDER BY updated_at
  `);
  for (const r of supplierRows.rows) {
    rowsScanned += 1;
    const verb = kycVerbMap[r.status];
    if (!verb) continue;
    const rule = xpRuleFor(verb);
    if (!rule || rule.points === 0) continue;
    const occurredAt =
      r.updated_at instanceof Date ? r.updated_at : new Date(r.updated_at);
    const inserted = await insertCredit({
      userId,
      eventId: null,
      sourceTable: 'supplier_approvals',
      sourceId: r.id,
      verb,
      points: rule.points,
      reason: rule.reason,
      occurredAt,
    });
    if (inserted) {
      rowsCredited += 1;
      totalXpCredited += rule.points;
    }
  }

  return {
    rowsScanned,
    rowsCredited,
    totalXpCredited,
    attributedToUserId: userId,
  };
}

async function insertCredit(input: NewXpLedgerRow): Promise<boolean> {
  // Partial unique index — see award.ts insertCredit for the full
  // explanation. Mirrored here so the backfill matches the partial
  // predicate at the index level and re-running is genuinely safe.
  const inserted = await db
    .insert(xpLedger)
    .values(input)
    .onConflictDoNothing({
      target: [xpLedger.sourceTable, xpLedger.sourceId, xpLedger.verb],
      where: sql`${xpLedger.sourceTable} IS NOT NULL AND ${xpLedger.sourceId} IS NOT NULL`,
    })
    .returning({ id: xpLedger.id });
  return inserted.length > 0;
}

// Suppress unused-import lint on the achievements table — it's
// imported here so backfill scripts can extend this module to seed
// achievements_earned in a follow-up commit (Slice 3).
void achievementsEarned;
