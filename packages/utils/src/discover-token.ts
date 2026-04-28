import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Lightweight HMAC-signed token for Discover ↔ App handshake auth.
 *
 * Why this exists: Clerk dev keys host the Frontend API at a third-party
 * `*.accounts.dev` host, so the session cookie can't reliably be read
 * across `app.procur.app` ↔ `discover.procur.app`. Production keys with
 * a custom Clerk domain solve this but require a paid plan. As a
 * stopgap, the App side mints a short-lived signed token after Clerk
 * authentication and Discover verifies it server-side using the same
 * shared secret (DISCOVER_HANDSHAKE_SECRET).
 *
 * Format: `<base64url(payload)>.<base64url(hmac-sha256(payload, secret))>`
 *
 * Payload shape:
 *   { uid: <Clerk userId>, exp: <unix-ms> }
 *
 * 24-hour default TTL is friendly for casual chat usage; the assistant
 * widget reconnects via the popup when expired. Tokens are bound to the
 * Clerk userId — the App endpoint refuses to mint anonymously.
 */

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export type DiscoverTokenClaims = {
  /** Clerk user ID. */
  userId: string;
  /** Clerk org ID — Discover looks up the company by this to scope AI budget. */
  orgId: string | null;
};

type Payload = DiscoverTokenClaims & { exp: number };

export function signDiscoverToken(
  claims: DiscoverTokenClaims,
  secret: string,
  ttlMs: number = DEFAULT_TTL_MS,
): string {
  if (!secret || secret.length < 16) {
    throw new Error('DISCOVER_HANDSHAKE_SECRET must be at least 16 chars');
  }
  const payload: Payload = { ...claims, exp: Date.now() + ttlMs };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

export function verifyDiscoverToken(
  token: string | null | undefined,
  secret: string,
): DiscoverTokenClaims | null {
  if (!token || !secret) return null;
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const encoded = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expected = createHmac('sha256', secret).update(encoded).digest('base64url');
  // Constant-time compare — pad/length-check first since timingSafeEqual
  // throws on length mismatch.
  const sigBuf = Buffer.from(sig, 'base64url');
  const expBuf = Buffer.from(expected, 'base64url');
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }

  let payload: Payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf-8')) as Payload;
  } catch {
    return null;
  }
  if (typeof payload.userId !== 'string' || typeof payload.exp !== 'number') return null;
  if (payload.exp < Date.now()) return null;
  return { userId: payload.userId, orgId: payload.orgId ?? null };
}
