import { Fragment } from 'react';
import { MENTION_PATTERN } from '../../lib/mentions-regex';

/**
 * Render a comment body with @handles wrapped in styled spans, and
 * paragraph-aware line breaks (preserves the existing
 * white-space:pre-wrap feel without using the CSS hack so we get
 * proper element boundaries for screen readers).
 *
 * If `knownHandles` is provided, only handles in that set get the
 * "real mention" treatment (recipients in the same company); typos
 * still render as plain text so an unknown @handle doesn't visually
 * promise a notification that never went out.
 *
 * Plain-text safe: we never use dangerouslySetInnerHTML; the body
 * is split on the regex and rendered as React fragments.
 */
export function MentionText({
  body,
  knownHandles,
}: {
  body: string;
  knownHandles?: Set<string>;
}) {
  // Split on lines so we preserve paragraph breaks structurally.
  const lines = body.split('\n');
  return (
    <>
      {lines.map((line, i) => (
        <Fragment key={i}>
          {i > 0 && <br />}
          {renderLine(line, knownHandles)}
        </Fragment>
      ))}
    </>
  );
}

function renderLine(line: string, knownHandles?: Set<string>): React.ReactNode {
  // Reset regex lastIndex (matchAll is fine for global; using it here
  // for a fresh iterator each call).
  const out: React.ReactNode[] = [];
  let cursor = 0;
  for (const match of line.matchAll(MENTION_PATTERN)) {
    const fullMatchStart = match.index ?? 0;
    const handle = match[1] ?? '';
    // The MENTION_PATTERN captures the leading whitespace into match[0],
    // so the actual @handle starts at fullMatchStart + (length of leading
    // whitespace in match[0]).
    const handleStart = fullMatchStart + match[0].indexOf('@');
    if (handleStart > cursor) {
      out.push(line.slice(cursor, handleStart));
    }
    const known = knownHandles ? knownHandles.has(handle.toLowerCase()) : true;
    out.push(
      known ? (
        <span
          key={handleStart}
          className="rounded bg-blue-500/15 px-1 font-medium text-blue-700"
        >
          @{handle}
        </span>
      ) : (
        // Unknown handle — render as plain text so we don't visually
        // promise a notification that didn't fire.
        <span key={handleStart}>@{handle}</span>
      ),
    );
    cursor = handleStart + 1 + handle.length;
  }
  if (cursor < line.length) {
    out.push(line.slice(cursor));
  }
  return out;
}
