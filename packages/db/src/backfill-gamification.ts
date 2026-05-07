/**
 * One-shot script: replay historical activity into the gamification
 * XP ledger so the operator opens the topbar chip with their full
 * lifetime progress already credited (rather than starting at Level 1
 * with 0 XP on the day the feature ships).
 *
 * Idempotent on `(source_table, source_id, verb)` via the unique
 * partial index on xp_ledger — re-running is safe.
 *
 * Run from repo root:
 *   pnpm --filter @procur/db backfill-gamification
 *
 * Self-contained: deliberately does NOT import from @procur/catalog
 * even though the live awardXp path lives there. Avoids the
 * @procur/db → @procur/catalog → @procur/db workspace cycle that
 * would form. The verb-to-rule mapping below is a duplicate of the
 * one in packages/catalog/src/gamification/xp-rules.ts and must
 * stay in sync — keep both lists in lockstep when adding new verbs.
 */
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { isNotNull, sql } from 'drizzle-orm';
import * as schema from './schema';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
loadEnv({ path: path.join(__dirname, '..', '..', '..', '.env.local') });

interface XpRule {
  reason: string;
  points: number;
}

// Mirror of packages/catalog/src/gamification/xp-rules.ts. KEEP IN SYNC.
const RULES: Record<string, XpRule> = {
  'outreach.proposed': { reason: 'Outreach drafted', points: 2 },
  'outreach.approved': { reason: 'Outreach approved', points: 5 },
  'outreach.sent': { reason: 'Outreach sent', points: 5 },
  'outreach.replied': { reason: 'Outreach replied', points: 25 },
  'outreach.meeting_booked': { reason: 'Meeting booked', points: 50 },
  'outreach.converted_to_lead': { reason: 'Converted to lead', points: 75 },
  'outreach.converted_to_deal': { reason: 'Converted to deal', points: 200 },
  'outreach.disqualified': { reason: 'Outreach disqualified', points: 10 },
  'feedback.match_quality': { reason: 'Match feedback', points: 10 },
  'feedback.entity_attribute': { reason: 'Entity attribute corrected', points: 15 },
  'feedback.disposition': { reason: 'Deal outcome tagged', points: 20 },
  'feedback.friction': { reason: 'Friction logged', points: 10 },
  'mention.resolved': { reason: 'Mention resolved', points: 15 },
  'retrospective.completed': { reason: 'Retrospective submitted', points: 100 },
  'kyc.approved_with_kyc': { reason: 'KYC approved', points: 100 },
  'kyc.approved_without_kyc': { reason: 'Supplier approved (no KYC)', points: 50 },
  'kyc.rejected': { reason: 'Supplier rejected', points: 25 },
};

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL not set');
  }
  const client = neon(databaseUrl);
  const db = drizzle(client, { schema });

  // Resolve the operator user (Phase 0: single-user — pull the
  // oldest user with a non-null company_id).
  const operator = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(isNotNull(schema.users.companyId))
    .orderBy(schema.users.createdAt)
    .limit(1);
  const operatorId = operator[0]?.id;
  if (!operatorId) {
    throw new Error('backfill: no operator user (users.companyId null for all rows)');
  }
  const userId: string = operatorId;

  let rowsScanned = 0;
  let rowsCredited = 0;
  let totalXpCredited = 0;

  async function insertCredit(input: {
    eventId: string | null;
    sourceTable: string;
    sourceId: string;
    verb: string;
    points: number;
    reason: string;
    occurredAt: Date;
  }): Promise<boolean> {
    const inserted = await db
      .insert(schema.xpLedger)
      .values({
        userId,
        eventId: input.eventId,
        sourceTable: input.sourceTable,
        sourceId: input.sourceId,
        verb: input.verb,
        points: input.points,
        reason: input.reason,
        occurredAt: input.occurredAt,
      })
      .onConflictDoNothing({
        target: [
          schema.xpLedger.sourceTable,
          schema.xpLedger.sourceId,
          schema.xpLedger.verb,
        ],
      })
      .returning({ id: schema.xpLedger.id });
    return inserted.length > 0;
  }

  // 1. Outreach lifecycle from events. Using `sql.join` to splay the
  // verb list into an IN (...) expression — a bare JS-array
  // interpolation gets wrapped as a record by Drizzle's tagged
  // template and `::text[]` rejects the cast (NeonDbError 42846).
  const outreachVerbs = Object.keys(RULES).filter((v) => v.startsWith('outreach.'));
  const outreachVerbsSql = sql.join(
    outreachVerbs.map((v) => sql`${v}`),
    sql`, `,
  );
  const outreachRows = await db.execute<{
    id: string;
    verb: string;
    occurred_at: Date;
  }>(sql`
    SELECT id, verb, occurred_at
    FROM events
    WHERE verb IN (${outreachVerbsSql})
    ORDER BY occurred_at
  `);
  for (const r of outreachRows.rows) {
    rowsScanned += 1;
    const rule = RULES[r.verb];
    if (!rule) continue;
    const occurredAt =
      r.occurred_at instanceof Date ? r.occurred_at : new Date(r.occurred_at);
    if (
      await insertCredit({
        eventId: r.id,
        sourceTable: 'events',
        sourceId: r.id,
        verb: r.verb,
        points: rule.points,
        reason: rule.reason,
        occurredAt,
      })
    ) {
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
    const rule = RULES[verb];
    if (!rule) continue;
    const occurredAt =
      r.created_at instanceof Date ? r.created_at : new Date(r.created_at);
    if (
      await insertCredit({
        eventId: null,
        sourceTable: 'feedback_events',
        sourceId: r.id,
        verb,
        points: rule.points,
        reason: rule.reason,
        occurredAt,
      })
    ) {
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
  const mentionRule = RULES['mention.resolved']!;
  for (const r of mentionRows.rows) {
    rowsScanned += 1;
    const occurredAt =
      r.updated_at instanceof Date ? r.updated_at : new Date(r.updated_at);
    if (
      await insertCredit({
        eventId: null,
        sourceTable: 'extracted_entities',
        sourceId: r.id,
        verb: 'mention.resolved',
        points: mentionRule.points,
        reason: mentionRule.reason,
        occurredAt,
      })
    ) {
      rowsCredited += 1;
      totalXpCredited += mentionRule.points;
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
  const retroRule = RULES['retrospective.completed']!;
  for (const r of retroRows.rows) {
    rowsScanned += 1;
    const occurredAt =
      r.completed_at instanceof Date
        ? r.completed_at
        : new Date(r.completed_at);
    if (
      await insertCredit({
        eventId: null,
        sourceTable: 'deal_retrospectives',
        sourceId: r.id,
        verb: 'retrospective.completed',
        points: retroRule.points,
        reason: retroRule.reason,
        occurredAt,
      })
    ) {
      rowsCredited += 1;
      totalXpCredited += retroRule.points;
    }
  }

  // 5. Supplier approvals — current-status snapshot.
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
    const verb = `kyc.${r.status}`;
    const rule = RULES[verb];
    if (!rule) continue;
    const occurredAt =
      r.updated_at instanceof Date ? r.updated_at : new Date(r.updated_at);
    if (
      await insertCredit({
        eventId: null,
        sourceTable: 'supplier_approvals',
        sourceId: r.id,
        verb,
        points: rule.points,
        reason: rule.reason,
        occurredAt,
      })
    ) {
      rowsCredited += 1;
      totalXpCredited += rule.points;
    }
  }

  console.log('[backfill-gamification] complete', {
    rowsScanned,
    rowsCredited,
    totalXpCredited,
    attributedToUserId: userId,
  });
}

main().catch((err) => {
  console.error('[backfill-gamification] failed', err);
  process.exit(1);
});
