import 'server-only';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  approvals,
  contacts,
  contactOrgMemberships,
  conversationSettings,
  db,
  knownEntities,
  marketProbeTargets,
  marketProbes,
  organizations,
  type MarketProbe,
  type MarketProbeTarget,
  type NewConversationSettings,
} from '@procur/db';
import { createId } from '@procur/ai';
import {
  buildCommunicationContextPack,
  draftOutreachFromContext,
} from './communication-recommendations';
import { computeProbeScorecard } from './market-probe-measurement';
import { setProbeStatus } from './market-probes';
import { listHypothesesForProbe } from './market-probe-hypotheses';
import { pickVariantForTarget } from './market-probe-variants';

/**
 * Phase 2H autopilot. Drafts + sends per-target outreach within probe
 * caps. Layered safety:
 *   - probe.mode must be 'experiment' (relationship mode never
 *     autopilots regardless of tier).
 *   - probe.tier must be >= 1.
 *   - target.justificationState must be 'justified'.
 *   - target.fitTier must be 'A' or 'B'.
 *   - target.sendStatus must be 'pending' (no double-send).
 *   - underlying known_entity.scoutProtection must be false.
 *   - kill criteria (bounce / no-reply thresholds) must be clear.
 *   - daily send count must be under probe.dailySendLimit.
 *
 * Failure modes are deliberate non-actions: the function returns a
 * structured result enumerating skipped targets and the reason.
 * Operator can then triage; agent doesn't loop trying to send.
 *
 * ## Concurrency model
 *
 * Two operators (or one operator running batches in parallel from
 * different tabs / a cron + a manual click) could each pull the same
 * `send_status='pending'` target and both pass cap checks before
 * either dispatches — classic read-then-act race. The fix is an
 * atomic UPDATE-claim: just before dispatch we run
 *
 *   UPDATE market_probe_targets
 *      SET send_status='sent', variant_id=$X, last_touch_at=now()
 *    WHERE id=$id AND send_status='pending'
 *    RETURNING id
 *
 * Postgres serializes concurrent UPDATEs on the same row, so exactly
 * one batch wins the claim. The loser sees zero rows returned and
 * skips that target (its draft is discarded — that's fine; drafting
 * is idempotent and cheap relative to a duplicate send).
 *
 * ## Partial-failure semantics
 *
 * The claim runs BEFORE the actual send. If the process crashes
 * between claim and dispatch, the target sits at `sent` without an
 * approval row or delivered message. This is a recoverable
 * observability state — the operator sees a target marked sent with
 * no matching approval and investigates. We accept this trade-off
 * because the alternative (claim AFTER send) reintroduces the
 * double-send race we're closing here, which is a strict correctness
 * violation. On a clean dispatch failure (Resend returns an error
 * synchronously), we explicitly rollback the claim:
 * `send_status='pending'`, `variant_id=null` — operator can retry.
 */

export interface AutopilotResult {
  ok: boolean;
  reason?: string;
  attempted: number;
  drafted: number;
  sent: number;
  queued: number;
  skipped: Array<{ targetId: string; entitySlug: string; reason: string }>;
  killCriteriaTriggered?: string;
}

export interface AutopilotInput {
  probeId: string;
  /** Override the daily-send limit on a per-call basis (still capped
   *  at probe.dailySendLimit). Default: read from probe. */
  maxThisBatch?: number;
  /** Dry run — drafts but doesn't dispatch. Useful for the "preview
   *  next batch" UI in Phase 2I. */
  dryRun?: boolean;
}

