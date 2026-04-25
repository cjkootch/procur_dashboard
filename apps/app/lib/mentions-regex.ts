/**
 * @-mention regex + extractor, factored out so the rendering side
 * (a client/server React component that needs to walk the body and
 * wrap mentions in styled spans) can import without hauling in the
 * server-only DB lookup helpers from lib/mentions.ts.
 */

/**
 * Allows letters, digits, and the punctuation valid in an email
 * local-part (dot, hyphen, underscore, plus). Anchored on whitespace
 * or start-of-string so embedded emails (`a@b.com`) don't match the
 * second @.
 *
 * The leading `(?:^|\s)` is a non-capturing group; the captured
 * handle is in match[1].
 */
export const MENTION_PATTERN = /(?:^|\s)@([a-zA-Z0-9._+-]+)/g;

/** All @handles in the body, lowercased and de-duped, in occurrence order. */
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

/** Email local part, lowercased. */
export function emailHandle(email: string): string {
  const at = email.indexOf('@');
  return (at < 0 ? email : email.slice(0, at)).toLowerCase();
}
