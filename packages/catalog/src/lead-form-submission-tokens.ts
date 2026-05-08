import 'server-only';
import { eq } from 'drizzle-orm';
import {
  db,
  leadFormSubmissionTokens,
  type LeadFormSubmissionToken,
} from '@procur/db';

/**
 * Mint + resolve helpers for the lead-form sub-address tokens
 * (migration 0109). The autopilot calls mintLeadFormSubmissionToken
 * at dispatch time; the resend-inbound webhook calls
 * resolveLeadFormSubmissionToken on every inbound to detect form-
 * reply attribution.
 *
 * Token format: 8-char base32 (a-z + 2-7). 32^8 = 1.1 trillion.
 */

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const TOKEN_LENGTH = 8;

function generateBase32Token(): string {
  const bytes = new Uint8Array(TOKEN_LENGTH);
  // Crypto-strength randomness — Node's webcrypto is available in
  // server-only contexts. Don't seed with Math.random; this token is
  // also a soft authenticator (random spam to hello+xxxxxxxx won't
  // collide with a real submission token).
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < TOKEN_LENGTH; i += 1) {
    const byte = bytes[i] ?? 0;
    out += BASE32_ALPHABET[byte % 32];
  }
  return out;
}

/**
 * Mint a new token + persist it. Called by the autopilot's lead-form
 * dispatch and by the chat-tool path, both at the moment the
 * approval is created so the token can be embedded in the form's
 * email field via `LEAD_FORM_SENDER_EMAIL_LOCAL+<token>@DOMAIN`.
 *
 * Collision retry: random base32 has ~10^-12 collision risk per
 * submission, but defensively we retry up to 3 times on unique-key
 * violation. Practically never fires.
 */
export async function mintLeadFormSubmissionToken(input: {
  probeId: string;
  targetId: string;
  entitySlug: string;
  formUrl: string;
  approvalId: string;
}): Promise<LeadFormSubmissionToken> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = generateBase32Token();
    try {
      const [row] = await db
        .insert(leadFormSubmissionTokens)
        .values({
          token,
          probeId: input.probeId,
          targetId: input.targetId,
          entitySlug: input.entitySlug,
          formUrl: input.formUrl,
          approvalId: input.approvalId,
        })
        .returning();
      if (!row) throw new Error('mintLeadFormSubmissionToken: no row returned');
      return row;
    } catch (err) {
      // Postgres unique-key violation. Retry with a fresh token.
      if (
        err instanceof Error &&
        /duplicate key|unique constraint/i.test(err.message)
      ) {
        continue;
      }
      throw err;
    }
  }
  throw new Error(
    'mintLeadFormSubmissionToken: exhausted retries (3 base32 collisions in a row — extraordinarily unlikely)',
  );
}

/**
 * Resolve a token to its submission row. Called by the resend-
 * inbound webhook on every inbound where the To: address has a
 * `+token` plus-suffix. Returns null when the token doesn't match —
 * inbound just routes through the normal (no probe linkage) path.
 *
 * Stamps last_seen_at on a successful match so we have first-reply
 * cadence analytics ("form acknowledgement → inbound" gap per
 * market).
 */
export async function resolveLeadFormSubmissionToken(
  token: string,
): Promise<LeadFormSubmissionToken | null> {
  const [row] = await db
    .select()
    .from(leadFormSubmissionTokens)
    .where(eq(leadFormSubmissionTokens.token, token))
    .limit(1);
  if (!row) return null;
  // Stamp last_seen_at on first matching inbound. Subsequent inbounds
  // re-stamp — last touch wins.
  await db
    .update(leadFormSubmissionTokens)
    .set({ lastSeenAt: new Date() })
    .where(eq(leadFormSubmissionTokens.token, token));
  return row;
}

/**
 * Parse a `local+token@domain` style address and return the token
 * portion when present. Returns null when the address has no plus-
 * suffix or doesn't match the expected sender-local pattern.
 *
 * Centralizing the parse here so the webhook + the autopilot
 * dispatch both agree on the format. Plus-addressing is RFC 5321 §4.5
 * standard (the `+` separator is widely supported, though some
 * legacy MTAs strip it). We accept anything matching
 * /^[^@+]+\+([a-z0-9]+)@/ — the local portion before `+` doesn't
 * have to match the sender exactly because Resend may rewrite
 * (DKIM-aligned senders, custom envelope addresses).
 */
export function parseSubAddressToken(toAddress: string): string | null {
  if (typeof toAddress !== 'string') return null;
  // The To: header may carry display name + angle brackets. Strip.
  const angleMatch = toAddress.match(/<([^>]+)>/);
  const addr = (angleMatch?.[1] ?? toAddress).trim().toLowerCase();
  const m = addr.match(/^[^@+]+\+([a-z0-9]+)@/);
  return m?.[1] ?? null;
}

/**
 * Build the sub-addressed sender email from a token. Centralizes the
 * "local+token@domain" formatting so the autopilot + chat-tool
 * dispatch can't drift on encoding. Falls back to the bare sender
 * email when the configured LEAD_FORM_SENDER_EMAIL doesn't have an
 * @ (defensive — the env should always be a valid email).
 */
export function buildSubAddressedEmail(
  baseEmail: string,
  token: string,
): string {
  const at = baseEmail.indexOf('@');
  if (at < 0) return baseEmail;
  return `${baseEmail.slice(0, at)}+${token}${baseEmail.slice(at)}`;
}
