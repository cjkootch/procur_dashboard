import 'server-only';
import { eq, and, gte, isNull, sql } from 'drizzle-orm';
import {
  approvals,
  contacts,
  db,
  events,
  rvmAudioAssets,
  touchpoints,
} from '@procur/db';
import { createId } from '../agents/id';
import type { MlEvidenceT } from '../agents/action-descriptor';
import { PostgresCostLedger } from '../cost-ledger';
import {
  buildOutreachMetadata,
  type OutreachEvidence,
} from './outreach-evidence';
import { isWithinQuietHours } from '../lib/country-timezone';

/**
 * rvm.dispatch executor — closes the autopilot + chat-assistant
 * approval-queue loop for the ringless-voicemail channel.
 *
 * When an `rvm.dispatch` approval flips to `approved` (or
 * `auto_approved` per probe.tier ≥ 1), this:
 *
 *   1. Re-checks compliance gates LIVE at dispatch time:
 *      - Quiet hours (8am-6pm recipient-local default; recipient
 *        country resolves to IANA timezone via country-timezone
 *        lookup)
 *      - Per-recipient cooldown (168h since last RVM touchpoint
 *        to the same number — defensive against operator iteration
 *        that would otherwise re-leave voicemails)
 *      - Active audio asset exists for (probe, variant?, language)
 *
 *   2. Resolves the audio asset URL from rvm_audio_assets via
 *      pickActiveAudioAssetForDispatch (variant-specific wins over
 *      probe-default).
 *
 *   3. Twilio.calls.create with:
 *        - machineDetection: 'DetectMessageEnd'
 *        - machineDetectionTimeout: 30 (seconds; default Twilio is
 *          30s but we set explicitly to make intent clear)
 *        - asyncAmd: true (lets TwiML respond to the AMD result via
 *          the asyncAmdStatusCallback, rather than blocking call
 *          setup)
 *        - url: TwiML route at /api/webhooks/twilio/twiml?mode=rvm
 *          which branches on AnsweredBy:
 *            - machine_end_beep → <Play> the audio
 *            - human / human_or_machine_unknown → <Hangup/> (RVM
 *              is voicemail-only by intent; we don't talk to humans
 *              on this channel)
 *
 *   4. Writes voice.initiated touchpoint (channel='rvm') + audit
 *      event + cost-ledger entry. CallDuration / completion arrives
 *      via the status-callback webhook and writes follow-up rows
 *      same way the existing outbound_call executor does.
 *
 * Idempotent: if applied_at is already set on the approval, the
 * executor is a no-op. Twilio idempotency comes from the approval
 * id propagated in the call's friendly_name + the per-recipient
 * cooldown gate.
 */

export interface RvmDispatchPayload {
  probeId: string;
  entitySlug: string;
  variantId?: string | null;
  language: string;
  toNumber: string;
  recipientCountry: string;
  contactId?: string;
  rationale: string;
  evidenceJson?: Record<string, unknown>;
  mlEvidence?: MlEvidenceT;
  sourceEntitySlug?: string;
  sourceSignalId?: string;
  sourceOpportunityId?: string;
  riskWarnings?: string[];
  doNotMention?: string[];
}

export interface RvmDispatchResult {
  ok: boolean;
  callSid?: string;
  touchpointId?: string;
  error?: string;
  /** True when we declined to dispatch because a compliance gate
   *  failed (quiet hours / cooldown / audio missing). Distinguishes
   *  "we wouldn't try" from "we tried and Twilio failed" so the
   *  autopilot can roll back the target to `pending` cleanly. */
  refusedAtDispatch?: boolean;
}

export interface RvmDispatchOptions {
  companyId?: string;
  /** Override quiet-hours window for testing or operator-set
   *  per-probe windows. Default 8am-6pm. */
  quietHoursStart?: number;
  quietHoursEnd?: number;
  /** Per-recipient cooldown window in hours. Default 168h (one
   *  week). Set to 0 to disable for testing. */
  cooldownHours?: number;
}

const FROM_PHONE = process.env.TWILIO_PHONE_NUMBER ?? null;
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.procur.app';
const DEFAULT_COOLDOWN_HOURS = 168;
const costLedger = new PostgresCostLedger();

