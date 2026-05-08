import 'server-only';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  agentRuns,
  approvals,
  costLedger,
  db,
  events,
  feedbackEvents,
  marketProbes,
} from '@procur/db';
import { ActionDescriptor, createId, type ActionDescriptorT } from '@procur/ai';
import {
  buildOutreachFeatures,
  recordOutreachFeatureSnapshot,
} from './outreach-features';

/**
 * Read/write helpers for the agent runtime (vex-into-procur merge
 * Phase 2). Pairs with the AgentRunner + ApprovalGate in @procur/ai;
 * those write rows, these read them for the approval-queue UI and
 * (later phases) the executor service.
 */

export interface AgentRunListRow {
  id: string;
  agentName: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  costUsd: number;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  error: string | null;
  outputRefs: Record<string, unknown>;
}

export async function listAgentRuns(
  options: {
    status?: 'pending' | 'running' | 'completed' | 'failed';
    limit?: number;
  } = {},
): Promise<AgentRunListRow[]> {
  const limit = options.limit ?? 50;
  const rows = await db
    .select({
      id: agentRuns.id,
      agentName: agentRuns.agentName,
      status: agentRuns.status,
      costUsd: agentRuns.costUsd,
      startedAt: agentRuns.startedAt,
      finishedAt: agentRuns.finishedAt,
      createdAt: agentRuns.createdAt,
      error: agentRuns.error,
      outputRefs: agentRuns.outputRefs,
    })
    .from(agentRuns)
    .where(options.status ? eq(agentRuns.status, options.status) : undefined)
    .orderBy(desc(agentRuns.createdAt))
    .limit(limit);
  return rows as AgentRunListRow[];
}

export interface ApprovalListRow {
  id: string;
  agentRunId: string | null;
  actionType: string;
  decision: 'pending' | 'approved' | 'rejected' | 'auto_approved';
  proposedPayload: Record<string, unknown>;
  reviewerId: string | null;
  decidedAt: Date | null;
  appliedObjectId: string | null;
  appliedAt: Date | null;
  createdAt: Date;
}

export async function listPendingApprovals(
  options: { limit?: number } = {},
): Promise<ApprovalListRow[]> {
  const limit = options.limit ?? 20;
  const rows = await db
    .select({
      id: approvals.id,
      agentRunId: approvals.agentRunId,
      actionType: approvals.actionType,
      decision: approvals.decision,
      proposedPayload: approvals.proposedPayload,
      reviewerId: approvals.reviewerId,
      decidedAt: approvals.decidedAt,
      appliedObjectId: approvals.appliedObjectId,
      appliedAt: approvals.appliedAt,
      createdAt: approvals.createdAt,
    })
    .from(approvals)
    .where(eq(approvals.decision, 'pending'))
    .orderBy(desc(approvals.createdAt))
    .limit(limit);
  return rows as ApprovalListRow[];
}

export async function getApproval(
  id: string,
): Promise<ApprovalListRow | null> {
  const rows = await db
    .select({
      id: approvals.id,
      agentRunId: approvals.agentRunId,
      actionType: approvals.actionType,
      decision: approvals.decision,
      proposedPayload: approvals.proposedPayload,
      reviewerId: approvals.reviewerId,
      decidedAt: approvals.decidedAt,
      appliedObjectId: approvals.appliedObjectId,
      appliedAt: approvals.appliedAt,
      createdAt: approvals.createdAt,
    })
    .from(approvals)
    .where(eq(approvals.id, id))
    .limit(1);
  return (rows[0] as ApprovalListRow | undefined) ?? null;
}

/**
 * Record a reviewer's decision. Idempotent on the (id, decision)
 * pair — re-applying the same decision is a no-op. Emits an
 * `approval.decided` audit event into the partitioned events table.
 */
export async function recordApprovalDecision(
  id: string,
  input: {
    decision: 'approved' | 'rejected' | 'auto_approved';
    reviewerId?: string | null;
  },
): Promise<{ updated: boolean; row: ApprovalListRow | null }> {
  const now = new Date();
  const updated = await db
    .update(approvals)
    .set({
      decision: input.decision,
      reviewerId: input.reviewerId ?? null,
      decidedAt: now,
    })
    .where(and(eq(approvals.id, id), eq(approvals.decision, 'pending')))
    .returning({ id: approvals.id });

  const row = await getApproval(id);

  if (updated.length > 0 && row) {
    await db
      .insert(events)
      .values({
        id: createId(),
        verb: `approval.${input.decision}`,
        subjectType: 'approval',
        subjectId: id,
        actorType: input.reviewerId ? 'user' : 'system',
        actorId: input.reviewerId ?? 'system',
        objectType: 'approval',
        objectId: id,
        occurredAt: now,
        idempotencyKey: `approval.${input.decision}:${id}`,
        metadata: { action_type: row.actionType },
      })
      .onConflictDoNothing({
        target: [events.occurredAt, events.idempotencyKey],
      });
  }

  return { updated: updated.length > 0, row };
}

