'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Chat } from './Chat';
import type { PageContextInput } from './types';

/**
 * Global Cmd+K (or Ctrl+K) launcher that opens the Procur Assistant in a
 * right-side drawer over the current page. Auto-derives page context from
 * the current URL so the assistant defaults to the right subject when
 * the user asks ambiguous questions ("what's the deadline?").
 */
export function AssistantDrawer() {
  const [open, setOpen] = useState(false);
  const [threadId, setThreadId] = useState<string | undefined>(undefined);
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const pathname = usePathname();
  const pageContext = derivePageContext(pathname);

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

  // Reset the thread when the drawer reopens on a different page so the
  // user doesn't carry pursuit-X context into a conversation about pursuit-Y.
  useEffect(() => {
    if (open) setThreadId(undefined);
  }, [open, pathname]);

  if (!open) return <LauncherButton onOpen={() => setOpen(true)} />;

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 z-50 bg-black/30"
      onClick={(e) => {
        if (e.target === backdropRef.current) setOpen(false);
      }}
    >
      <div className="absolute right-0 top-0 flex h-full w-full max-w-[560px] flex-col border-l border-[color:var(--color-border)] bg-[color:var(--color-background)] shadow-2xl">
        <header className="flex items-center justify-between border-b border-[color:var(--color-border)] px-4 py-2.5">
          <div>
            <div className="text-sm font-semibold">Procur Assistant</div>
            {pageContext && (
              <div className="text-[11px] text-[color:var(--color-muted-foreground)]">
                Context: {pageContext.kind}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            {threadId ? (
              <Link
                href={`/assistant/${threadId}`}
                onClick={() => setOpen(false)}
                className="text-xs text-[color:var(--color-muted-foreground)] hover:underline"
              >
                Open full view
              </Link>
            ) : (
              <Link
                href="/assistant"
                onClick={() => setOpen(false)}
                className="text-xs text-[color:var(--color-muted-foreground)] hover:underline"
              >
                Open /assistant
              </Link>
            )}
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-[var(--radius-sm)] px-2 py-1 text-xs text-[color:var(--color-muted-foreground)] hover:bg-[color:var(--color-muted)]"
              aria-label="Close"
            >
              Esc
            </button>
          </div>
        </header>
        <div className="flex-1 overflow-hidden">
          <Chat
            pageContext={pageContext}
            onThreadChange={setThreadId}
            autoFocus
            placeholder="Ask the assistant…"
          />
        </div>
      </div>
    </div>
  );
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
      className="fixed bottom-4 right-4 z-40 flex items-center gap-2 rounded-full border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-4 py-2.5 text-sm font-medium shadow-lg hover:bg-[color:var(--color-muted)]/40"
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
 * Route → PageContext mapping. Picks up common entity URLs. Returns undefined
 * for non-entity pages so the assistant defaults to whole-pipeline scope.
 */
function derivePageContext(pathname: string | null): PageContextInput | undefined {
  if (!pathname) return undefined;
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
