'use client';

import { useState } from 'react';
import { triggerEntityCrawlAction } from '../actions';

/**
 * Operator-side "trigger crawl" button on the Website Intelligence
 * panel. Wraps `triggerEntityCrawlAction` which calls the
 * @procur/ai crawler synchronously. The page sets
 * `export const maxDuration = 300` to give Sonnet + multi-page
 * fetch room; if it hits the wall, partial DB writes persist and
 * the operator can retry.
 *
 * Long-term: Trigger.dev v4 takes this off the request-response
 * path. The button stays the same — only the underlying action
 * swaps to enqueue-and-return.
 */
export function TriggerCrawlButton({ entitySlug }: { entitySlug: string }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    kind: 'ok' | 'err';
    text: string;
  } | null>(null);

  const onSubmit = async (formData: FormData) => {
    setBusy(true);
    setMessage(null);
    const result = await triggerEntityCrawlAction(formData);
    setMessage({ kind: result.ok ? 'ok' : 'err', text: result.message });
    setBusy(false);
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <form action={(fd) => void onSubmit(fd)}>
        <input type="hidden" name="entitySlug" value={entitySlug} />
        <button
          type="submit"
          disabled={busy}
          title="Run the website crawler against this entity. Caps at 5 pages; runs sync up to 5 minutes. Page reload to see results."
          className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-0.5 text-[11px] hover:bg-[color:var(--color-muted)]/40 disabled:opacity-50"
        >
          {busy ? 'Crawling…' : 'Trigger crawl'}
        </button>
      </form>
      {message && (
        <p
          className={
            message.kind === 'ok'
              ? 'text-[10px] text-green-700'
              : 'text-[10px] text-red-700'
          }
        >
          {message.text}
        </p>
      )}
    </div>
  );
}
