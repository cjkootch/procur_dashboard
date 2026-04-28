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
 *   /api/assistant/stream route
 * - 401 from the API → token cleared, widget falls back to "Connect"
 *
 * No thread persistence on Discover — the conversation lives only in
 * component state. Refresh = new chat. Future enhancement when we
 * want history.
 */

type ChatMessage = {
  role: 'user' | 'assistant';
  text: string;
};

type WidgetState = 'closed' | 'open';

const PANEL_WIDTH = 'w-96';
const PANEL_HEIGHT = 'h-[600px]';

export function AssistantWidget() {
  const [widget, setWidget] = useState<WidgetState>('closed');
  const [hasToken, setHasToken] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
  }, []);

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

    // Build history in Anthropic's format: user/assistant alternation.
    const history = messages.map((m) => ({
      role: m.role,
      content: m.text,
    }));

    try {
      const res = await fetch('/api/assistant/stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ history, userText: text }),
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
    }
  }, [input, messages, streaming]);

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
          <header className="flex items-center justify-between border-b border-[color:var(--color-border)] px-4 py-3">
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
              <button
                type="button"
                onClick={handleDisconnect}
                className="text-xs text-[color:var(--color-muted-foreground)] hover:underline"
              >
                Disconnect
              </button>
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
                {messages.length === 0 && !streaming && (
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