export async function applyRvmDispatch(
  approvalId: string,
  payload: RvmDispatchPayload,
  options: RvmDispatchOptions = {},
): Promise<RvmDispatchResult> {
  if (!FROM_PHONE) {
    return {
      ok: false,
      error: 'TWILIO_PHONE_NUMBER not configured',
    };
  }

  // Idempotency.
  const existing = await db
    .select({ appliedAt: approvals.appliedAt })
    .from(approvals)
    .where(eq(approvals.id, approvalId))
    .limit(1);
  if (existing[0]?.appliedAt) return { ok: true };

  // Compliance gate 1: quiet hours.
  const window = isWithinQuietHours({
    country: payload.recipientCountry,
    ...(options.quietHoursStart !== undefined
      ? { startHour: options.quietHoursStart }
      : {}),
    ...(options.quietHoursEnd !== undefined
      ? { endHour: options.quietHoursEnd }
      : {}),
  });
  if (!window.allowed) {
    return {
      ok: false,
      refusedAtDispatch: true,
      error: `recipient-local hour ${window.recipientHour} (${window.timezone}) is outside the allowed RVM window (${options.quietHoursStart ?? 8}-${options.quietHoursEnd ?? 18}); requeue for later`,
    };
  }

  // Compliance gate 2: per-recipient cooldown. Look at touchpoints
  // with channel='rvm' on the same to_number within the cooldown
  // window. This is metadata-keyed since touchpoints stores the
  // dialed number in metadata.to_number for rvm rows.
  const cooldownHours = options.cooldownHours ?? DEFAULT_COOLDOWN_HOURS;
  if (cooldownHours > 0) {
    const cutoff = new Date(Date.now() - cooldownHours * 60 * 60 * 1000);
    const recentRvm = await db
      .select({ id: touchpoints.id })
      .from(touchpoints)
      .where(
        and(
          eq(touchpoints.channel, 'rvm'),
          gte(touchpoints.occurredAt, cutoff),
          sql`${touchpoints.metadata}->>'to_number' = ${payload.toNumber}`,
        ),
      )
      .limit(1);
    if (recentRvm.length > 0) {
      return {
        ok: false,
        refusedAtDispatch: true,
        error: `recent RVM touchpoint to ${payload.toNumber} within ${cooldownHours}h cooldown; skipping`,
      };
    }
  }

  // Compliance gate 3: active audio asset for (probe, variant?,
  // language) must exist. Inlined SQL rather than importing from
  // @procur/catalog — @procur/ai sits below catalog in the
  // dependency graph and the catalog helper would create a cycle.
  // Variant-specific wins over probe-default; both must be active.
  let asset:
    | {
        id: string;
        audioUrl: string;
        durationMs: number | null;
        voiceProfileId: string | null;
        generatedVia: string;
      }
    | null = null;
  if (payload.variantId) {
    const [variantSpecific] = await db
      .select({
        id: rvmAudioAssets.id,
        audioUrl: rvmAudioAssets.audioUrl,
        durationMs: rvmAudioAssets.durationMs,
        voiceProfileId: rvmAudioAssets.voiceProfileId,
        generatedVia: rvmAudioAssets.generatedVia,
      })
      .from(rvmAudioAssets)
      .where(
        and(
          eq(rvmAudioAssets.probeId, payload.probeId),
          eq(rvmAudioAssets.variantId, payload.variantId),
          eq(rvmAudioAssets.language, payload.language),
          eq(rvmAudioAssets.isActive, true),
        ),
      )
      .limit(1);
    if (variantSpecific) asset = variantSpecific;
  }
  if (!asset) {
    const [probeDefault] = await db
      .select({
        id: rvmAudioAssets.id,
        audioUrl: rvmAudioAssets.audioUrl,
        durationMs: rvmAudioAssets.durationMs,
        voiceProfileId: rvmAudioAssets.voiceProfileId,
        generatedVia: rvmAudioAssets.generatedVia,
      })
      .from(rvmAudioAssets)
      .where(
        and(
          eq(rvmAudioAssets.probeId, payload.probeId),
          isNull(rvmAudioAssets.variantId),
          eq(rvmAudioAssets.language, payload.language),
          eq(rvmAudioAssets.isActive, true),
        ),
      )
      .limit(1);
    if (probeDefault) asset = probeDefault;
  }
  if (!asset) {
    return {
      ok: false,
      refusedAtDispatch: true,
      error: `no active rvm audio asset for probe ${payload.probeId} / language ${payload.language}${payload.variantId ? ` / variant ${payload.variantId}` : ''}`,
    };
  }

  // Resolve org via contact for touchpoint linkage.
  let orgIdForTouchpoint: string | null = null;
  if (payload.contactId) {
    const [contactRow] = await db
      .select({ orgId: contacts.orgId })
      .from(contacts)
      .where(eq(contacts.id, payload.contactId))
      .limit(1);
    orgIdForTouchpoint = contactRow?.orgId ?? null;
  }

  // Build TwiML URL — the route at /api/webhooks/twilio/twiml
  // serves mode=rvm which plays the audio on machine_end_beep
  // and hangs up otherwise.
  const twimlUrl = new URL(`${APP_URL}/api/webhooks/twilio/twiml`);
  twimlUrl.searchParams.set('approval', approvalId);
  twimlUrl.searchParams.set('mode', 'rvm');
  twimlUrl.searchParams.set('audio', asset.audioUrl);

  const statusUrl = new URL(`${APP_URL}/api/webhooks/twilio`);
  statusUrl.searchParams.set('kind', 'status');
  statusUrl.searchParams.set('approval', approvalId);

  // Lazy import twilio so the @procur/ai bundle doesn't pull it
  // unconditionally — same pattern existing applyOutboundCall uses.
  let callSid: string;
  try {
    const twilioMod = (await import('twilio')) as unknown as {
      default: (sid: string, token: string) => {
        calls: { create: (args: Record<string, unknown>) => Promise<{ sid: string }> };
      };
    };
    const twilio = twilioMod.default(
      process.env.TWILIO_ACCOUNT_SID ?? '',
      process.env.TWILIO_AUTH_TOKEN ?? '',
    );
    const call = await twilio.calls.create({
      from: FROM_PHONE,
      to: payload.toNumber,
      url: twimlUrl.toString(),
      method: 'POST',
      statusCallback: statusUrl.toString(),
      statusCallbackEvent: ['completed'],
      // MachineDetection — this is the core RVM mechanic. Twilio
      // listens for the voicemail beep, then triggers the TwiML
      // fetch only after detecting machine_end_beep / machine_start
      // / human. The TwiML route reads AnsweredBy and decides
      // whether to play or hang up.
      machineDetection: 'DetectMessageEnd',
      machineDetectionTimeout: 30,
      machineDetectionSpeechThreshold: 2400,
      machineDetectionSpeechEndThreshold: 1200,
      machineDetectionSilenceTimeout: 5000,
      asyncAmd: 'true',
      // Friendly-name surfaces in Twilio Console + status callbacks
      // — useful when debugging which approval / probe a given
      // call belongs to.
    });
    callSid = call.sid;
  } catch (err) {
    return {
      ok: false,
      error: `twilio call.create failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Persist outbound touchpoint.
  const evidence: OutreachEvidence = {
    ...(payload.evidenceJson ? { evidenceJson: payload.evidenceJson } : {}),
    ...(payload.mlEvidence ? { mlEvidence: payload.mlEvidence } : {}),
    ...(payload.sourceEntitySlug
      ? { sourceEntitySlug: payload.sourceEntitySlug }
      : {}),
    ...(payload.sourceSignalId
      ? { sourceSignalId: payload.sourceSignalId }
      : {}),
    ...(payload.sourceOpportunityId
      ? { sourceOpportunityId: payload.sourceOpportunityId }
      : {}),
    ...(payload.riskWarnings ? { riskWarnings: payload.riskWarnings } : {}),
    ...(payload.doNotMention ? { doNotMention: payload.doNotMention } : {}),
  };
  const touchpointId = createId();
  const occurredAt = new Date();
  await db.insert(touchpoints).values({
    id: touchpointId,
    contactId: payload.contactId ?? null,
    orgId: orgIdForTouchpoint,
    channel: 'rvm',
    occurredAt,
    metadata: {
      provider_call_id: callSid,
      to_number: payload.toNumber,
      probe_id: payload.probeId,
      entity_slug: payload.entitySlug,
      variant_id: payload.variantId ?? null,
      language: payload.language,
      audio_asset_id: asset.id,
      audio_url: asset.audioUrl,
      audio_duration_ms: asset.durationMs,
      voice_profile_id: asset.voiceProfileId,
      generated_via: asset.generatedVia,
      recipient_country: payload.recipientCountry,
      recipient_local_hour: window.recipientHour,
      recipient_timezone: window.timezone,
      rationale: payload.rationale,
      approval_id: approvalId,
      ...buildOutreachMetadata(evidence),
    },
  });

  await db.insert(events).values({
    id: createId(),
    verb: 'rvm.dispatched',
    subjectType: 'approval',
    subjectId: approvalId,
    actorType: 'system',
    actorId: 'rvm-dispatch-executor',
    objectType: 'touchpoint',
    objectId: touchpointId,
    occurredAt,
    idempotencyKey: `rvm.dispatched:${approvalId}`,
    metadata: {
      provider_call_id: callSid,
      to_number: payload.toNumber,
      probe_id: payload.probeId,
      entity_slug: payload.entitySlug,
      audio_asset_id: asset.id,
      ...buildOutreachMetadata(evidence),
    },
  });

  await costLedger.record({
    idempotencyKey: `rvm.dispatch:${approvalId}`,
    operation: 'pstn.call',
    provider: 'twilio',
    units: 1,
    unitKind: 'calls',
    // Per-call setup cost. Per-minute cost arrives via the status
    // callback when CallDuration lands.
    costUsdMicros: 0,
    occurredAt,
  });

  await db
    .update(approvals)
    .set({ appliedAt: occurredAt, appliedObjectId: callSid })
    .where(eq(approvals.id, approvalId));

  return { ok: true, callSid, touchpointId };
}

/** Mirror of parseEmailSendPayload / parseLeadFormSubmitPayload —
 *  reads the snake_case + camelCase variants the autopilot and chat
 *  tool use respectively. Returns null on shape mismatch. */
export function parseRvmDispatchPayload(
  raw: Record<string, unknown>,
): RvmDispatchPayload | null {
  const probeId =
    typeof raw['probeId'] === 'string'
      ? raw['probeId']
      : typeof raw['probe_id'] === 'string'
        ? (raw['probe_id'] as string)
        : null;
  const entitySlug =
    typeof raw['entitySlug'] === 'string'
      ? raw['entitySlug']
      : typeof raw['entity_slug'] === 'string'
        ? (raw['entity_slug'] as string)
        : null;
  const language =
    typeof raw['language'] === 'string' ? raw['language'] : null;
  const toNumber =
    typeof raw['toNumber'] === 'string'
      ? raw['toNumber']
      : typeof raw['to_number'] === 'string'
        ? (raw['to_number'] as string)
        : null;
  const recipientCountry =
    typeof raw['recipientCountry'] === 'string'
      ? raw['recipientCountry']
      : typeof raw['recipient_country'] === 'string'
        ? (raw['recipient_country'] as string)
        : null;
  const rationale =
    typeof raw['rationale'] === 'string' ? raw['rationale'] : null;
  if (!probeId || !entitySlug || !language || !toNumber || !recipientCountry || !rationale) {
    return null;
  }
  return {
    probeId,
    entitySlug,
    language,
    toNumber,
    recipientCountry: recipientCountry.toUpperCase(),
    rationale,
    variantId:
      typeof raw['variantId'] === 'string'
        ? raw['variantId']
        : typeof raw['variant_id'] === 'string'
          ? (raw['variant_id'] as string)
          : null,
    contactId:
      typeof raw['contactId'] === 'string'
        ? raw['contactId']
        : typeof raw['contact_id'] === 'string'
          ? (raw['contact_id'] as string)
          : undefined,
  };
}
