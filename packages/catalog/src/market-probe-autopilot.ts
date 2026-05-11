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
  draftLeadFormSubmission,
  draftOutreachFromContext,
  mapDraftToFieldValues,
  probeDomainHintGuidance,
  probeFormalityGuidance,
} from './communication-recommendations';
import { computeProbeScorecard } from './market-probe-measurement';
import { countryToOutreachLanguage } from './country-codes';
import { findDecisionMakersForTarget } from './market-probes-discovery';
import { setProbeStatus } from './market-probes';
import { listHypothesesForProbe } from './market-probe-hypotheses';
import { pickVariantForTarget } from './market-probe-variants';
import { pickAutopilotEligibleEndpoint } from './entity-contact-form-endpoints';
import {
  buildSubAddressedEmail,
  mintLeadFormSubmissionToken,
} from './lead-form-submission-tokens';
import { probeHasActiveAudioForLanguage } from './rvm-audio-assets';

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
  /** Tenant id, required when the probe's allowedChannels includes
   *  'rvm' AND probe.allowPaidEnrichment is true — Apollo's
   *  enrichPerson enforces a per-tenant daily cap and writes to the
   *  cost ledger keyed on companyId. Omit (or pass null) for cron
   *  contexts that have no auth session; the autopilot then skips
   *  the paid-enrichment path silently and falls through to the
   *  next channel. */
  companyId?: string | null;
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
    // Sample-size floor on the bounce-rate kill criterion. The earlier
    // shape compared bounceRate against the threshold unconditionally
    // — first send going to a stale address (1/1 = 100% bounce)
    // would auto-pause the probe before any second target ever
    // dispatched. 10 sends is the operational floor: below that, a
    // single bad address dominates the rate. Once ≥ 10 have flown,
    // 8% bounce is a real signal that the seed list / domain
    // reputation is degraded.
    const BOUNCE_RATE_MIN_SENDS = 10;
    if (
      scorecard.sentCount >= BOUNCE_RATE_MIN_SENDS &&
      bouncePct > maxBounce
    ) {
      const reason = `bounce rate ${bouncePct.toFixed(1)}% exceeds threshold ${maxBounce}% (n=${scorecard.sentCount})`;
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
      entityCountry: knownEntities.country,
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

  // Per-target country lookup. Used when probe.outreachLanguage is
  // null/unset to resolve a per-target outreach language at dispatch
  // time (via countryToOutreachLanguage) — lets a multi-country probe
  // email each contact in their dominant business language without
  // forking the probe per country. Falls back to probe.country when
  // the rolodex overlay doesn't have a country (e.g. external_suppliers
  // -only entity).
  const countryByTargetId = new Map<string, string | null>();
  for (const r of eligibleRows) {
    countryByTargetId.set(
      r.target.id,
      r.entityCountry ?? probe.country ?? null,
    );
  }

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

  // Just-in-time contact enrichment. Before dispatch, find eligible
  // targets that have no Apollo-enriched contact on
  // entity_contact_enrichments and run findDecisionMakersForTarget
  // for them. Without this pass the dispatch loop would skip every
  // un-enriched target with reason 'no recipient email' and the
  // operator would have to click a per-target "find decision-makers"
  // button manually — exactly the friction the per-target button was
  // surfaced to solve and that operators reported as the second-worst
  // launch friction.
  //
  // Capped at MAX_JIT_ENRICH per batch (8) to bound Apollo cost +
  // sync-request duration (~2s per call × 8 = ~16s, comfortably
  // inside Vercel timeout). Targets beyond the cap get enriched on
  // subsequent batch clicks. Requires companyId — without it Apollo
  // can't write to the cost ledger and we skip silently.
  if (input.companyId && eligible.length > 0) {
    const slugs = Array.from(new Set(eligible.map((t) => t.entitySlug)));
    const enrichedRows = await db.execute<{ entity_slug: string }>(sql`
      SELECT DISTINCT entity_slug
        FROM entity_contact_enrichments
       WHERE entity_slug = ANY(${slugs})
         AND source = 'apollo'
         AND email IS NOT NULL
         AND email <> ''
    `);
    const enriched = new Set(
      enrichedRows.rows.map((r) => r.entity_slug),
    );
    const missing = eligible.filter((t) => !enriched.has(t.entitySlug));
    const MAX_JIT_ENRICH = 8;
    const toEnrich = missing.slice(0, MAX_JIT_ENRICH);
    for (const t of toEnrich) {
      try {
        await findDecisionMakersForTarget({
          targetId: t.id,
          companyId: input.companyId,
          perPage: 25,
        });
      } catch (err) {
        console.warn('[autopilot] jit-enrich failed for target', {
          targetId: t.id,
          entitySlug: t.entitySlug,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
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

  // Lazy import @procur/ai's executors — same pattern as the
  // conversation-agent inline send path.
  const { applyEmailSend, applyLeadFormSubmit } = await import('@procur/ai');

  for (const t of eligible) {
    drafted += 1;

    // Resolve the effective outreach language for THIS target.
    // Precedence: probe.outreachLanguage (operator-set, or plan-agent
    // recommendation) > per-target country mapping > English default.
    // The per-target fallback is the lever for multi-country probes
    // — when probe.outreachLanguage is null, each contact gets emailed
    // in their dominant business language.
    const targetCountry = countryByTargetId.get(t.id) ?? null;
    const effectiveOutreachLanguage =
      probe.outreachLanguage ?? countryToOutreachLanguage(targetCountry);

    // Resolve a recipient email. Prefer Apollo-enriched contact
    // already on entity_contact_enrichments; fall back to looking up
    // a contact via contactOrgMemberships → organizations matching
    // the entity slug. Stub orgs (no contact) get skipped — we don't
    // outreach into the void.
    const recipient = await resolveRecipientEmail(t.entitySlug);
    const allowsLeadForm = (probe.allowedChannels ?? []).includes('lead_form');
    const allowsRvm = (probe.allowedChannels ?? []).includes('rvm');
    // Lead-form fallback: when no email is available AND the probe
    // allows lead_form, look for an autopilot-eligible contact-form
    // endpoint. Eligibility check (CAPTCHA, http_post, message_field)
    // lives in pickAutopilotEligibleEndpoint — single source of truth
    // shared with the chat-tool path.
    let leadFormEndpoint: Awaited<
      ReturnType<typeof pickAutopilotEligibleEndpoint>
    > = null;
    if (!recipient && allowsLeadForm) {
      leadFormEndpoint = await pickAutopilotEligibleEndpoint(t.entitySlug);
    }
    // RVM fallback: when neither email nor lead_form is available
    // AND the probe allows rvm AND an active audio asset exists for
    // the (probe, variant?, language) scope, resolve a phone +
    // country for the target. The phone resolver tries the cheap
    // paths (apollo cache, rolodex, external_supplier) before paid
    // Apollo enrichment, which only fires when probe.allow_paid_
    // enrichment is true. Country drives executor-time quiet-hours
    // gating; missing country means we can't enforce 8am-6pm so we
    // skip rather than dispatch to an unknowable timezone.
    let rvmPhone: Awaited<ReturnType<typeof resolveRecipientPhone>> = null;
    let rvmCountry: string | null = null;
    let rvmAudioLanguage: string | null = null;
    if (!recipient && !leadFormEndpoint && allowsRvm) {
      rvmAudioLanguage = effectiveOutreachLanguage ?? 'en';
      const hasAudio = await probeHasActiveAudioForLanguage(
        probe.id,
        rvmAudioLanguage,
      );
      if (hasAudio) {
        rvmPhone = await resolveRecipientPhone(t.entitySlug, {
          allowPaidEnrichment: probe.allowPaidEnrichment,
          companyId: input.companyId ?? null,
        });
        if (rvmPhone) {
          rvmCountry = await resolveRecipientCountry(t.entitySlug);
        }
      }
    }
    if (!recipient && !leadFormEndpoint && !(rvmPhone && rvmCountry)) {
      const reason = allowsRvm
        ? rvmPhone && !rvmCountry
          ? 'no recipient email/form + RVM phone resolved but no country (cannot enforce quiet hours)'
          : allowsLeadForm
            ? 'no recipient email + no eligible lead-form + no RVM phone (or no audio asset)'
            : 'no recipient email + no RVM phone (or no audio asset)'
        : allowsLeadForm
          ? 'no recipient email + no autopilot-eligible lead-form endpoint'
          : 'no recipient email';
      skipped.push({
        targetId: t.id,
        entitySlug: t.entitySlug,
        reason,
      });
      continue;
    }

    // Cross-probe collision check. conversation_settings is keyed on
    // (channel, conversationKey) — ONE row per recipient email. If
    // this recipient already has a different active probe linked,
    // dispatching here would either (a) clobber the existing probe's
    // linkedProbeId on upsert (wrong: their replies would suddenly
    // route to us) or (b) leave the linkage stale (wrong: our replies
    // would route to the other probe's persona). Either way the
    // operator gets confused mid-thread.
    //
    // Skip the target with a clear reason; operator gets visibility
    // and can decide: continue contacting (manually unlink the other
    // probe), share the recipient (operator-resolved), or accept the
    // skip.
    if (recipient) {
      const [collisionRow] = await db
        .select({ linkedProbeId: conversationSettings.linkedProbeId })
        .from(conversationSettings)
        .where(
          and(
            eq(conversationSettings.channel, 'email'),
            eq(conversationSettings.conversationKey, recipient.email),
          ),
        )
        .limit(1);
      if (
        collisionRow?.linkedProbeId &&
        collisionRow.linkedProbeId !== probe.id
      ) {
        skipped.push({
          targetId: t.id,
          entitySlug: t.entitySlug,
          reason: `recipient ${recipient.email} is linked to a different active probe (${collisionRow.linkedProbeId}); manually unlink or skip`,
        });
        continue;
      }
    }
    // Channel selection: email > lead_form > rvm. Email is preferred
    // because it carries threading semantics + reply-rate signal,
    // both of which lead_form lacks (form replies arrive via email
    // separately, with no In-Reply-To linkage). RVM is the last
    // resort because it leaves a one-shot voicemail with no inline
    // reply path — the recipient has to call back or email, which
    // the per-conversation tracking can't link automatically.
    const channelKind: 'email' | 'lead_form' | 'rvm' = recipient
      ? 'email'
      : leadFormEndpoint
        ? 'lead_form'
        : 'rvm';

    // Form-channel scratch state — populated inside the lead_form
    // branch below, read by the dispatch branch further down. Both
    // branches need the same draft + field-values mapping so the
    // approval payload (rendered to operator) and the executor's
    // POST body (sent to the form) are guaranteed identical.
    let leadFormDraft: Awaited<
      ReturnType<typeof draftLeadFormSubmission>
    > | null = null;
    let leadFormDraftFieldValues: Record<string, string> | null = null;

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
    // Surface degraded signal health for ops visibility. The drafter
    // prompt already adapts (per-source "fetch failed — do not infer
    // from absence" lines + a note-to-drafter when ANY source failed)
    // — this just makes the failure correlatable to the probe + target
    // in production logs. Two or more failed sources is the operator-
    // attention threshold per the friction audit.
    if (
      pack.signalHealth?.hasFetchErrors &&
      pack.signalHealth.failedSources.length >= 2
    ) {
      console.warn(
        '[autopilot] degraded context pack — drafting with reduced signal',
        {
          probeId: probe.id,
          targetId: t.id,
          entitySlug: t.entitySlug,
          failedSources: pack.signalHealth.failedSources,
        },
      );
    }
    // Email drafter only runs when we'll actually dispatch via email.
    // For the lead_form-only fallback path the form-aware drafter
    // (called inside the channel branch below) produces a tighter
    // form-shaped payload; running the email drafter too would burn
    // a Sonnet call per target with no consumer.
    const draft =
      channelKind === 'email'
        ? await draftOutreachFromContext({
            pack,
            intent,
            doNotMention: probe.blockedTerms ?? [],
            // Per-probe drafter steering — formality + domain hint
            // shift the drafter prompt without forking the system
            // prompt. NULL falls back to the drafter's base
            // (professional tone, no extra framing).
            formalityLevel:
              (probe.formalityLevel as
                | 'high'
                | 'professional'
                | 'casual'
                | null) ?? null,
            domainHint: probe.domainHint,
            // Outreach-language override — when set on the probe, drafter
            // writes in this language. When null, falls back to the
            // target's country mapping (so a multi-country probe writes
            // each contact in their dominant business language). When
            // both are null, drafter defaults to English.
            outreachLanguage: effectiveOutreachLanguage,
          })
        : null;

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
    // actionType branches by selected channel; payload shape mirrors
    // each executor's expected input so the calling server-action
    // path (operator clicks "approve" in the queue UI) replays
    // identically through the same executor.
    const approvalId = createId();
    if (channelKind === 'email' && recipient && draft) {
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
      // Build the per-conversation customPrompt from the probe's
      // drafter steering. The reply-draft path
      // (conversation-agent.draftReply) reads
      // conversation_settings.customPrompt and appends it to its
      // system prompt — this is the single bridge that lets per-
      // probe formality + domain framing flow into reply generation
      // the same way it flows into first-touch generation.
      // Without this, replies revert to the default brokerage_direct
      // tone with no domain framing, which mismatches the first
      // touch the recipient just received.
      const probeCustomPrompt = buildProbeCustomPrompt({
        formalityLevel: probe.formalityLevel as
          | 'high'
          | 'professional'
          | 'casual'
          | null,
        domainHint: probe.domainHint,
      });
      const upsertRow: NewConversationSettings = {
        channel: 'email',
        conversationKey: recipient.email,
        aiEnabled: true,
        authority: 'chitchat_only',
        approvalMode: probeApprovalMode,
        tone: 'brokerage_direct',
        // Outreach-language seed: the EFFECTIVE outreach language
        // (probe override OR per-target country mapping) is what we
        // used to draft the first touch, so the reply path stays in
        // that language across the thread. Falls back to 'auto' when
        // even the per-target country mapping produces nothing
        // (multi-country probe with unmapped country → recipient's
        // reply language wins on the inbound side).
        language: effectiveOutreachLanguage ?? 'auto',
        identityDisclosure: 'on_request',
        linkedProbeId: probe.id,
        linkedEntitySlug: t.entitySlug,
        responseDelayMinSec: 0,
        responseDelayMaxSec: 0,
        maxTurns: 6,
        maxCostUsdCents: 100,
        maxDurationHours: 168,
        channelConfig: { source: 'market_probe_autopilot' },
        ...(probeCustomPrompt ? { customPrompt: probeCustomPrompt } : {}),
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
            // Language backfill: when this probe sets an outreach
            // language AND the existing conversation_settings row is
            // still on the default 'auto' (no operator override), upgrade
            // to the probe's language. Without this branch, an existing
            // row created by a previous English probe would stay on
            // 'auto' and the reply path would use the recipient's
            // detected language — which contradicts the probe's
            // intentional language choice. CASE expression in SQL so we
            // never overwrite an operator-set explicit language.
            ...(effectiveOutreachLanguage
              ? {
                  language: sql`CASE WHEN ${conversationSettings.language} = 'auto' THEN ${effectiveOutreachLanguage} ELSE ${conversationSettings.language} END`,
                }
              : {}),
            // Same shape for customPrompt — when the existing row has
            // no customPrompt and the probe sets steering, upgrade.
            // Operator-set customPrompt wins.
            ...(probeCustomPrompt
              ? {
                  customPrompt: sql`COALESCE(${conversationSettings.customPrompt}, ${probeCustomPrompt})`,
                }
              : {}),
            updatedAt: new Date(),
          },
        });
    } else if (channelKind === 'lead_form' && leadFormEndpoint) {
      // Form-aware drafter (PR 4). Reuses the same context pack the
      // email path built but emits a tighter form-shaped payload —
      // shorter message body capped at 800 chars, no signature, no
      // markdown, optional subject only when the form has a
      // subject_field. Single source of truth for "draft → field
      // values" lives in mapDraftToFieldValues.
      // probe.alias takes precedence over the LEAD_FORM_SENDER_NAME
      // env default — the probe's outreach persona drives the form's
      // name_field instead of the global fallback. Email +
      // company + phone keep their env defaults (per-probe From
      // address is intentionally out of scope; the probe identity
      // shifts display name + signature only). probe.email_signature_text
      // gets appended to the form message body since forms have no
      // dedicated signature field.
      //
      // Reply attribution: mint a sub-address token + use the
      // plus-addressed variant of the sender email so the
      // recipient's reply (which goes to the email field they fill
      // in their form acknowledgement) lands at hello+<token>@DOMAIN.
      // The resend-inbound webhook parses the token and resolves to
      // (probe, target) so the reply gets routed to this probe's
      // conversation context. Without this, lead-form replies land
      // at the bare sender address with NO probe linkage and the
      // operator sees an unattributed inbound.
      const tokenRow = await mintLeadFormSubmissionToken({
        probeId: probe.id,
        targetId: t.id,
        entitySlug: t.entitySlug,
        formUrl: leadFormEndpoint.url,
        approvalId,
      });
      const senderBaseEmail =
        process.env.LEAD_FORM_SENDER_EMAIL ?? 'hello@procur.app';
      const senderEmail = buildSubAddressedEmail(
        senderBaseEmail,
        tokenRow.token,
      );
      const formDraft = await draftLeadFormSubmission({
        pack,
        intent,
        doNotMention: probe.blockedTerms ?? [],
        // Mirror the email-path drafter steering — same per-probe
        // formality + domain hint + language apply regardless of
        // channel. outreachLanguage takes precedence over the form's
        // HTML lang attribute (operator override wins).
        formalityLevel:
          (probe.formalityLevel as
            | 'high'
            | 'professional'
            | 'casual'
            | null) ?? null,
        domainHint: probe.domainHint,
        outreachLanguage: effectiveOutreachLanguage,
        endpoint: {
          subjectField: leadFormEndpoint.subjectField,
          companyField: leadFormEndpoint.companyField,
          phoneField: leadFormEndpoint.phoneField,
          senderName:
            probe.alias ??
            process.env.LEAD_FORM_SENDER_NAME ??
            'Procur Outreach',
          senderEmail,
          senderCompany: process.env.LEAD_FORM_SENDER_COMPANY ?? null,
          senderPhone: process.env.LEAD_FORM_SENDER_PHONE ?? null,
          language: leadFormEndpoint.language,
        },
      });
      // Append probe signature to the form message body. Forms have
      // no dedicated signature field so the message has to carry it
      // inline. Skip when the drafter refused (REFUSED: prefix) — no
      // point appending a signature to a refusal stub.
      //
      // Length safety: the drafter caps message at 800 chars assuming
      // forms cap at 500-1000. Appending a signature pushes total
      // over. Truncate the message body to leave room for the
      // signature + separator within the 800-char ceiling. If the
      // signature alone is too long (operator wrote a 900-char
      // signature), we keep at least 200 chars of message body and
      // truncate the signature instead.
      if (
        probe.emailSignatureText &&
        !formDraft.message.startsWith('REFUSED:')
      ) {
        const FORM_BODY_CEILING = 800;
        const SEPARATOR = '\n\n--\n';
        const sig = probe.emailSignatureText;
        const sigPlusSep = SEPARATOR.length + sig.length;
        if (sigPlusSep + 200 > FORM_BODY_CEILING) {
          // Pathological: signature itself exceeds budget. Keep a
          // short message + truncated signature so the recipient
          // still gets identifiable sender info.
          const sigBudget = FORM_BODY_CEILING - 200 - SEPARATOR.length;
          formDraft.message =
            formDraft.message.slice(0, 200).trimEnd() +
            SEPARATOR +
            sig.slice(0, sigBudget);
        } else {
          const messageBudget = FORM_BODY_CEILING - sigPlusSep;
          formDraft.message =
            formDraft.message.slice(0, messageBudget).trimEnd() +
            SEPARATOR +
            sig;
        }
      }
      const fieldValues = mapDraftToFieldValues({
        draft: formDraft,
        endpoint: {
          nameField: leadFormEndpoint.nameField,
          emailField: leadFormEndpoint.emailField,
          subjectField: leadFormEndpoint.subjectField,
          messageField: leadFormEndpoint.messageField,
          companyField: leadFormEndpoint.companyField,
          phoneField: leadFormEndpoint.phoneField,
        },
      });
      // Cache draft + fieldValues on the loop variable so the
      // subsequent dispatch branch reuses them rather than redrawing.
      // (TS doesn't let us close over a let-binding from inside a
      // branch easily; using a plain const within this scope keeps
      // the dispatch branch reading a fresh ref via closure.)
      leadFormDraftFieldValues = fieldValues;
      leadFormDraft = formDraft;
      await db.insert(approvals).values({
        id: approvalId,
        agentRunId: null,
        actionType: 'lead_form.submit',
        proposedPayload: {
          kind: 'lead_form.submit',
          tier: 'T2',
          entity_slug: t.entitySlug,
          form_url: leadFormEndpoint.url,
          field_values: fieldValues,
          drafted_fields: {
            subject: formDraft.subject,
            message: formDraft.message,
            email: formDraft.senderEmail,
            name: formDraft.senderName,
            company: formDraft.senderCompany,
            phone: formDraft.senderPhone,
          },
          rationale: `Market Probe ${probe.id} autopilot (tier ${probe.tier}). Target ${t.id}; entity ${t.entitySlug}. Channel=lead_form (no email recipient available; eligible form endpoint discovered).`,
          actor_source: 'market_probe_autopilot',
          market_probe_id: probe.id,
          market_probe_target_id: t.id,
        },
        decision: 'auto_approved',
      });
      // No conversation_settings row for lead_form — form-side has
      // no inbound channel; replies arrive via email if the
      // recipient chooses to reply, and that path goes through the
      // email conversation_settings as usual.
    } else if (
      channelKind === 'rvm' &&
      rvmPhone &&
      rvmCountry &&
      rvmAudioLanguage
    ) {
      // RVM channel: pre-recorded audio asset gets played via Twilio
      // <Play> on machine_end_beep detection. The asset's text is
      // chosen at upload time (operator-curated transcript); the
      // dispatch-time payload only specifies which (probe, variant?,
      // language) tuple to look up. No drafter call here — RVM
      // doesn't have a per-target drafted message.
      await db.insert(approvals).values({
        id: approvalId,
        agentRunId: null,
        actionType: 'rvm.dispatch',
        proposedPayload: {
          kind: 'rvm.dispatch',
          tier: 'T2',
          probe_id: probe.id,
          entity_slug: t.entitySlug,
          variant_id: variant?.id ?? null,
          language: rvmAudioLanguage,
          to_number: rvmPhone.phone,
          recipient_country: rvmCountry,
          ...(rvmPhone.contactId ? { contact_id: rvmPhone.contactId } : {}),
          rationale: `Market Probe ${probe.id} autopilot (tier ${probe.tier}). Target ${t.id}; entity ${t.entitySlug}. Channel=rvm (no email recipient + no eligible lead-form). Phone source=${rvmPhone.source}.`,
          actor_source: 'market_probe_autopilot',
          market_probe_id: probe.id,
          market_probe_target_id: t.id,
          phone_source: rvmPhone.source,
        },
        decision: 'auto_approved',
      });
      // No conversation_settings row for rvm — voicemail has no
      // inbound channel. Recipient callbacks land outside any
      // probe-aware reply context; operator handles them manually.
    }

    let result: { ok: boolean; error?: string };
    if (channelKind === 'email' && recipient && draft) {
      result = await applyEmailSend(
        approvalId,
        {
          to: [recipient.email],
          subject: draft.emailSubject,
          body: draft.emailBody,
          rationale: `Market Probe ${probe.id} autopilot dispatch.`,
        },
        {
          // Per-probe outreach identity overrides the company-level
          // sender display name + signatures. NULL fields fall back
          // to companies.email_sender_display_name + signature_*.
          probeIdentity: {
            alias: probe.alias,
            emailSignatureText: probe.emailSignatureText,
            emailSignatureHtml: probe.emailSignatureHtml,
          },
        },
      );
    } else if (
      channelKind === 'lead_form' &&
      leadFormEndpoint &&
      leadFormDraft &&
      leadFormDraftFieldValues
    ) {
      result = await applyLeadFormSubmit(approvalId, {
        entitySlug: t.entitySlug,
        formUrl: leadFormEndpoint.url,
        fieldValues: leadFormDraftFieldValues,
        draftedFields: {
          subject: leadFormDraft.subject,
          message: leadFormDraft.message,
          email: leadFormDraft.senderEmail,
          name: leadFormDraft.senderName,
          company: leadFormDraft.senderCompany ?? undefined,
          phone: leadFormDraft.senderPhone ?? undefined,
        },
        rationale: `Market Probe ${probe.id} autopilot dispatch via lead_form.`,
      });
    } else if (
      channelKind === 'rvm' &&
      rvmPhone &&
      rvmCountry &&
      rvmAudioLanguage
    ) {
      const { applyRvmDispatch } = await import('@procur/ai');
      const dispatchResult = await applyRvmDispatch(approvalId, {
        probeId: probe.id,
        entitySlug: t.entitySlug,
        variantId: variant?.id ?? null,
        language: rvmAudioLanguage,
        toNumber: rvmPhone.phone,
        recipientCountry: rvmCountry,
        ...(rvmPhone.contactId ? { contactId: rvmPhone.contactId } : {}),
        rationale: `Market Probe ${probe.id} autopilot dispatch via rvm.`,
      });
      // Compliance refusals (quiet hours / cooldown / missing audio)
      // are not dispatch failures — they're "we declined to try" and
      // should leave the target on `pending` so the next batch can
      // retry within window. The downstream rollback already does
      // exactly that, but its skip reason is generic; map refusal
      // separately so the operator sees why.
      result = {
        ok: dispatchResult.ok,
        ...(dispatchResult.error ? { error: dispatchResult.error } : {}),
      };
      if (
        !dispatchResult.ok &&
        dispatchResult.refusedAtDispatch &&
        dispatchResult.error
      ) {
        result.error = `rvm refused at dispatch: ${dispatchResult.error}`;
      }
    } else {
      // Should be unreachable — channelKind is set by the eligibility
      // branch above and either recipient or leadFormEndpoint is
      // guaranteed non-null when channelKind is set. Defensive skip
      // so the type system doesn't have to encode that invariant.
      skipped.push({
        targetId: t.id,
        entitySlug: t.entitySlug,
        reason: 'channel selection failed (defensive)',
      });
      continue;
    }

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

/**
 * Resolve a recipient phone for a probe target's RVM dispatch.
 * Cheap-path-first fallback chain:
 *
 *   1. Apollo enrichment cache row with phone populated. Apollo's
 *      directPhone is verified at enrichment time; prefer over
 *      operator-curated rolodex when both exist.
 *   2. Rolodex contact (organizations → contact_org_memberships →
 *      contacts.phones[0]). Operator-curated; useful when no Apollo
 *      pass has run on this entity.
 *   3. external_suppliers.phone (when entitySlug is a UUID — i.e.
 *      the entity came in from the external-suppliers ingest path
 *      and has a contact-form-style phone on file).
 *   4. Apollo enrichPerson (paid; gated). Only fires when the probe
 *      has `allowPaidEnrichment=true` AND a tenant id is in scope.
 *      Looks for an Apollo cache row with apolloPersonId populated
 *      but phone null — i.e. the operator already confirmed this
 *      person via the Decision-makers panel but didn't pay for the
 *      direct phone. Highest seniority wins; cap and cost-ledger
 *      enforcement live inside enrichPerson itself.
 *
 * Returns null when every path falls through. Caller is expected to
 * skip the target on the RVM channel — the autopilot's three-way
 * channel selection then drops back to lead_form, or skips entirely
 * when no channel is viable.
 */
async function resolveRecipientPhone(
  entitySlug: string,
  options: {
    allowPaidEnrichment: boolean;
    companyId: string | null;
  },
): Promise<{
  phone: string;
  source: 'apollo_cache' | 'rolodex' | 'external_supplier' | 'apollo_enrich';
  contactId?: string;
  apolloPersonId?: string;
} | null> {
  // Stage 1 — Apollo cache, phone populated, highest seniority wins.
  const apolloPhoneRows = await db.execute<{
    id: string;
    phone: string;
    apollo_person_id: string | null;
  }>(sql`
    SELECT id, phone, apollo_person_id
      FROM entity_contact_enrichments
     WHERE entity_slug = ${entitySlug}
       AND source = 'apollo'
       AND phone IS NOT NULL
       AND phone <> ''
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
  const apolloPhone = (
    apolloPhoneRows.rows as Array<{
      id?: string;
      phone?: string;
      apollo_person_id?: string | null;
    }>
  )[0];
  if (apolloPhone?.phone) {
    return {
      phone: apolloPhone.phone,
      source: 'apollo_cache',
      contactId: apolloPhone.id,
      ...(apolloPhone.apollo_person_id
        ? { apolloPersonId: apolloPhone.apollo_person_id }
        : {}),
    };
  }

  // Stage 2 — rolodex contact phones[0].
  const orgRow = await db.execute<{ org_id: string }>(sql`
    SELECT id AS org_id
      FROM organizations
     WHERE external_keys->>'known_entity_slug' = ${entitySlug}
     LIMIT 1
  `);
  const orgId = (orgRow.rows as Array<{ org_id?: string }>)[0]?.org_id;
  if (orgId) {
    const [membership] = await db
      .select({ contactId: contactOrgMemberships.contactId })
      .from(contactOrgMemberships)
      .where(eq(contactOrgMemberships.orgId, orgId))
      .orderBy(desc(contactOrgMemberships.isPrimary))
      .limit(1);
    if (membership) {
      const [contact] = await db
        .select({ id: contacts.id, phones: contacts.phones })
        .from(contacts)
        .where(eq(contacts.id, membership.contactId))
        .limit(1);
      const firstPhone = (contact?.phones ?? []).find(
        (p) => typeof p === 'string' && p.length > 0,
      );
      if (firstPhone) {
        return { phone: firstPhone, source: 'rolodex', contactId: contact!.id };
      }
    }
  }

  // Stage 3 — external_suppliers.phone (slug-as-UUID path).
  const externalRow = await db.execute<{ phone: string }>(sql`
    SELECT phone
      FROM external_suppliers
     WHERE id::text = ${entitySlug}
       AND phone IS NOT NULL
       AND phone <> ''
     LIMIT 1
  `);
  const externalPhone = (externalRow.rows as Array<{ phone?: string }>)[0]
    ?.phone;
  if (externalPhone) {
    return { phone: externalPhone, source: 'external_supplier' };
  }

  // Stage 4 — paid Apollo enrichPerson, gated.
  if (!options.allowPaidEnrichment || !options.companyId) {
    return null;
  }
  const enrichablePersonRows = await db.execute<{
    apollo_person_id: string;
  }>(sql`
    SELECT apollo_person_id
      FROM entity_contact_enrichments
     WHERE entity_slug = ${entitySlug}
       AND source = 'apollo'
       AND apollo_person_id IS NOT NULL
       AND (phone IS NULL OR phone = '')
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
  const enrichTarget = (
    enrichablePersonRows.rows as Array<{ apollo_person_id?: string }>
  )[0]?.apollo_person_id;
  if (!enrichTarget) return null;

  const { enrichPerson } = await import('@procur/apollo');
  const result = await enrichPerson({
    apolloPersonId: enrichTarget,
    entitySlug,
    companyId: options.companyId,
  });
  if (!('ok' in result) || result.ok === false) return null;
  const phone = result.full.directPhone;
  if (!phone) return null;
  return {
    phone,
    source: 'apollo_enrich',
    apolloPersonId: result.apolloPersonId,
  };
}

/**
 * Resolve a recipient country (ISO-3166-1 alpha-2) for an entity.
 * Two-stage: known_entities.country (canonical slug path) →
 * external_suppliers.country (UUID path). Returns null when neither
 * lookup matches; caller skips the target on the RVM channel since
 * quiet-hours enforcement requires a country.
 */
async function resolveRecipientCountry(
  entitySlug: string,
): Promise<string | null> {
  const [knownEntity] = await db
    .select({ country: knownEntities.country })
    .from(knownEntities)
    .where(eq(knownEntities.slug, entitySlug))
    .limit(1);
  if (knownEntity?.country) return knownEntity.country.toUpperCase();

  const externalRow = await db.execute<{ country: string }>(sql`
    SELECT country
      FROM external_suppliers
     WHERE id::text = ${entitySlug}
       AND country IS NOT NULL
       AND country <> ''
     LIMIT 1
  `);
  const externalCountry = (externalRow.rows as Array<{ country?: string }>)[0]
    ?.country;
  if (!externalCountry) return null;
  // external_suppliers.country can be a free-form string ("United
  // States", "USA", "Côte d'Ivoire"). Normalize via the same
  // shared resolver the chat tools use; bail when normalization
  // fails rather than dispatching to an unknowable timezone.
  const { normalizeCountryCode } = await import('./country-codes');
  return normalizeCountryCode(externalCountry);
}

// suppress unused-import lint on intentional re-exports
void organizations;

/**
 * Build the per-conversation customPrompt the autopilot seeds onto
 * conversation_settings at first contact. Translates the probe's
 * drafter-steering (formalityLevel + domainHint) into reply-path-
 * shaped guidance the conversation-agent's draftReply consumes.
 *
 * Single source of truth for "per-probe steering" — the first-touch
 * drafter (communication-recommendations.buildSteeringBlock) and the
 * reply drafter (conversation-agent.draftReply via customPrompt)
 * both derive from the same probe columns. Without this connector,
 * replies would silently drop back to the default brokerage_direct
 * tone with no domain framing, mismatching the first touch the
 * recipient just received.
 *
 * Returns null when the probe has no steering set — preserves the
 * conversation-agent's existing behavior (no customPrompt = base
 * system prompt only) for probes that don't customize.
 */
function buildProbeCustomPrompt(input: {
  formalityLevel: 'high' | 'professional' | 'casual' | null;
  domainHint: string | null;
}): string | null {
  const lines: string[] = [];
  // Shared phrasing — same source of truth as the first-touch
  // drafter's STEERING block, just with reply-path framing.
  // Keeping these in lockstep prevents the historical drift bug
  // where reply-path used different wording than first-touch.
  const formality = probeFormalityGuidance(input.formalityLevel);
  if (formality) {
    lines.push(`Formality: ${input.formalityLevel?.toUpperCase()} — ${formality}`);
  }
  const hint = probeDomainHintGuidance(input.domainHint);
  if (hint) lines.push(`Domain framing: ${hint}`);
  return lines.length > 0 ? lines.join('\n') : null;
}
