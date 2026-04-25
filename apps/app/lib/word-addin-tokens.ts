import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { and, asc, eq, isNull } from 'drizzle-orm';
import {
  db,
  wordAddinTokens,
  type WordAddinToken,
} from '@procur/db';

/**
 * Token shape: prc_word_<32 url-safe chars>. The "prc_word_" prefix
 * scopes by surface (later we can mint prc_excel_, prc_slack_ etc.
 * without rotating this code).
 */
const TOKEN_PREFIX = 'prc_word_';
const TOKEN_BODY_BYTES = 24; // → 32 base64url chars

/**
 * Cookie used to flash a freshly-minted token to the page renderer
 * once. httpOnly + path-scoped to /settings/word-addin so it never
 * leaks elsewhere; auto-expires after 60s.
 */
export const WORD_ADDIN_FLASH_COOKIE = 'procur_word_addin_new_token';

export type GeneratedToken = {
  /** The raw token shown to the user once. Never persisted. */
  raw: string;
  /** sha256 hex of `raw`. Persisted. */
  hash: string;
  /** First 4 chars of the body for display in the management UI. */
  prefix: string;
};

export function generateWordAddinToken(): GeneratedToken {
  const body = randomBytes(TOKEN_BODY_BYTES).toString('base64url');
  const raw = `${TOKEN_PREFIX}${body}`;
  const hash = sha256(raw);
  const prefix = body.slice(0, 4);
  return { raw, hash, prefix };
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * Resolve a Bearer token to (companyId, userId). Returns null if the
 * token is unknown, revoked, or malformed. Side effect: bumps
 * lastUsedAt so we can show "last used" in the management UI and
 * spot dead tokens.
 *
 * Constant-time comparison isn't strictly necessary here because we
 * look up by hash equality (which is itself a sha256 — preimage
 * resistance gives us the property), but we still avoid leaking
 * existence: callers should treat null as "auth failed" without
 * differentiating "no such token" from "revoked".
 */
export async function resolveWordAddinToken(
  rawToken: string,
): Promise<{ companyId: string; userId: string; tokenId: string } | null> {
  if (!rawToken.startsWith(TOKEN_PREFIX)) return null;
  const hash = sha256(rawToken);
  const row = await db.query.wordAddinTokens.findFirst({
    where: and(eq(wordAddinTokens.tokenHash, hash), isNull(wordAddinTokens.revokedAt)),
    columns: { id: true, companyId: true, userId: true },
  });
  if (!row) return null;

  // Bump lastUsedAt so the management UI can show "last used X ago" and
  // spot dead tokens. Awaited intentionally — Vercel's serverless runtime
  // can shut the function down before a floating promise resolves, which
  // was silently swallowing every update under the prior fire-and-forget
  // pattern.
  try {
    await db
      .update(wordAddinTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(wordAddinTokens.id, row.id));
  } catch (e) {
    console.error('[word-addin] lastUsedAt update failed', e);
  }

  return { companyId: row.companyId, userId: row.userId, tokenId: row.id };
}

export async function listWordAddinTokensForUser(userId: string): Promise<WordAddinToken[]> {
  return db
    .select()
    .from(wordAddinTokens)
    .where(eq(wordAddinTokens.userId, userId))
    .orderBy(asc(wordAddinTokens.createdAt));
}
