import 'server-only';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  approvals,
  contacts,
  contactOrgMemberships,
  db,
  knownEntities,
  marketProbeTargets,
  marketProbes,
  organizations,
  type MarketProbe,
  type MarketProbeTarget,
} from '@procur/db';
import { createId } from '@procur/ai';
import {
  buildCommunicationContextPack,
  draftOutreachFromContext,
} from './communication-recommendations';
import { computeProbeScorecard } from './market-probe-measurement';
import { setProbeStatus } from './market-probes';

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

    // Build context + draft. intent rides from
    // probe.plan_json.outreachAngle so the draft tone reflects what
    // the operator approved at plan time.
    const intent =
      (probe.planJson?.outreachAngle as string) ??
      'first-touch routing email — ask if they are the right contact for supplier inquiries; do NOT discuss pricing or terms';
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

    const result = await applyEmailSend(approvalId, {
      to: [recipient.email],
      subject: draft.emailSubject,
      body: draft.emailBody,
      rationale: `Market Probe ${probe.id} autopilot dispatch.`,
    });

    if (!result.ok) {
      // Demote approval back to pending so the operator can retry —
      // same pattern as the conversation-agent's
      // autoExecuteReply post-PR #552 fix.
      await db
        .update(approvals)
        .set({
          decision: 'pending',
          proposedPayload: sql`${approvals.proposedPayload} || ${sql`${
            JSON.stringify({
              auto_execute_failed: true,
              auto_execute_error: result.error ?? 'unknown',
            })
          }::jsonb`}`,
        })
        .where(eq(approvals.id, approvalId));
      skipped.push({
        targetId: t.id,
        entitySlug: t.entitySlug,
        reason: `send failed: ${result.error}`,
      });
      continue;
    }

    await db
      .update(marketProbeTargets)
      .set({
        sendStatus: 'sent',
        lastTouchAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(marketProbeTargets.id, t.id));

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
 * Resolve a recipient email for a probe target's entity. Looks up
 * the contact-org membership chain: known_entities.slug →
 * organizations row matched by external_keys.known_entity_slug →
 * primary contact via contact_org_memberships. Returns the first
 * contact email. Phase 2I will refine to pick the best decision-maker
 * by title + Apollo email_status='verified'.
 */
async function resolveRecipientEmail(
  entitySlug: string,
): Promise<{ email: string; contactId: string } | null> {
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
    .orderBy(asc(contactOrgMemberships.isPrimary))
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
