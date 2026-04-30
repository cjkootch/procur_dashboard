'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { Chat } from './Chat';
import type { PageContextInput } from './types';

/**
 * localStorage key for the active drawer thread. Persisting it lets the
 * conversation survive a hard reload, a new tab, or a navigation —
 * matching every other chat product the user has used.
 *
 * Versioned so a future shape change can invalidate stale entries.
 */
const THREAD_STORAGE_KEY = 'procur:assistant-drawer:threadId:v1';

/**
 * Global Cmd+K (or Ctrl+K) launcher that opens the Procur Assistant in a
 * right-side drawer over the current page. Auto-derives page context from
 * the current URL so the assistant defaults to the right subject when
 * the user asks ambiguous questions ("what's the deadline?").
 *
 * Conversation persistence: the active threadId is mirrored into
 * localStorage so the chat survives across page navigations, drawer
 * close/reopen, hard reloads, and new tabs. Per-turn `pageContext`
 * still updates as the user navigates — the assistant always knows
 * what the user is currently looking at; only the conversation
 * history persists.
 */
export function AssistantDrawer() {
  const [open, setOpen] = useState(false);
  const [threadId, setThreadId] = useState<string | undefined>(undefined);
  // Hydrate threadId from localStorage on mount. Done in an effect
  // (not useState initializer) so SSR and the first client render
  // agree on `undefined` before the client-only storage read runs.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const saved = window.localStorage.getItem(THREAD_STORAGE_KEY);
      if (saved) setThreadId(saved);
    } catch {
      // localStorage unavailable (private browsing, disabled) —
      // fall back to ephemeral session state.
    }
  }, []);
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const pageContext = derivePageContext(pathname, searchParams);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setOpen((v) => !v);
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
      // Storage unavailable — keep state ephemeral.
    }
  }, []);

  const clearThread = useCallback(() => {
    setThreadId(undefined);
    try {
      window.localStorage.removeItem(THREAD_STORAGE_KEY);
    } catch {
      // Same fallback as above.
    }
  }, []);

  if (!open) return <LauncherButton onOpen={() => setOpen(true)} />;

  return (
    <div
      ref={backdropRef}
      // z-[1000] sits above Leaflet's marker pane (600) + controls
      // (800). Tailwind's z-50 wasn't enough — map markers were
      // painting on top of the chat panel.
      className="fixed inset-0 z-[1000]"
      onClick={(e) => {
        if (e.target === backdropRef.current) setOpen(false);
      }}
    >
      {/* Mobile: near-fullscreen panel (8px inset). Desktop: floating
          chat-window popover anchored bottom-right above the launcher.
          Sits clearly on top of the page rather than splitting the
          viewport into "page" + "side rail" halves. */}
      <div className="absolute inset-2 flex flex-col overflow-hidden rounded-[var(--radius-lg)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] shadow-2xl sm:inset-auto sm:bottom-4 sm:right-4 sm:h-[min(70vh,560px)] sm:w-[min(95vw,420px)]">
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

/**
 * Human-readable description of the current page context for the
 * drawer header. The full filter set goes to the LLM via the system
 * prompt; this is just the user-visible "we know what you're looking
 * at" affordance.
 */
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

/**
 * Floating launcher pinned to the bottom-right corner. Always visible so
 * the assistant is one click away on every authenticated page (the
 * Cmd/Ctrl+K shortcut is great for power users but invisible otherwise).
 */
function LauncherButton({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      // z-[999] sits above Leaflet's marker pane + controls. The open
      // drawer goes one higher (z-[1000]) so the launcher tucks under
      // it cleanly. Bottom offset is larger on mobile to clear browser
      // chrome (Safari bottom bar / home indicator).
      style={{
        bottom: 'max(1rem, env(safe-area-inset-bottom, 0px))',
      }}
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

/**
 * Route → PageContext mapping. Picks up common entity URLs + the
 * known-entities rolodex (where filters live in search params, not
 * the path). Returns undefined for non-entity pages so the assistant
 * defaults to whole-pipeline scope.
 */
function derivePageContext(
  pathname: string | null,
  searchParams: URLSearchParams | null,
): PageContextInput | undefined {
  if (!pathname) return undefined;

  // Rolodex page: /suppliers/known-entities — filters carried in
  // search params (?category=…&country=…&role=…&tag=…).
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
