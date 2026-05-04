'use client';

import Image from 'next/image';
import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import {
  buildConnectUrl,
  clearStoredToken,
  getStoredToken,
} from '../lib/assistant-token';

/**
 * Floating Procur Assistant widget for Discover.
 *
 * - Bottom-right circular button using the Procur brand icon
 * - Click toggles an anchored side panel with chat
 * - Pre-handshake state: "Connect" CTA that bounces through
 *   app.procur.app's auth flow and returns with a token
 * - Connected state: standard chat with streaming via the SSE-backed
 *   /api/assistant/stream route, plus a Threads dropdown in the
 *   header for finding + continuing past conversations
 * - 401 from the API → token cleared, widget falls back to "Connect"
 *
 * Threads:
 * - First send creates a server-side thread; the SSE stream emits a
 *   `{type: 'thread', threadId}` up-front event so we can stash the
 *   id and surface it in the dropdown.
 * - Switching threads loads persisted messages from
 *   /api/assistant/threads/<id>. Tool-use / tool-result blocks are
 *   dropped on hydrate — the widget only renders text.
 * - "+ New" clears the active thread + message list; the next send
 *   creates a fresh thread.
 */

type ChatMessage = {
  role: 'user' | 'assistant';
  text: string;
};

type WidgetState = 'closed' | 'open';

type ThreadListRow = {
  id: string;
  title: string | null;
  lastMessageAt: string | null;
  createdAt: string;
};

const PANEL_WIDTH = 'w-96';
const PANEL_HEIGHT = 'h-[600px]';