export async function autopilotSendBatch(
  input: AutopilotInput,
): Promise<AutopilotResult> {
  const skipped: AutopilotResult['skipped'] = [];

  const [probe] = await db
    .select()
    .from(marketProbes)
    .where(eq(marketProbes.id, input.probeId))
    .limit(1);
  if (!probe) {
    return {
      ok: false,
      reason: `probe ${input.probeId} not found`,
      attempted: 0,
      drafted: 0,
      sent: 0,
      queued: 0,
      skipped,
    };
  }

  // Refuse outright when the probe is paused / completed / abandoned
  // — autopilot only operates on active probes.
  if (probe.status !== 'active') {
    return {
      ok: false,
      reason: `probe status is ${probe.status}; autopilot requires status=active`,
      attempted: 0,
      drafted: 0,
      sent: 0,
      queued: 0,
      skipped,
    };
  }

  // Mode gate. Phase 2G semantic: relationship mode is operator-only.
  if (probe.mode === 'relationship') {
    return {
      ok: false,
      reason: 'probe.mode=relationship — autopilot disabled',
      attempted: 0,
      drafted: 0,
      sent: 0,
      queued: 0,
      skipped,
    };
  }

  // Tier gate.
  if (probe.tier < 1) {
    return {
      ok: false,
      reason: `probe.tier=${probe.tier} — autopilot requires tier >= 1`,
      attempted: 0,
      drafted: 0,
      sent: 0,
      queued: 0,
      skipped,
    };
  }

  // Plan-generation gate. Refuse to send outreach grounded in a
  // fallback skeleton (no API key / parse error). The plan-agent
  // stamps generationStatus on its output; setProbePlan keeps the
  // probe at 'planning' when it's a fallback, so this guard mostly
  // catches the case where an operator explicitly flipped the probe
  // to 'active' without resolving the plan-gen failure. Belt + braces.
  const planStatus = probe.planJson?.generationStatus;
  if (planStatus && planStatus !== 'ok') {
    return {
      ok: false,
      reason: `probe.plan was generated via fallback (${planStatus}); regenerate the plan or explicitly approve before autopilot can send`,
      attempted: 0,
      drafted: 0,
      sent: 0,
      queued: 0,
      skipped,
    };
  }

  // Plan-content sanity. A clean generationStatus doesn't guarantee
  // the plan actually carries a hypothesis + outreach angle — operator
  // could have manually cleared them, or a regeneration could have
  // landed the planning fields blank while still flagging 'ok' (rare
  // but possible). Refuse to draft outreach without these — the
  // drafter prompt won't have the anchor it needs and the result will
  // be generic boilerplate.
  const planHypothesis = (probe.planJson?.hypothesis ?? '').trim();
  const planOutreach = (probe.planJson?.outreachAngle ?? '').trim();
  if (!planHypothesis || !planOutreach) {
    const missing = [
      !planHypothesis ? 'plan.hypothesis' : null,
      !planOutreach ? 'plan.outreachAngle' : null,
    ]
      .filter(Boolean)
      .join(' + ');
    return {
      ok: false,
      reason: `probe.plan is missing ${missing} — regenerate the plan before autopilot can draft outreach`,
      attempted: 0,
      drafted: 0,
      sent: 0,
      queued: 0,
      skipped,
    };
  }

  // Hypotheses gate. The probe is supposed to be testing something.
  // Zero active hypotheses means the agent has no falsifiable bet to
  // make and no scorecard frame to validate against — outreach goes
  // out in a vacuum and the Learning Report has nothing to synthesize.
  // Empty hypothesis table is a fail-loud signal; operator either
  // re-runs plan generation (which seeds hypotheses) or hand-adds a
  // hypothesis before the probe can send.
  const hypotheses = await listHypothesesForProbe(probe.id);
  const activeHypotheses = hypotheses.filter(
    (h) => h.status === 'active' || h.status === 'confirmed',
  );
  if (activeHypotheses.length === 0) {
    return {
      ok: false,
      reason:
        'probe has zero active hypotheses — autopilot refuses to send outreach without a falsifiable bet. Regenerate the plan or add a hypothesis manually.',
      attempted: 0,
      drafted: 0,
      sent: 0,
      queued: 0,
      skipped,
    };
  }

  // Kill criteria check via the scorecard (cheap; reads cached counts).
  const scorecard = await computeProbeScorecard(input.probeId);
  if (scorecard) {
    const bouncePct = scorecard.bounceRate * 100;
    const maxBounce = Number(probe.maxBounceRatePct);
    if (bouncePct > maxBounce) {
      const reason = `bounce rate ${bouncePct.toFixed(1)}% exceeds threshold ${maxBounce}%`;
      await setProbeStatus(probe.id, 'paused');
      return {
        ok: false,
        reason: `auto-paused: ${reason}`,
        attempted: 0,
        drafted: 0,
        sent: 0,
        queued: 0,
        skipped,
        killCriteriaTriggered: reason,
      };
    }
    // No-signal threshold — total sent without any positive/routing
    // reply. Per ChatGPT's expanded vision item 7
    // (max_total_no_signal_before_probe_pause).
    const noSignal =
      scorecard.sentCount > 0 && scorecard.positiveReplies === 0;
    if (
      noSignal &&
      scorecard.sentCount >= probe.maxTotalNoSignalBeforeProbePause
    ) {
      const reason = `${scorecard.sentCount} sent with zero positive replies — exceeds max_total_no_signal threshold (${probe.maxTotalNoSignalBeforeProbePause})`;
      await setProbeStatus(probe.id, 'paused');
      return {
        ok: false,
        reason: `auto-paused: ${reason}`,
        attempted: 0,
        drafted: 0,
        sent: 0,
        queued: 0,
        skipped,
        killCriteriaTriggered: reason,
      };
    }
  }

  // Compute today's send budget. probe.dailySendLimit caps per UTC day.
  const startOfTodayUtc = new Date();
  startOfTodayUtc.setUTCHours(0, 0, 0, 0);
  const sentTodayRows = await db
    .select({ id: marketProbeTargets.id })
    .from(marketProbeTargets)
    .where(
      and(
        eq(marketProbeTargets.probeId, probe.id),
        sql`${marketProbeTargets.lastTouchAt} >= ${startOfTodayUtc.toISOString()}`,
        sql`${marketProbeTargets.sendStatus} IN ('sent','queued')`,
      ),
    );
  const remainingToday = Math.max(
    0,
    probe.dailySendLimit - sentTodayRows.length,
  );
  const totalSentRows = await db
    .select({ id: marketProbeTargets.id })
    .from(marketProbeTargets)
    .where(
      and(
        eq(marketProbeTargets.probeId, probe.id),
        sql`${marketProbeTargets.sendStatus} IN ('sent','queued')`,
      ),
    );
  const remainingTotal = Math.max(
    0,
    probe.totalSendLimit - totalSentRows.length,
  );
  const batchSize = Math.min(
    input.maxThisBatch ?? probe.dailySendLimit,
    remainingToday,
    remainingTotal,
  );
  if (batchSize === 0) {
    return {
      ok: true,
      reason:
        remainingToday === 0
          ? 'daily cap reached'
          : 'total send cap reached',
      attempted: 0,
      drafted: 0,
      sent: 0,
      queued: 0,
      skipped,
    };
  }

  // Pick eligible targets: justified, fit_tier A/B, pending,
  // scout_protection clear. Order by confidence desc — agent picks
  // best-believed first.
  const eligibleRows = await db
    .select({
      target: marketProbeTargets,
      scoutProtection: knownEntities.scoutProtection,
    })
    .from(marketProbeTargets)
    .leftJoin(
      knownEntities,
      eq(knownEntities.slug, marketProbeTargets.entitySlug),
    )
    .where(
      and(
        eq(marketProbeTargets.probeId, probe.id),
        eq(marketProbeTargets.justificationState, 'justified'),
        inArray(marketProbeTargets.fitTier, ['A', 'B']),
        eq(marketProbeTargets.sendStatus, 'pending'),
      ),
    )
    .orderBy(asc(marketProbeTargets.fitTier))
    .limit(batchSize * 2); // pull extra to allow some to be filtered

  // Filter scout-protected
  const eligible: MarketProbeTarget[] = [];
  for (const r of eligibleRows) {
    if (r.scoutProtection === true) {
      skipped.push({
        targetId: r.target.id,
        entitySlug: r.target.entitySlug,
        reason: 'scout_protection',
      });
      continue;
    }
    eligible.push(r.target);
    if (eligible.length >= batchSize) break;
  }

  if (eligible.length === 0) {
    return {
      ok: true,
      reason: 'no eligible targets',
      attempted: 0,
      drafted: 0,
      sent: 0,
      queued: 0,
      skipped,
    };
  }

  let drafted = 0;
  let sent = 0;
  let queued = 0;

  // Lazy import @procur/ai's executor — same pattern as the
  // conversation-agent inline send path.
  const { applyEmailSend } = await import('@procur/ai');

  for (const t of eligible) {
    drafted += 1;

    // Resolve a recipient email. Prefer Apollo-enriched contact
    // already on entity_contact_enrichments; fall back to looking up
    // a contact via contactOrgMemberships → organizations matching
    // the entity slug. Stub orgs (no contact) get skipped — we don't
    // outreach into the void.
    const recipient = await resolveRecipientEmail(t.entitySlug);
    if (!recipient) {
      skipped.push({
        targetId: t.id,
        entitySlug: t.entitySlug,
        reason: 'no recipient email',
      });
      continue;
    }

    // Phase 2I.4 — variant picker. If the probe has active variants,
    // sample one (winner short-circuits; otherwise weighted-random
    // among 'active'). Falls back to the plan-derived outreach angle
    // when no variants exist (legacy probes from Phase 2H).
    const variant = await pickVariantForTarget(probe.id);
    const intent = variant
      ? [
          variant.angle ?? variant.variantName,
          variant.bodyTemplate
            ? `Body template / direction: ${variant.bodyTemplate}`
            : null,
        ]
          .filter(Boolean)
          .join('. ')
      : ((probe.planJson?.outreachAngle as string) ??
        'first-touch routing email — ask if they are the right contact for supplier inquiries; do NOT discuss pricing or terms');
    const pack = await buildCommunicationContextPack({
      entitySlug: t.entitySlug,
      intent,
    });
    if (!pack) {
      // Entity didn't resolve in the rolodex — Apollo stub may have
      // been created with a slug that lookupKnownEntities can't find
      // (rare but possible during stub-creation race). Skip cleanly.
      skipped.push({
        targetId: t.id,
        entitySlug: t.entitySlug,
        reason: 'context pack unavailable (entity unresolved)',
      });
      continue;
    }
    const draft = await draftOutreachFromContext({
      pack,
      intent,
      doNotMention: probe.blockedTerms ?? [],
    });

    if (input.dryRun) {
      // Phase 2I will store these previews; for now dry-run is just
      // skipped from dispatch.
      continue;
    }

    // Atomic claim — flip send_status='pending' → 'sent' in one
    // UPDATE keyed on the still-pending precondition. Postgres
    // serializes concurrent UPDATEs on the same row, so exactly one
    // batch wins the claim per target. RETURNING tells us whether
    // we won (1 row) or lost (0 rows). Loser skips — drafting work
    // is discarded but we do NOT double-send. variant_id is stamped
    // here (not after dispatch) so concurrent batches can't both
    // claim with different variant ids.
    const claim = await db
      .update(marketProbeTargets)
      .set({
        sendStatus: 'sent',
        variantId: variant?.id ?? null,
        lastTouchAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(marketProbeTargets.id, t.id),
          eq(marketProbeTargets.sendStatus, 'pending'),
        ),
      )
      .returning({ id: marketProbeTargets.id });
    if (claim.length === 0) {
      // Concurrent batch already claimed this target. Drop the draft
      // and move on — the other batch is the one dispatching.
      skipped.push({
        targetId: t.id,
        entitySlug: t.entitySlug,
        reason: 'concurrent batch claimed target',
      });
      continue;
    }

    // Insert approval row. tier=1 → decision='auto_approved'; tier=0
    // would queue manually but autopilot already gated tier>=1.
    const approvalId = createId();
    await db.insert(approvals).values({
      id: approvalId,
      agentRunId: null,
      actionType: 'email.send',
      proposedPayload: {
        kind: 'email.send',
        tier: 'T2',
        to: [recipient.email],
        subject: draft.emailSubject,
        body: draft.emailBody,
        rationale: `Market Probe ${probe.id} autopilot (tier ${probe.tier}). Target ${t.id}; entity ${t.entitySlug}. Plan outreach angle: ${(probe.planJson?.outreachAngle ?? 'routing').slice(0, 200)}.`,
        actor_source: 'market_probe_autopilot',
        market_probe_id: probe.id,
        market_probe_target_id: t.id,
      },
      decision: 'auto_approved',
    });

    // Phase 2I.2 — upsert conversation_settings on the recipient's
    // email BEFORE the send so even if dispatch fails, an inbound
    // that does land routes through the probe-aware reply path.
    // Maps probe.tier → approvalMode:
    //   tier 1: 'tiered'        — auto-send safe replies; queue
    //                             commitments; probe-aware escalation
    //                             classifier still gates inbounds
    //   tier 2: 'tiered'        — same; Phase 2I.3 will widen for
    //                             follow-up handling
    //   tier 3: 'full_approval' — commercial draft mode = always queue
    const probeApprovalMode: 'tiered' | 'full_approval' =
      probe.tier >= 3 ? 'full_approval' : 'tiered';
    const upsertRow: NewConversationSettings = {
      channel: 'email',
      conversationKey: recipient.email,
      aiEnabled: true,
      authority: 'chitchat_only',
      approvalMode: probeApprovalMode,
      tone: 'brokerage_direct',
      language: 'auto',
      identityDisclosure: 'on_request',
      linkedProbeId: probe.id,
      linkedEntitySlug: t.entitySlug,
      responseDelayMinSec: 0,
      responseDelayMaxSec: 0,
      maxTurns: 6,
      maxCostUsdCents: 100,
      maxDurationHours: 168,
      channelConfig: { source: 'market_probe_autopilot' },
    };
    await db
      .insert(conversationSettings)
      .values(upsertRow)
      .onConflictDoUpdate({
        target: [
          conversationSettings.channel,
          conversationSettings.conversationKey,
        ],
        set: {
          // Preserve operator-set overrides when they exist; backfill
          // probe-specific link + AI-enabled for a contact that
          // already has manual settings.
          aiEnabled: sql`${conversationSettings.aiEnabled} OR true`,
          linkedProbeId: probe.id,
          linkedEntitySlug: sql`COALESCE(${conversationSettings.linkedEntitySlug}, ${t.entitySlug})`,
          updatedAt: new Date(),
        },
      });

    const result = await applyEmailSend(approvalId, {
      to: [recipient.email],
      subject: draft.emailSubject,
      body: draft.emailBody,
      rationale: `Market Probe ${probe.id} autopilot dispatch.`,
    });

    if (!result.ok) {
      // Rollback the atomic claim — flip target back to 'pending'
      // and clear the variant assignment so a future batch can pick
      // it up cleanly. Without this the target stays stuck at
      // 'sent' despite no email actually being delivered.
      await db
        .update(marketProbeTargets)
        .set({
          sendStatus: 'pending',
          variantId: null,
          updatedAt: new Date(),
        })
        .where(eq(marketProbeTargets.id, t.id));

      // Demote approval back to pending so the operator can retry —
      // same pattern as the conversation-agent's autoExecuteReply
      // post-PR #552 fix.
      //
      // The earlier merge expression
      //   `${approvals.proposedPayload} || ${sql`${JSON.stringify(...)}::jsonb`}`
      // generated `proposed_payload || $1::jsonb` with $1 bound as
      // text — text || jsonb is a type error (or, on Neon's coercion
      // path, silently dropped the diagnostic). Replacing wholesale
      // is simpler and atomic — preserves prior payload fields by
      // reading then writing the merged object.
      const [existing] = await db
        .select({ proposedPayload: approvals.proposedPayload })
        .from(approvals)
        .where(eq(approvals.id, approvalId))
        .limit(1);
      const merged = {
        ...((existing?.proposedPayload as Record<string, unknown>) ?? {}),
        auto_execute_failed: true,
        auto_execute_error: result.error ?? 'unknown',
      };
      await db
        .update(approvals)
        .set({ decision: 'pending', proposedPayload: merged })
        .where(eq(approvals.id, approvalId));
      skipped.push({
        targetId: t.id,
        entitySlug: t.entitySlug,
        reason: `send failed: ${result.error}`,
      });
      continue;
    }

    sent += 1;
  }

  return {
    ok: true,
    attempted: eligible.length,
    drafted,
    sent,
    queued,
    skipped,
  };
}

