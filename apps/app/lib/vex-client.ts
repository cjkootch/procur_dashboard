import 'server-only';

/**
 * Outbound HTTP client for procur → vex calls.
 *
 * Used by every "push to vex" surface in procur:
 *   - apps/app/lib/assistant/apply.ts (single + bulk chat-tool apply)
 *   - apps/app/app/api/match-queue/[id]/push-to-vex/route.ts
 *   - apps/app/app/api/entities/[slug]/push-to-vex/route.ts
 *
 * Authenticated via `VEX_API_TOKEN` (set on the procur deployment env).
 * Vex verifies the same value on its inbound side.
 *
 * Direction note: this is the OPPOSITE of vex → procur calls — those
 * use `PROCUR_API_TOKEN` and hit our `/api/intelligence/*` surface
 * (see `intelligence-auth.ts`). Two distinct tokens, two distinct
 * trust boundaries.
 *
 * Vex's actual inbound contract (confirmed via smoke test against the
 * fly deploy):
 *   POST {VEX_API_BASE_URL}/ingest/procur/leads
 *   Authorization: Bearer ${VEX_API_TOKEN}
 *   Content-Type: application/json
 *   body: { procurOpportunityId, buyer: {legalName, entitySlug?, domain?, ...}, contacts: [{name?, email?, phone?}], notes? }
 *   201:  { leadId, orgId, contacts: [{contactId, outcome}], wasExisting, vexUrl }
 *   4xx:  { error, message }
 *
 * Procur internally still talks in "contact" terminology (see
 * VexContactPayload below), and this module adapts that shape to
 * vex's lead-ingest contract on the way out and back. Callers don't
 * need to know vex's noun.
 *
 * Override base URL via env for staging / local-dev:
 *   VEX_API_BASE_URL=https://staging-vex-api.fly.dev
 */
const DEFAULT_BASE_URL = 'https://vex-api.fly.dev';
const PATH = '/ingest/procur/leads';
const TIMEOUT_MS = 10_000;

export type VexContactPayload = {
  /** Source identifiers — let vex dedupe against any prior push.
      Sent as `procurOpportunityId` on the wire. */
  source: 'procur';
  sourceRef: string;

  /** Identity. */
  legalName: string;
  country: string | null;
  role: string | null;

  /** Optional contact details if the user fills them in or the
      rolodex carries them. Most known_entities rows don't have
      contact details — left null in that case. */
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;

  /** Commercial context — feeds vex's enrichment worker so it
      understands who this counterparty is on landing. Sent as
      structured-then-flattened text in `notes` since vex's documented
      contract surface today is just `notes`; the worker can pattern-
      match what it needs. */
  commercialContext: {
    categories: string[];
    awardCount: number;
    awardTotalUsd: number | null;
    daysSinceLastAward: number | null;
    distressSignals: Array<{
      kind: string;
      detail: string;
      observedAt: string | null;
    }>;
    notes: string | null;
    procurEntityProfileUrl: string;
  };

  /** Why the procur user pushed this entity now. The assistant's
      summary of the chat thread that surfaced the entity, plus any
      free-text the user added. Vex's worker uses this as origination
      context. */
  originationContext: {
    triggeredBy: string;
    chatSummary: string | null;
    userNote: string | null;
    pushedAt: string;
  };
};

export type VexContactResponse = {
  /** The first created/matched contact's id (vex returns an array;
      we surface contacts[0].contactId here for the single-contact
      callers). Falls back to leadId if the contacts array is empty. */
  vexContactId: string;
  /** Link to the lead record in vex's UI (vex's response field is
      `vexUrl`; we keep the procur-side name `vexRecordUrl` to avoid
      churning every call site). */
  vexRecordUrl: string;
  /** True when vex matched the push to an existing lead instead of
      creating a new one. Sourced from vex's `wasExisting`. */
  dedupedAgainstExisting: boolean;
};

export type VexClientResult =
  | { ok: true; data: VexContactResponse }
  | { ok: false; error: string; status?: number };

type VexLeadResponse = {
  leadId: string;
  orgId: string;
  contacts?: Array<{ contactId: string; outcome: string }>;
  wasExisting?: boolean;
  vexUrl: string;
};

