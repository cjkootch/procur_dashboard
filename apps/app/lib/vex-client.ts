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

/**
 * Per-tenant KYC / approval state that procur tracks against this
 * counterparty. Mirrors `supplier_approvals.status`. When present,
 * vex should treat this as authoritative on the procur side and
 * stamp the lead's transactability accordingly (a procur user
 * who's KYC'd a supplier doesn't need vex to re-onboard them from
 * scratch).
 */
export type VexApprovalContext = {
  status:
    | 'pending'
    | 'kyc_in_progress'
    | 'approved_without_kyc'
    | 'approved_with_kyc'
    | 'rejected'
    | 'expired';
  /** ISO-8601 timestamp the approval moved into approved_*. */
  approvedAt: string | null;
  /** ISO-8601 KYC re-cert date. When in the past, the badge shows
   *  expired and the lead should be flagged for renewal in vex. */
  expiresAt: string | null;
  notes: string | null;
};

/**
 * One product spec key/value extracted from an uploaded document
 * (typically the ASTM table on a refinery datasheet). Sent verbatim
 * — vex should NOT round or normalize, since spec deviations are
 * material to deal acceptance.
 */
export type VexProductSpec = {
  /** Free text — usually a parameter name (e.g. "Sulphur Content"). */
  property: string;
  /** Optional ASTM method code (e.g. "D5453"). */
  astmMethod: string | null;
  /** Free text — units (e.g. "mg/kg (ppm)", "Celsius"). */
  units: string | null;
  min: string | null;
  max: string | null;
  /** Free-text typical / target value when min/max aren't a range. */
  typical: string | null;
};

/**
 * Pointer to the source document the push originated from (proforma
 * recap PDF, refinery datasheet, screenshot of a website). Helps
 * vex's worker resolve the lead's provenance and lets a vex user
 * click through to the original doc instead of re-asking procur.
 */
export type VexSourceDocument = {
  /** Public Vercel Blob URL. Survives indefinitely (we don't expire
   *  blobs); vex can mirror to its own storage if it wants. */
  url: string;
  /** image/* or application/pdf. */
  contentType: string;
  filename: string;
};

/** Snapshot of the live benchmark + the procur user's trading
 *  defaults at push time. Gives vex the context to know what kind
 *  of deal flow this counterparty fits — without round-tripping
 *  back to procur for every enrichment step. */
export type VexMarketContext = {
  /** ISO-8601 of the latest benchmark row at push time. */
  benchmarkAsOf: string | null;
  brentSpotUsdPerBbl: number | null;
  nyhDieselSpotUsdPerGal: number | null;
  nyhGasolineSpotUsdPerGal: number | null;
};

/** Procur company's trading-economics defaults — same fields the
 *  /settings page exposes. Lets vex segment leads by the buyer's
 *  desk profile (e.g., "Med-default desks targeting >5% gross"). */
export type VexProcurTradingDefaults = {
  defaultSourcingRegion: string | null;
  targetGrossMarginPct: number | null;
  targetNetMarginPerUsg: number | null;
  monthlyFixedOverheadUsdDefault: number | null;
};

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
  /** Optional contact metadata — title (e.g. "Board Member") and
   *  LinkedIn URL when surfaced by the doc-extraction flow. */
  contactTitle: string | null;
  contactLinkedinUrl: string | null;

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

  /** Per-tenant KYC / approval state. Null when the procur user has
   *  not engaged with this counterparty yet. */
  approvalContext: VexApprovalContext | null;

  /** Product specs lifted from an uploaded datasheet / proforma.
   *  Empty array when the push didn't originate from a document or
   *  when the doc had no structured spec table. */
  productSpecs: VexProductSpec[];

  /** Set of source documents (PDFs / images) that informed the
   *  push. Often the proforma recap or datasheet the chat
   *  extraction came from. Empty when not applicable. */
  sourceDocuments: VexSourceDocument[];

  /** Live market snapshot at push time. Useful for vex to gauge
   *  the price environment a deal flow is being initiated in. */
  marketContext: VexMarketContext | null;

  /** Procur company's trading-economics defaults — see
   *  /settings → "Trading economics". Lets vex understand the
   *  desk profile pushing the lead. */
  procurTradingDefaults: VexProcurTradingDefaults | null;
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
  if (
    payload.contactName ||
    payload.contactEmail ||
    payload.contactPhone ||
    payload.contactTitle ||
    payload.contactLinkedinUrl
  ) {
    const contact: Record<string, unknown> = {};
    if (payload.contactName) contact.name = payload.contactName;
    if (payload.contactEmail) contact.email = payload.contactEmail;
    if (payload.contactPhone) contact.phone = payload.contactPhone;
    if (payload.contactTitle) contact.title = payload.contactTitle;
    if (payload.contactLinkedinUrl) contact.linkedinUrl = payload.contactLinkedinUrl;
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
      // ── New fields (2026-Q2) ─────────────────────────────────
      // Vex MAY or MAY NOT consume these depending on schema
      // version; older vex deploys ignore unknown metadata keys.
      // See `vex/integrations/procur` for the consumer side.
      ...(payload.approvalContext
        ? { procurApproval: payload.approvalContext }
        : {}),
      ...(payload.productSpecs.length > 0
        ? { productSpecs: payload.productSpecs }
        : {}),
      ...(payload.sourceDocuments.length > 0
        ? { sourceDocuments: payload.sourceDocuments }
        : {}),
      ...(payload.marketContext ? { marketContext: payload.marketContext } : {}),
      ...(payload.procurTradingDefaults
        ? { procurTradingDefaults: payload.procurTradingDefaults }
        : {}),
    },
  };
}

function composeNotes(payload: VexContactPayload): string | null {
  const oc = payload.originationContext;
  const cc = payload.commercialContext;

  const parts: string[] = [];
  if (oc.chatSummary) parts.push(oc.chatSummary);
  if (oc.userNote) parts.push(`User note: ${oc.userNote}`);

  // Approval line — surfaced in plain text so old vex deploys that
  // only consume `notes` still see KYC state. New deploys use the
  // structured procurApproval block under metadata.
  if (payload.approvalContext) {
    const a = payload.approvalContext;
    const expBit = a.expiresAt
      ? ` (KYC expires ${a.expiresAt.slice(0, 10)})`
      : '';
    parts.push(
      `Procur approval: ${a.status}${expBit}${a.notes ? ` — ${a.notes}` : ''}`,
    );
  }

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

  if (payload.productSpecs.length > 0) {
    parts.push(
      `Product specs attached (${payload.productSpecs.length} parameters from uploaded datasheet).`,
    );
  }
  if (payload.sourceDocuments.length > 0) {
    const fileBits = payload.sourceDocuments
      .map((d) => `${d.filename} (${d.url})`)
      .join(', ');
    parts.push(`Source document(s): ${fileBits}`);
  }

  if (cc.notes) parts.push(cc.notes);

  return parts.length > 0 ? parts.join('\n\n') : null;
}