/**
 * Resolve a recipient email for a probe target's entity. Two-stage
 * lookup, decision-maker first:
 *
 *   1. (Phase 2I.3) entity_contact_enrichments — Apollo-sourced rows
 *      written by Phase 2B's findDecisionMakersForTarget. Apollo's
 *      searchPeople was already filtered with
 *      contactEmailStatus=['verified'] at call time, so any persisted
 *      apollo row with a non-null email is a verified-email
 *      decision-maker. Order by seniority rank — owners/founders/
 *      c_suite/vp/head/director/manager wins over senior/entry.
 *
 *   2. Fall back to the rolodex CRM chain: organizations
 *      (external_keys.known_entity_slug) → contact_org_memberships →
 *      contacts.emails. Used when no Apollo decision-makers have
 *      been discovered yet (operator hasn't clicked "Find decision-
 *      makers" on the target).
 *
 * Senior decision-makers reach probe replies cleaner than generic
 * `info@` inboxes; that's the whole point of the Apollo people
 * pass. Returning a contactId from this function is best-effort —
 * Apollo enrichments don't have a canonical CRM contact id, so we
 * return the entitySlug-derived sidecar id instead. The downstream
 * approval row carries the email + entitySlug regardless.
 */
async function resolveRecipientEmail(
  entitySlug: string,
): Promise<{ email: string; contactId: string } | null> {
  // Stage 1 — verified Apollo decision-makers. CASE expression in
  // ORDER BY ranks the seniority taxonomy explicitly so owner/founder
  // beat manager, manager beats senior, etc.
  const apolloRows = await db.execute<{
    id: string;
    email: string;
    seniority: string | null;
  }>(sql`
    SELECT id, email, seniority
      FROM entity_contact_enrichments
     WHERE entity_slug = ${entitySlug}
       AND source = 'apollo'
       AND email IS NOT NULL
       AND email <> ''
     ORDER BY CASE seniority
                WHEN 'owner'    THEN 1
                WHEN 'founder'  THEN 2
                WHEN 'c_suite'  THEN 3
                WHEN 'partner'  THEN 4
                WHEN 'vp'       THEN 5
                WHEN 'head'     THEN 6
                WHEN 'director' THEN 7
                WHEN 'manager'  THEN 8
                WHEN 'senior'   THEN 9
                WHEN 'entry'    THEN 10
                WHEN 'intern'   THEN 11
                ELSE 99
              END
     LIMIT 1
  `);
  const apolloPick = (
    apolloRows.rows as Array<{ id?: string; email?: string }>
  )[0];
  if (apolloPick?.email) {
    return { email: apolloPick.email, contactId: apolloPick.id ?? entitySlug };
  }

  // Stage 2 — rolodex CRM chain fallback (existing path).
  const orgRow = await db.execute<{ org_id: string }>(sql`
    SELECT id AS org_id
      FROM organizations
     WHERE external_keys->>'known_entity_slug' = ${entitySlug}
     LIMIT 1
  `);
  const orgId = (orgRow.rows as Array<{ org_id?: string }>)[0]?.org_id;
  if (!orgId) return null;

  const [membership] = await db
    .select({
      contactId: contactOrgMemberships.contactId,
      isPrimary: contactOrgMemberships.isPrimary,
    })
    .from(contactOrgMemberships)
    .where(eq(contactOrgMemberships.orgId, orgId))
    // desc on isPrimary so true (primary) sorts before false. Earlier
    // this used asc() — Postgres orders false < true, so the non-
    // primary contact won, defeating the "pick primary" intent.
    .orderBy(desc(contactOrgMemberships.isPrimary))
    .limit(1);
  if (!membership) return null;

  const [contact] = await db
    .select({ id: contacts.id, emails: contacts.emails })
    .from(contacts)
    .where(eq(contacts.id, membership.contactId))
    .limit(1);
  if (!contact) return null;
  const firstEmail = (contact.emails ?? []).find(
    (e) => typeof e === 'string' && e.includes('@'),
  );
  if (!firstEmail) return null;
  return { email: firstEmail, contactId: contact.id };
}

// suppress unused-import lint on intentional re-exports
void organizations;