/**
 * Edit a single field on a pending approval's `proposed_payload` and
 * record the before/after to `feedback_events` for later fine-tuning
 * (operator's voice on a given action type — what the model drafted
 * vs what the operator actually wanted to send).
 *
 * Refuses non-pending approvals so a half-fired SMS can't be
 * silently retconned. The whitelist of editable fields lives client-
 * side per action type; the server validates that the field is one
 * of `body / subject / aiInstructions / goalHint` (the four free-
 * text fields that cover sms / email / call). Other fields are
 * structural and not editable from the chat preview.
 */
export async function editApprovalPayloadField(input: {
  approvalId: string;
  field: 'body' | 'subject' | 'aiInstructions' | 'goalHint';
  value: string;
  userId: string | null;
}): Promise<
  | { ok: true; row: ApprovalListRow }
  | { ok: false; reason: 'not_found' | 'not_pending' | 'unchanged' }
> {
  const existing = await getApproval(input.approvalId);
  if (!existing) return { ok: false, reason: 'not_found' };
  if (existing.decision !== 'pending') {
    return { ok: false, reason: 'not_pending' };
  }
  const before = existing.proposedPayload[input.field];
  if (typeof before === 'string' && before === input.value) {
    return { ok: false, reason: 'unchanged' };
  }
  const nextPayload = {
    ...existing.proposedPayload,
    [input.field]: input.value,
  };
  await db
    .update(approvals)
    .set({ proposedPayload: nextPayload })
    .where(
      and(
        eq(approvals.id, input.approvalId),
        eq(approvals.decision, 'pending'),
      ),
    );
  // Training signal: record the operator's revision so we can later
  // fine-tune the model on (action_type + draft → preferred phrasing).
  // sentiment is left null — the brief's enum doesn't have an "edit"
  // value; the kind alone is enough to query.
  await db.insert(feedbackEvents).values({
    userId: input.userId ?? null,
    feedbackKind: 'communication_edit',
    targetType: 'approval',
    targetId: input.approvalId,
    payload: {
      action_type: existing.actionType,
      field: input.field,
      before: typeof before === 'string' ? before : null,
      after: input.value,
    },
  });
  const updated = await getApproval(input.approvalId);
  if (!updated) return { ok: false, reason: 'not_found' };
  return { ok: true, row: updated };
}

/**
 * Translate one free-text field on a pending approval's payload to a
 * target language and persist BOTH versions — the wire copy goes
 * into the field; the operator's original is preserved on
 * payload.translation_audit so the approval card can render
 * "Original (en): ..." alongside the translated body.
 *
 * Memory shape on the payload:
 *   translation_audit: [
 *     {
 *       field: 'body' | 'subject',
 *       original_text: string,
 *       translation: string,
 *       source_language: 'en',
 *       target_language: 'ja',
 *       translated_at: ISO string,
 *     },
 *     ...
 *   ]
 *
 * Multiple translations append rather than replace — operator can
 * iterate (translate to JP, change mind, translate to KO) and the
 * audit trail reflects the sequence. Latest entry per field is what
 * the UI surfaces as "the operator's original."
 *
 * Probe-aware: when the approval payload carries market_probe_id
 * (autopilot-inserted approvals do), the helper reads the probe's
 * formality_level + domain_hint and passes them to the translator
 * so the wire copy honors the same steering used elsewhere.
 *
 * Idempotent on (approval_id, decision='pending'): rejected /
 * approved approvals can't be retranslated. No-translation-needed
 * (operator already wrote in the target language) returns ok with
 * translated=false; the field is unchanged.
 */
export async function translateApprovalField(input: {
  approvalId: string;
  field: 'body' | 'subject';
  targetLanguage: string;
  userId: string | null;
}): Promise<
  | {
      ok: true;
      row: ApprovalListRow;
      translated: boolean;
      sourceLanguage: string;
    }
  | {
      ok: false;
      reason:
        | 'not_found'
        | 'not_pending'
        | 'field_empty'
        | 'translation_failed';
    }
