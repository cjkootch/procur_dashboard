import 'server-only';
import { eq } from 'drizzle-orm';
import { db, users, type User } from '@procur/db';

/**
 * @-mention pattern. Allows letters, digits, and the punctuation valid
 * in an email local-part (dot, hyphen, underscore, plus). Captures the
 * raw handle without the leading @.
 *
 * The regex is anchored on a non-word boundary or start-of-string so
 * "email@example.com" inside a comment doesn't match the second @.
 */
const MENTION_PATTERN = /(?:^|\s)@([a-zA-Z0-9._+-]+)/g;

/** Pull all @mention handles out of a comment body. Lowercased and de-duped. */
export function extractMentionHandles(body: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of body.matchAll(MENTION_PATTERN)) {
    const handle = match[1]?.toLowerCase();
    if (!handle) continue;
    if (seen.has(handle)) continue;
    seen.add(handle);
    out.push(handle);
  }
  return out;
}

/** Email local part (everything before the @), lowercased. */
export function emailHandle(email: string): string {
  const at = email.indexOf('@');
  return (at < 0 ? email : email.slice(0, at)).toLowerCase();
}

/**
 * Resolve mention handles to users in the same company. Matches by
 * email local-part, case-insensitive. Returns only the users that
 * actually exist + belong to the company; unknown handles are silently
 * dropped (so a typo doesn't fail the comment post).
 */
export async function resolveMentions(
  companyId: string,
  handles: string[],
): Promise<User[]> {
  if (handles.length === 0) return [];
  // Drizzle doesn't have a clean "lowercase email" lookup helper, so we
  // pull all users in the company (typically <100 per tenant) and filter
  // in JS. Cheap enough for v1; revisit when a tenant has thousands of
  // members.
  const all = await db
    .select()
    .from(users)
    .where(eq(users.companyId, companyId));
  const handleSet = new Set(handles);
  return all.filter((u) => handleSet.has(emailHandle(u.email)));
}

export type MentionHint = {
  /** "@<email-local>" form. */
  handle: string;
  /** Display name — first + last, fallback to email. */
  displayName: string;
};

/**
 * Hint list for the comment-form UI: every other user in the company
 * (excluding `excludeUserId`) shown as "@handle (Display Name)".
 *
 * Used to render a "tip" line under the comment textarea so users
 * know which handles they can mention. Eventually replace with an
 * autocomplete combobox.
 */
export async function listMentionHints(
  companyId: string,
  excludeUserId: string,
): Promise<MentionHint[]> {
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
    })
    .from(users)
    .where(eq(users.companyId, companyId));

  return rows
    .filter((r) => r.id !== excludeUserId)
    .map((r) => ({
      handle: emailHandle(r.email),
      displayName:
        [r.firstName, r.lastName].filter(Boolean).join(' ') || r.email,
    }))
    .sort((a, b) => a.handle.localeCompare(b.handle));
}

