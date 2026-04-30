'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { Chat } from '../assistant/Chat';
import type { PageContextInput } from '../assistant/types';

const OPEN_STORAGE_KEY = 'procur.shell.rightRailOpen';
const THREAD_STORAGE_KEY = 'procur:assistant-drawer:threadId:v1';

/**
 * Shell-level right rail. Default-closed; ⌘K toggles open, ESC closes.
 * Open state persists in localStorage so the rail stays put across
 * navigations.
 *
 * v1 content: the assistant chat (with thread persistence). Future
 * iterations layer in autonomy feed, recent activity, and approvals
 * queue tabs inside the same panel — the rail container is the
 * single shell-level surface for operator-facing intelligence.
 *
 * Mobile: panel becomes near-fullscreen (`inset-2`) instead of a
 * fixed-width column. Above sm: 320px-wide column anchored to the
 * right edge.
 */
export function RightRailPanel() {
  const [open, setOpen] = useState(false);
  const [threadId, setThreadId] = useState<string | undefined>(undefined);
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const pageContext = derivePageContext(pathname, searchParams);

  // Hydrate open + thread state from localStorage on mount. Done in
  // an effect so SSR and the first client render agree on `false` /
  // `undefined` before client-only storage reads run.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const savedOpen = window.localStorage.getItem(OPEN_STORAGE_KEY);
      if (savedOpen === '1') setOpen(true);
      const savedThread = window.localStorage.getItem(THREAD_STORAGE_KEY);
      if (savedThread) setThreadId(savedThread);
    } catch {
      // localStorage unavailable — ephemeral state.
    }
  }, []);

  // Persist open state.
  useEffect(() => {
    try {
      window.localStorage.setItem(OPEN_STORAGE_KEY, open ? '1' : '0');
    } catch {
      /* storage unavailable */
    }
  }, [open]);

  // Global keyboard handlers: ⌘K toggles, ESC closes when open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setOpen((v) => !v);
        return;
      }
      if (e.key === 'Escape' && open) {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const persistThread = useCallback((id: string) => {
    setThreadId(id);
    try {
      window.localStorage.setItem(THREAD_STORAGE_KEY, id);
    } catch {
      /* storage unavailable */
    }
  }, []);

  const clearThread = useCallback(() => {
    setThreadId(undefined);
    try {
      window.localStorage.removeItem(THREAD_STORAGE_KEY);
    } catch {
      /* storage unavailable */
    }
  }, []);

  if (!open) return <LauncherButton onOpen={() => setOpen(true)} />;

  return (
    <div className="fixed inset-0 z-[1000]" role="dialog" aria-modal="true">
      <button
        type="button"
        aria-label="Close right rail"
        onClick={() => setOpen(false)}
        className="absolute inset-0"
      />
      {/* Mobile: near-fullscreen panel (8px inset). Desktop sm+:
          fixed-width column anchored to the right edge full-height. */}
      <div className="absolute inset-2 flex flex-col overflow-hidden rounded-[var(--radius-lg)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] shadow-2xl sm:inset-y-0 sm:left-auto sm:right-0 sm:w-[var(--shell-rightrail-width)] sm:rounded-none sm:border-l">
        <header className="flex items-center justify-between gap-2 border-b border-[color:var(--color-border)] px-3 py-2.5 sm:px-4">
          <div className="min-w-0">
            <div className="text-sm font-semibold">Procur Assistant</div>
            {pageContext && (
              <div className="truncate text-[11px] text-[color:var(--color-muted-foreground)]">
                Context: {describeContext(pageContext)}
              </div>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1 sm:gap-2">
            {threadId && (
              <button
                type="button"
                onClick={clearThread}
                className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-0.5 text-xs text-[color:var(--color-muted-foreground)] hover:border-[color:var(--color-foreground)] hover:text-[color:var(--color-foreground)]"
                title="Start a new conversation (current one stays in /assistant history)"
              >
                New
              </button>
            )}
            {threadId ? (
              <Link
                href={`/assistant/${threadId}`}
                onClick={() => setOpen(false)}
                className="hidden text-xs text-[color:var(--color-muted-foreground)] hover:underline sm:inline"
              >
                Open full view
              </Link>
            ) : (
              <Link
                href="/assistant"
                onClick={() => setOpen(false)}
                className="hidden text-xs text-[color:var(--color-muted-foreground)] hover:underline sm:inline"
              >
                Open /assistant
              </Link>
            )}
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-[var(--radius-sm)] p-1.5 text-[color:var(--color-muted-foreground)] hover:bg-[color:var(--color-muted)] hover:text-[color:var(--color-foreground)]"
              aria-label="Close assistant"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </header>
        <div className="flex-1 overflow-hidden">
          <Chat
            initialThreadId={threadId}
            pageContext={pageContext}
            onThreadChange={persistThread}
            onThreadCleared={clearThread}
            autoFocus
            placeholder="Ask the assistant…"
          />
        </div>
      </div>
    </div>
  );
}

function LauncherButton({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      // z-[999] sits above Leaflet's marker pane + controls. The open
      // panel goes one higher (z-[1000]) so the launcher tucks under
      // it cleanly. Bottom offset respects safe-area inset so the
      // button clears Safari's bottom bar / iOS home indicator.
      style={{ bottom: 'max(1rem, env(safe-area-inset-bottom, 0px))' }}
      className="fixed right-4 z-[999] flex items-center gap-2 rounded-full border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-4 py-2.5 text-sm font-medium shadow-lg hover:bg-[color:var(--color-muted)]/40"
      aria-label="Open Procur Assistant"
      title="Procur Assistant (⌘K)"
    >
      <span>Ask</span>
      <kbd className="ml-1 hidden rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-1.5 py-0.5 text-[10px] text-[color:var(--color-muted-foreground)] sm:inline">
        ⌘K
      </kbd>
    </button>
  );
}

function describeContext(ctx: PageContextInput): string {
  if (ctx.kind === 'rolodex') {
    const parts: string[] = [];
    if (ctx.filters.role) parts.push(ctx.filters.role);
    if (ctx.filters.country) parts.push(ctx.filters.country);
    if (ctx.filters.category) parts.push(ctx.filters.category);
    if (ctx.filters.tag) parts.push(ctx.filters.tag);
    return parts.length > 0 ? `rolodex — ${parts.join(' / ')}` : 'rolodex';
  }
  return ctx.kind;
}

function derivePageContext(
  pathname: string | null,
  searchParams: URLSearchParams | null,
): PageContextInput | undefined {
  if (!pathname) return undefined;

  if (pathname.startsWith('/suppliers/known-entities')) {
    const filters: NonNullable<
      Extract<PageContextInput, { kind: 'rolodex' }>['filters']
    > = {};
    const cat = searchParams?.get('category');
    if (cat && cat !== 'all') filters.category = cat;
    const c = searchParams?.get('country');
    if (c) filters.country = c;
    const r = searchParams?.get('role');
    if (r) filters.role = r;
    const t = searchParams?.get('tag');
    if (t) filters.tag = t;
    return { kind: 'rolodex', filters };
  }

  const m =
    pathname.match(/^\/capture\/pursuits\/([0-9a-f-]{36})/) ??
    pathname.match(/^\/proposal\/([0-9a-f-]{36})/) ??
    pathname.match(/^\/contract\/([0-9a-f-]{36})/) ??
    pathname.match(/^\/pricer\/([0-9a-f-]{36})/);
  if (!m) return undefined;
  const id = m[1];
  if (!id) return undefined;
  if (pathname.startsWith('/capture/pursuits/')) return { kind: 'pursuit', id };
  if (pathname.startsWith('/proposal/')) return { kind: 'proposal', id };
  if (pathname.startsWith('/contract/')) return { kind: 'contract', id };
  if (pathname.startsWith('/pricer/')) return { kind: 'pursuit', id };
  return undefined;
}