> {
  const existing = await getApproval(input.approvalId);
  if (!existing) return { ok: false, reason: 'not_found' };
  if (existing.decision !== 'pending') {
    return { ok: false, reason: 'not_pending' };
  }
  const before = existing.proposedPayload[input.field];
  if (typeof before !== 'string' || before.trim().length === 0) {
    return { ok: false, reason: 'field_empty' };
  }

  // Probe-aware steering — when the approval came from probe
  // autopilot, market_probe_id is on the payload. Look up the probe
  // and pass formality + domain hint into the translator so the wire
  // copy honors the same steering the drafter used.
  const probeId =
    typeof existing.proposedPayload['market_probe_id'] === 'string'
      ? (existing.proposedPayload['market_probe_id'] as string)
      : null;
  let formalityLevel: 'high' | 'professional' | 'casual' | undefined;
  let domainHint: string | undefined;
  if (probeId) {
    const [probeRow] = await db
      .select({
        formalityLevel: marketProbes.formalityLevel,
        domainHint: marketProbes.domainHint,
      })
      .from(marketProbes)
      .where(eq(marketProbes.id, probeId))
      .limit(1);
    if (probeRow) {
      const fl = probeRow.formalityLevel;
      if (fl === 'high' || fl === 'professional' || fl === 'casual') {
        formalityLevel = fl;
      }
      if (probeRow.domainHint) domainHint = probeRow.domainHint;
    }
  }

  // Lazy import so the catalog package doesn't pull @procur/ai's
  // entire executor surface for callers that don't translate. Same
  // pattern as autopilot's lazy executor import.
  const { translateOutboundMessage } = await import('@procur/ai');
  const result = await translateOutboundMessage({
    text: before,
    targetLanguage: input.targetLanguage,
    ...(formalityLevel ? { formalityLevel } : {}),
    ...(domainHint ? { domainHint } : {}),
  });
  if (!result) {
    return { ok: false, reason: 'translation_failed' };
  }
  // No-op when source already matched target — return ok but don't
  // mutate the payload. Caller can surface "already in <lang>" to
  // the operator.
  if (result.noTranslationNeeded) {
    const updated = await getApproval(input.approvalId);
    if (!updated) return { ok: false, reason: 'not_found' };
    return {
      ok: true,
      row: updated,
      translated: false,
      sourceLanguage: result.detectedSourceLanguage,
    };
  }

  const auditEntry = {
    field: input.field,
    original_text: before,
    translation: result.translation,
    source_language: result.detectedSourceLanguage,
    target_language: input.targetLanguage.toLowerCase(),
    translated_at: new Date().toISOString(),
  };
  const priorAudit = Array.isArray(
    existing.proposedPayload['translation_audit'],
  )
    ? (existing.proposedPayload['translation_audit'] as unknown[])
    : [];
  // Cap audit history per field to keep payload size bounded.
  // Operator iterating 50 times shouldn't balloon the row; the UI
  // surfaces only the latest entry per field anyway. Keep last
  // AUDIT_HISTORY_PER_FIELD entries per field; entries from other
  // fields are unaffected. Most-recent-first within each field's
  // window after pruning.
  const AUDIT_HISTORY_PER_FIELD = 5;
  const cappedAudit = capAuditHistory(
    [...priorAudit, auditEntry],
    AUDIT_HISTORY_PER_FIELD,
  );
  const nextPayload = {
    ...existing.proposedPayload,
    [input.field]: result.translation,
    translation_audit: cappedAudit,
  };
  await db
    .update(approvals)
    .set({ proposedPayload: nextPayload })
    .where(
      and(
        eq(approvals.id, input.approvalId),
        eq(approvals.decision, 'pending'),
      ),
    );
  // Record the translation as a feedback event so we can later
  // analyze which probes / domains lean on translation most.
  await db.insert(feedbackEvents).values({
    userId: input.userId ?? null,
    feedbackKind: 'communication_edit',
    targetType: 'approval',
    targetId: input.approvalId,
    payload: {
      action_type: existing.actionType,
      field: input.field,
      kind: 'translation',
      source_language: result.detectedSourceLanguage,
      target_language: input.targetLanguage.toLowerCase(),
      original_text: before,
      translated_text: result.translation,
      probe_id: probeId,
    },
  });
  const updated = await getApproval(input.approvalId);
  if (!updated) return { ok: false, reason: 'not_found' };
  return {
    ok: true,
    row: updated,
    translated: true,
    sourceLanguage: result.detectedSourceLanguage,
  };
}

/**
 * Sum cost_ledger micros for today (UTC). Powers the in-app cost
 * meter and matches the AgentRunner pre-run gate's calculation. Fails
 * open — returns 0 on query failure rather than blocking the UI.
 */