/**
 * POST a contact-creation push to vex. Adapts the procur-side
 * VexContactPayload shape to vex's lead-ingest contract.
 */
export async function pushVexContact(
  payload: VexContactPayload,
): Promise<VexClientResult> {
  const token = process.env.VEX_API_TOKEN;
  if (!token) {
    return {
      ok: false,
      error: 'VEX_API_TOKEN not configured on procur deployment',
    };
  }
  const baseUrl = process.env.VEX_API_BASE_URL ?? DEFAULT_BASE_URL;
  const url = `${baseUrl.replace(/\/$/, '')}${PATH}`;

  const body = mapToVexLeadBody(payload);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return {
        ok: false,
        status: res.status,
        error: `vex inbound ${res.status}: ${text.slice(0, 300)}`,
      };
    }

    const json = (await res.json()) as VexLeadResponse;
    return {
      ok: true,
      data: {
        vexContactId: json.contacts?.[0]?.contactId ?? json.leadId,
        vexRecordUrl: json.vexUrl,
        dedupedAgainstExisting: json.wasExisting === true,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `vex push failed: ${msg}` };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Map procur's contact-shaped payload onto vex's lead-ingest body.
 *
 * The buyer block carries identity (legalName + entitySlug for
 * dedup, optional country / role / categories for enrichment hints).
 * The contacts array carries person-level details if known. The
 * notes field flattens chatSummary + userNote + the structured
 * commercialContext into the single free-text slot vex's documented
 * contract surfaces today.
 */
function mapToVexLeadBody(payload: VexContactPayload): Record<string, unknown> {
  const cc = payload.commercialContext;
  const oc = payload.originationContext;

  const contacts: Array<Record<string, unknown>> = [];
  if (payload.contactName || payload.contactEmail || payload.contactPhone) {
    const contact: Record<string, unknown> = {};
    if (payload.contactName) contact.name = payload.contactName;
    if (payload.contactEmail) contact.email = payload.contactEmail;
    if (payload.contactPhone) contact.phone = payload.contactPhone;
    contacts.push(contact);
  }

  const notes = composeNotes(payload);

  return {
    procurOpportunityId: payload.sourceRef,
    buyer: {
      legalName: payload.legalName,
      ...(payload.country ? { country: payload.country } : {}),
      ...(payload.role ? { role: payload.role } : {}),
      ...(cc.categories.length > 0 ? { categories: cc.categories } : {}),
      ...(cc.procurEntityProfileUrl
        ? { procurEntityProfileUrl: cc.procurEntityProfileUrl }
        : {}),
    },
    contacts,
    ...(notes ? { notes } : {}),
    metadata: {
      source: payload.source,
      sourceRef: payload.sourceRef,
      triggeredBy: oc.triggeredBy,
      pushedAt: oc.pushedAt,
      awardCount: cc.awardCount,
      awardTotalUsd: cc.awardTotalUsd,
      daysSinceLastAward: cc.daysSinceLastAward,
      distressSignals: cc.distressSignals,
    },
  };
}

function composeNotes(payload: VexContactPayload): string | null {
  const oc = payload.originationContext;
  const cc = payload.commercialContext;

  const parts: string[] = [];
  if (oc.chatSummary) parts.push(oc.chatSummary);
  if (oc.userNote) parts.push(`User note: ${oc.userNote}`);

  const factBits: string[] = [];
  if (cc.awardCount > 0) {
    const total = cc.awardTotalUsd
      ? ` (~$${Math.round(cc.awardTotalUsd / 1_000_000)}M total)`
      : '';
    factBits.push(`${cc.awardCount} public-tender awards${total}`);
  }
  if (cc.daysSinceLastAward != null) {
    factBits.push(`last award ${cc.daysSinceLastAward}d ago`);
  }
  if (cc.distressSignals.length > 0) {
    factBits.push(`${cc.distressSignals.length} distress signal(s)`);
  }
  if (factBits.length > 0) {
    parts.push(`Procur context: ${factBits.join(', ')}.`);
  }
  if (cc.notes) parts.push(cc.notes);

  return parts.length > 0 ? parts.join('\n\n') : null;
}