export function AssistantWidget() {
  const [widget, setWidget] = useState<WidgetState>('closed');
  const [hasToken, setHasToken] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentThreadId, setCurrentThreadId] = useState<string | null>(null);
  const [threadList, setThreadList] = useState<ThreadListRow[]>([]);
  const [threadsOpen, setThreadsOpen] = useState(false);
  const [loadingThread, setLoadingThread] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Sync token presence on mount + when bootstrap fires its event.
  useEffect(() => {
    const sync = () => setHasToken(Boolean(getStoredToken()));
    sync();
    window.addEventListener('procur:discover-token-updated', sync);
    return () => window.removeEventListener('procur:discover-token-updated', sync);
  }, []);

  // Auto-scroll to latest on new message / chunk.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, streaming]);

  // Load thread list when the panel opens (and the user has a token).
  // Refreshed after every send so a brand-new thread shows up in the
  // dropdown without a manual refresh.
  const refreshThreads = useCallback(async () => {
    const token = getStoredToken();
    if (!token) return;
    try {
      const res = await fetch('/api/assistant/threads', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401) {
        clearStoredToken();
        setHasToken(false);
        return;
      }
      if (!res.ok) return;
      const body = (await res.json()) as { threads: ThreadListRow[] };
      setThreadList(body.threads ?? []);
    } catch {
      // Non-blocking — dropdown just stays empty.
    }
  }, []);

  useEffect(() => {
    if (widget === 'open' && hasToken) {
      void refreshThreads();
    }
  }, [widget, hasToken, refreshThreads]);

  const handleConnect = useCallback(() => {
    // Round-trip through the App's handshake endpoint. Returning to the
    // current Discover URL preserves the user's place on the catalog.
    const returnTo = window.location.href.split('#')[0]!;
    window.location.href = buildConnectUrl(returnTo);
  }, []);

  const handleDisconnect = useCallback(() => {
    clearStoredToken();
    setHasToken(false);
    setMessages([]);
    setError(null);
    setCurrentThreadId(null);
    setThreadList([]);
    setThreadsOpen(false);
  }, []);

  const handleNewThread = useCallback(() => {
    setMessages([]);
    setCurrentThreadId(null);
    setError(null);
    setThreadsOpen(false);
  }, []);

  const handleLoadThread = useCallback(
    async (threadId: string) => {
      const token = getStoredToken();
      if (!token) {
        setError('Reconnect required.');
        setHasToken(false);
        return;
      }
      setThreadsOpen(false);
      if (threadId === currentThreadId) return;
      setLoadingThread(true);
      setError(null);
      try {
        const res = await fetch(`/api/assistant/threads/${threadId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.status === 401) {
          clearStoredToken();
          setHasToken(false);
          setError('Session expired. Reconnect to continue.');
          return;
        }
        if (!res.ok) {
          setError(`Could not load thread (${res.status})`);
          return;
        }
        const body = (await res.json()) as {
          messages: Array<{ role: 'user' | 'assistant'; text: string }>;
        };
        setMessages(body.messages ?? []);
        setCurrentThreadId(threadId);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoadingThread(false);
      }
    },
    [currentThreadId],
  );

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || streaming) return;
    const token = getStoredToken();
    if (!token) {
      setError('Reconnect required.');
      setHasToken(false);
      return;
    }

    setError(null);
    setInput('');
    setMessages((prev) => [...prev, { role: 'user', text }]);
    setMessages((prev) => [...prev, { role: 'assistant', text: '' }]);
    setStreaming(true);

    try {
      const res = await fetch('/api/assistant/stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          userText: text,
          ...(currentThreadId ? { threadId: currentThreadId } : {}),
        }),
      });
      if (res.status === 401) {
        clearStoredToken();
        setHasToken(false);
        setError('Session expired. Reconnect to continue.');
        setMessages((prev) => prev.slice(0, -2));
        setStreaming(false);
        return;
      }
      if (!res.ok || !res.body) {
        const body = await res.text().catch(() => '');
        setError(`Request failed: ${res.status} ${body.slice(0, 120)}`);
        setMessages((prev) => prev.slice(0, -1));
        setStreaming(false);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      // SSE parser — accumulate `data: …` lines until a blank-line
      // separator, then dispatch the event.
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() ?? '';
        for (const block of events) {
          const dataLine = block.split('\n').find((l) => l.startsWith('data:'));
          if (!dataLine) continue;
          const json = dataLine.slice(5).trim();
          if (!json) continue;
          try {
            const event = JSON.parse(json);
            // Capture the threadId the server emits up-front so we
            // can pass it on subsequent sends + show it in the
            // dropdown.
            if (event && event.type === 'thread' && typeof event.threadId === 'string') {
              setCurrentThreadId(event.threadId);
              continue;
            }
            applyStreamEvent(event, setMessages);
          } catch {
            // Ignore malformed events.
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStreaming(false);
      // Refresh the thread list — the just-sent message either
      // created a new thread or bumped one to the top.
      void refreshThreads();
    }
  }, [input, streaming, currentThreadId, refreshThreads]);

  return (
    <>
      {/* Floating launcher */}
      <button
        type="button"
        aria-label={widget === 'open' ? 'Close Procur Assistant' : 'Open Procur Assistant'}
        onClick={() => setWidget((s) => (s === 'open' ? 'closed' : 'open'))}
        className={`fixed bottom-6 right-6 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-[color:var(--color-foreground)] text-[color:var(--color-background)] shadow-lg ring-1 ring-black/10 transition hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-foreground)] focus-visible:ring-offset-2`}
      >
        {widget === 'open' ? (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M6 6l12 12M6 18L18 6" strokeLinecap="round" />
          </svg>
        ) : (
          <Image
            src="/brand/procur-icon-dark.svg"
            alt=""
            width={28}
            height={28}
            className="invert"
          />
        )}
      </button>

      {/* Panel */}
      {widget === 'open' && (
        <div
          className={`fixed bottom-24 right-6 z-50 ${PANEL_WIDTH} ${PANEL_HEIGHT} flex flex-col overflow-hidden rounded-[var(--radius-lg)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] shadow-2xl`}
          role="dialog"
          aria-label="Procur Assistant"
        >
          <header className="flex items-center justify-between gap-2 border-b border-[color:var(--color-border)] px-4 py-3">
            <div className="flex items-center gap-2">
              <Image
                src="/brand/procur-icon-dark.svg"
                alt=""
                width={20}
                height={20}
              />
              <span className="text-sm font-semibold">Procur Assistant</span>
            </div>
            {hasToken && (
              <div className="flex items-center gap-2">
                {/* Threads dropdown — opens a small menu of past
                    conversations. Disabled while a turn is streaming
                    so the model can't write into a half-loaded thread. */}
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setThreadsOpen((s) => !s)}
                    disabled={streaming || loadingThread}
                    className="flex items-center gap-1 text-xs text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)] disabled:opacity-50"
                  >
                    Threads
                    <svg
                      width="10"
                      height="10"
                      viewBox="0 0 12 12"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                    >
                      <path d="M3 4.5L6 7.5L9 4.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                  {threadsOpen && (
                    <div
                      className="absolute right-0 top-full z-10 mt-1 max-h-72 w-72 overflow-y-auto rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] py-1 shadow-lg"
                      role="menu"
                    >
                      <button
                        type="button"
                        onClick={handleNewThread}
                        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-[color:var(--color-muted)]/60"
                      >
                        <span className="text-[color:var(--color-muted-foreground)]">+</span>
                        <span>New thread</span>
                      </button>
                      {threadList.length > 0 && (
                        <div className="my-1 border-t border-[color:var(--color-border)]" />
                      )}
                      {threadList.length === 0 ? (
                        <p className="px-3 py-2 text-xs text-[color:var(--color-muted-foreground)]">
                          No past conversations yet.
                        </p>
                      ) : (
                        threadList.map((t) => {
                          const active = t.id === currentThreadId;
                          const title = t.title?.trim() || 'Untitled conversation';
                          const stamp = formatThreadStamp(t.lastMessageAt ?? t.createdAt);
                          return (
                            <button
                              type="button"
                              key={t.id}
                              onClick={() => handleLoadThread(t.id)}
                              className={`flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left text-xs hover:bg-[color:var(--color-muted)]/60 ${
                                active ? 'bg-[color:var(--color-muted)]/40' : ''
                              }`}
                            >
                              <span className="line-clamp-1 w-full font-medium">
                                {title}
                              </span>
                              <span className="text-[10px] text-[color:var(--color-muted-foreground)]">
                                {stamp}
                              </span>
                            </button>
                          );
                        })
                      )}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={handleDisconnect}
                  className="text-xs text-[color:var(--color-muted-foreground)] hover:underline"
                >
                  Disconnect
                </button>
              </div>
            )}
          </header>

          {!hasToken ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
              <Image
                src="/brand/procur-icon-dark.svg"
                alt=""
                width={48}
                height={48}
                className="opacity-90"
              />
              <p className="text-sm text-[color:var(--color-muted-foreground)]">
                Sign in to chat with the Procur Assistant about opportunities in
                the catalog.
              </p>
              <button
                type="button"
                onClick={handleConnect}
                className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-4 py-2 text-sm font-medium text-[color:var(--color-background)] hover:opacity-90"
              >
                Connect to Assistant
              </button>
            </div>
          ) : (
            <>
              <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
                {loadingThread && (
                  <p className="py-6 text-center text-xs text-[color:var(--color-muted-foreground)]">
                    Loading conversation…
                  </p>
                )}
                {!loadingThread && messages.length === 0 && !streaming && (
                  <p className="py-6 text-center text-sm text-[color:var(--color-muted-foreground)]">
                    Ask me to find food, fuel, vehicle, or mineral
                    opportunities. Try:{' '}
                    <em>{'"Show me fuel tenders for the Caribbean"'}</em>
                  </p>
                )}
                {messages.map((m, i) => (
                  <MessageBubble key={i} role={m.role} text={m.text} />
                ))}
                {streaming &&
                  messages.length > 0 &&
                  messages[messages.length - 1]!.text === '' && (
                    <div className="text-xs text-[color:var(--color-muted-foreground)]">
                      Thinking…
                    </div>
                  )}
              </div>

              {error && (
                <div className="border-t border-red-500/30 bg-red-500/5 px-4 py-2 text-xs text-red-700">
                  {error}
                </div>
              )}

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  handleSend();
                }}
                className="border-t border-[color:var(--color-border)] p-3"
              >
                <div className="flex items-end gap-2">
                  <textarea
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        handleSend();
                      }
                    }}
                    placeholder="Ask about opportunities…"
                    rows={1}
                    disabled={streaming}
                    className="flex-1 resize-none rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[color:var(--color-foreground)]/30 disabled:opacity-60"
                  />
                  <button
                    type="submit"
                    disabled={streaming || !input.trim()}
                    className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-3 py-2 text-sm font-medium text-[color:var(--color-background)] disabled:opacity-50"
                  >
                    Send
                  </button>
                </div>
              </form>
            </>
          )}
        </div>
      )}
    </>
  );
}

function MessageBubble({ role, text }: { role: 'user' | 'assistant'; text: string }) {
  const isUser = role === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[92%] rounded-[var(--radius-md)] px-3 py-2 text-sm leading-relaxed ${
          isUser
            ? 'whitespace-pre-wrap bg-[color:var(--color-foreground)] text-[color:var(--color-background)]'
            : 'bg-[color:var(--color-muted)]/50 text-[color:var(--color-foreground)]'
        }`}
      >
        {isUser ? (
          text
        ) : text ? (
          // Assistant messages are markdown — bullet lists, links, bold,
          // etc. The compact-typography overrides below tighten the
          // built-in spacing so multi-row results fit in the panel
          // without scrolling each individual message.
          <div className="assistant-md space-y-2">
            <ReactMarkdown
              components={{
                a: ({ href, children }) => (
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium underline underline-offset-2 hover:opacity-80"
                  >
                    {children}
                  </a>
                ),
                ul: ({ children }) => (
                  <ul className="ml-4 list-disc space-y-1">{children}</ul>
                ),
                ol: ({ children }) => (
                  <ol className="ml-4 list-decimal space-y-1">{children}</ol>
                ),
                li: ({ children }) => <li className="leading-snug">{children}</li>,
                p: ({ children }) => <p className="leading-snug">{children}</p>,
                strong: ({ children }) => (
                  <strong className="font-semibold">{children}</strong>
                ),
                code: ({ children }) => (
                  <code className="rounded bg-[color:var(--color-background)] px-1 py-0.5 text-[12px]">
                    {children}
                  </code>
                ),
                hr: () => <hr className="my-2 border-[color:var(--color-border)]" />,
              }}
            >
              {text}
            </ReactMarkdown>
          </div>
        ) : (
          '…'
        )}
      </div>
    </div>
  );
}

/**
 * Apply one SSE-decoded event onto the messages list. Most events are
 * stream deltas (text appearing on the trailing assistant message);
 * tool_use / tool_result are quietly absorbed for v1 — surfacing them
 * is a polish iteration.
 */
function applyStreamEvent(
  event: { type?: string } & Record<string, unknown>,
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>,
): void {
  switch (event.type) {
    case 'text_delta': {
      const delta = typeof event.text === 'string' ? event.text : '';
      if (!delta) return;
      setMessages((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (!last || last.role !== 'assistant') return prev;
        next[next.length - 1] = { ...last, text: last.text + delta };
        return next;
      });
      break;
    }
    case 'error': {
      const message = typeof event.message === 'string' ? event.message : 'Unknown error';
      setMessages((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (!last || last.role !== 'assistant') return prev;
        next[next.length - 1] = {
          ...last,
          text: (last.text || '') + `\n\n_Error: ${message}_`,
        };
        return next;
      });
      break;
    }
    // tool_use / tool_result / message_start / message_complete /
    // turn_complete are silent in v1.
    default:
      break;
  }
}

/** Compact "5m ago" / "2h ago" / "Apr 30" stamp for the dropdown. */
function formatThreadStamp(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const diffMs = Date.now() - d.getTime();
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