export async function sumCostLedgerToday(now: Date = new Date()): Promise<{
  micros: number;
  usd: number;
}> {
  const start = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      0,
      0,
      0,
      0,
    ),
  );
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  try {
    const rows = await db
      .select({
        total: sql<number>`coalesce(sum(${costLedger.costUsdMicros}), 0)::bigint`,
      })
      .from(costLedger)
      .where(
        sql`${costLedger.occurredAt} >= ${start} AND ${costLedger.occurredAt} < ${end}`,
      );
    const micros = Number(rows[0]?.total ?? 0);
    return { micros, usd: micros / 1_000_000 };
  } catch {
    return { micros: 0, usd: 0 };
  }
}

/**
 * Count of pending approvals — used by the global nav badge.
 */
export async function countPendingApprovals(): Promise<number> {
  try {
    const rows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(approvals)
      .where(eq(approvals.decision, 'pending'));
    return Number(rows[0]?.count ?? 0);
  } catch {
    return 0;
  }
}

/**
 * Insert an approval row from the chat-tool surface (vex-into-procur
 * merge Phase 7.6). Mirrors @procur/ai's ApprovalGate but takes no
 * agent_run_id — chat-driven proposals don't run through AgentRunner;
 * they're a direct user → approval queue path.
 *
 * Validates the action via the ActionDescriptor union before insert
 * so a malformed payload from the model can't produce a poisoned
 * approval row.
 */
export async function insertChatApproval(
  action: ActionDescriptorT,
  source: { userId: string; threadId?: string },
): Promise<{
  id: string;
  actionType: string;
  createdAt: Date;
}> {
  // Re-validate via the union — guards against malformed model output.
  const parsed = ActionDescriptor.parse(action);

  const id = createId();
  const now = new Date();

  const [row] = await db
    .insert(approvals)
    .values({
      id,
      agentRunId: null,
      actionType: parsed.kind,
      proposedPayload: parsed as unknown as Record<string, unknown>,
      decision: 'pending',
    })
    .returning({
      id: approvals.id,
      actionType: approvals.actionType,
      createdAt: approvals.createdAt,
    });

  if (!row) {
    throw new Error(`approval ${id} insert returned no row`);
  }

  await db
    .insert(events)
    .values({
      id: createId(),
      verb: 'approval.created',
      subjectType: 'approval',
      subjectId: row.id,
      actorType: 'user',
      actorId: source.userId,
      objectType: 'approval',
      objectId: row.id,
      occurredAt: now,
      idempotencyKey: `approval.created:${row.id}`,
      metadata: {
        action_type: parsed.kind,
        tier: parsed.tier,
        source: 'chat',
        ...(source.threadId ? { thread_id: source.threadId } : {}),
      },
    })
    .onConflictDoNothing({
      target: [events.occurredAt, events.idempotencyKey],
    });

  // Outreach feature snapshot — captured here at proposal time so
  // the LightGBM reply-14d classifier trains on the same signals
  // the operator saw when approving. Limited to the four outreach
  // action types; other actions (sanctions screens, follow-ups,
  // milestones) aren't ranked. Errors swallowed inside the
  // helpers — a feature-snapshot failure must never block the
  // approval write itself.
  if (
    parsed.kind === 'email.send' ||
    parsed.kind === 'sms.send' ||
    parsed.kind === 'whatsapp.send' ||
    parsed.kind === 'whatsapp.send_template' ||
    parsed.kind === 'outbound_call'
  ) {
    try {
      const features = await buildOutreachFeatures({
        approvalId: row.id,
        proposedPayload: parsed as unknown as Record<string, unknown>,
      });
      await recordOutreachFeatureSnapshot({
        approvalId: row.id,
        features,
      });
    } catch (err) {
      console.error('[outreach-features] hook failed', err);
    }
  }

  return row;
}

/**
 * Cap translation_audit entries per field. Operator iterating
 * (translate to JP, change mind, retranslate to KO, retranslate
 * back to JP, …) shouldn't balloon the approval row's jsonb. The
 * UI only surfaces the latest entry per field; older entries are
 * historical-only and don't need to live forever.
 *
 * Strategy: keep the last `perField` entries for each distinct
 * field. Entries are stored in chronological order; we walk the
 * list in reverse, count per-field occurrences, drop entries that
 * exceed the cap, and re-emit chronologically. Output preserves the
 * original ordering for the entries that survive — UI relies on
 * "latest entry" being last.
 */
function capAuditHistory(
  entries: unknown[],
  perField: number,
): unknown[] {
  const perFieldCount: Record<string, number> = {};
  const keepReverse: unknown[] = [];
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (typeof entry !== 'object' || entry == null) continue;
    const field = (entry as { field?: unknown }).field;
    const key = typeof field === 'string' ? field : '__unknown__';
    const count = perFieldCount[key] ?? 0;
    if (count < perField) {
      keepReverse.push(entry);
      perFieldCount[key] = count + 1;
    }
  }
  return keepReverse.reverse();
}
