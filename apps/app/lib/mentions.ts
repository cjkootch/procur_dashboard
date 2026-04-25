import 'server-only';
import { eq } from 'drizzle-orm';
import { db, users, type User } from '@procur/db';

// Regex + extractor live in a client-safe module so the comment
// renderer can use them without dragging in server-only.
export {
  MENTION_PATTERN,
  extractMentionHandles,
  emailHandle,
} from './mentions-regex';
import { emailHandle as emailHandleFn } from './mentions-regex';

/**
 * Resolve mention handles to users in the same company. Matches by
 * email local-part, case-insensitive. Unknown handles silently
 * dropped (typo doesn't fail the comment post).
 */
export async function resolveMentions(
  companyId: string,
  handles: string[],
): Promise<User[]> {
  if (handles.length === 0) return [];
  const all = await db
    .select()
    .from(users)
    .where(eq(users.companyId, companyId));
  const handleSet = new Set(handles);
  return all.filter((u) => handleSet.has(emailHandleFn(u.email)));
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
      handle: emailHandleFn(r.email),
      displayName:
        [r.firstName, r.lastName].filter(Boolean).join(' ') || r.email,
    }))
    .sort((a, b) => a.handle.localeCompare(b.handle));
}
