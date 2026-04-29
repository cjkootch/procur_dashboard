import 'server-only';

/**
 * Outbound HTTP client for procur → vex calls.
 *
 * Used by the assistant's `propose_push_to_vex_contact` flow when a
 * user confirms a "send this entity to vex" proposal. Authenticated
 * via `VEX_API_TOKEN` (set on the procur deployment env). Vex
 * verifies the same value on its inbound side.
 *
 * Direction note: this is the OPPOSITE of vex → procur calls — those
 * use `PROCUR_API_TOKEN` and hit our `/api/intelligence/*` surface
 * (see `intelligence-auth.ts`). Two distinct tokens, two distinct
 * trust boundaries.
 *
 * Default base URL is the production vex host. Override via env for
 * staging / local-dev:
 *   VEX_API_BASE_URL=https://staging.vexhq.ai
 */
const DEFAULT_BASE_URL = 'https://www.vexhq.ai';
const TIMEOUT_MS = 10_000;

export type VexContactPayload = {
  /** Source identifiers — let vex dedupe against any prior push. */
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

  /** Commercial context — feeds vex's AI so it understands who
      this counterparty is on landing. */
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
      free-text the user added. Vex's AI uses this as origination
      context. */
  originationContext: {
    triggeredBy: string;
    chatSummary: string | null;
    userNote: string | null;
    pushedAt: string;
  };
};

export type VexContactResponse = {
  vexContactId: string;
  vexRecordUrl: string;
  /** True when vex matched the push to an existing contact instead
      of creating a new one. */
  dedupedAgainstExisting: boolean;
};

export type VexClientResult =
  | { ok: true; data: VexContactResponse }
  | { ok: false; error: string; status?: number };

/**
 * POST a contact-creation push to vex.
 *
 * Vex's inbound endpoint contract (vex ships this side):
 *   POST {VEX_API_BASE_URL}/api/intelligence-inbound/contact
 *   Authorization: Bearer ${VEX_API_TOKEN}
 *   Content-Type: application/json
 *   body: VexContactPayload
 *   response: 201 with VexContactResponse | 4xx with {error, message}
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
  const url = `${baseUrl.replace(/\/$/, '')}/api/intelligence-inbound/contact`;

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
      body: JSON.stringify(payload),
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

    const json = (await res.json()) as VexContactResponse;
    return { ok: true, data: json };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `vex push failed: ${msg}` };
  } finally {
    clearTimeout(timeout);
  }
}
