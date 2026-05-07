'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ThreadListItem } from './ThreadListItem';

/**
 * Conversations aside on /assistant. On mobile (< lg), renders as a
 * collapsed disclosure ("Conversations (N) ▾") so the thread list
 * doesn't eat the top of the viewport before the chat input. On lg+,
 * always-open side rail (the original layout). useEffect reads
 * matchMedia at mount to flip the initial state — SSR renders
 * collapsed (mobile-default) so the markup is consistent for the
 * smaller viewport, then expands on lg.
 *
 * Why a client component: <details> doesn't accept CSS-driven open
 * state, and a server-rendered fixed `open` attribute would either
 * be wrong on mobile (open by default) or wrong on desktop (collapsed
 * by default). A tiny client component costs little and keeps both
 * surfaces clean.
 */
export function ConversationsAside({
  threads,
}: {
  threads: Array<{
    id: string;
    title: string;
    lastMessageAtIso: string;
  }>;
}) {
  const [isLg, setIsLg] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const update = () => setIsLg(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  const list =
    threads.length === 0 ? (
      <p className="text-xs text-[color:var(--color-muted-foreground)]">
        No conversations yet. Ask a question to start one.
      </p>
    ) : (
      <ul className="flex flex-col gap-1">
        {threads.map((t) => (
          <ThreadListItem
            key={t.id}
            id={t.id}
            title={t.title}
            lastMessageAtIso={t.lastMessageAtIso}
            active={false}
          />
        ))}
      </ul>
    );

  // Lg+: always-open side rail. Mobile: <details> collapsible.
  if (isLg) {
    return (
      <aside className="shrink-0 overflow-y-auto border-b border-[color:var(--color-border)] bg-[color:var(--color-muted)]/20 p-3 lg:w-64 lg:border-b-0 lg:border-r">
        <div className="mb-3 flex items-center justify-between">
          <div className="text-sm font-medium">Conversations</div>
          <Link
            href="/assistant"
            className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-0.5 text-xs"
          >
            New
          </Link>
        </div>
        {list}
      </aside>
    );
  }

  return (
    <aside className="shrink-0 border-b border-[color:var(--color-border)] bg-[color:var(--color-muted)]/20">
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 p-3 text-sm font-medium [&::-webkit-details-marker]:hidden">
          <span>
            Conversations{threads.length > 0 ? ` (${threads.length})` : ''}
          </span>
          <span className="flex items-center gap-2">
            <Link
              href="/assistant"
              className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-0.5 text-xs"
              onClick={(e) => e.stopPropagation()}
            >
              New
            </Link>
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="transition-transform group-open:rotate-180"
              aria-hidden="true"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </span>
        </summary>
        <div className="max-h-[40vh] overflow-y-auto p-3 pt-0">{list}</div>
      </details>
    </aside>
  );
}
