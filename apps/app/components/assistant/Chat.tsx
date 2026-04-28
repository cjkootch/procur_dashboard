'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { PageContextInput, RenderedMessage, RenderedToolUse } from './types';
import { DealEconomicsCard, isDealEconomicsOutput } from './DealEconomicsCard';

type StreamEvent =
  | { type: 'thread'; threadId: string }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_use_input'; id: string; inputJson: string }
  | { type: 'tool_result'; id: string; name: string; output: unknown; isError: boolean }
  | {
      type: 'assistant_message_complete';
      content: unknown;
      stopReason: string | null;
      usage: unknown;
    }
  | { type: 'turn_complete'; totalCostCents: number }
  | { type: 'error'; message: string };

export type ChatProps = {
  initialThreadId?: string;
  initialMessages?: RenderedMessage[];
  pageContext?: PageContextInput;
  onThreadChange?: (threadId: string) => void;
  /**
   * Called when the component starts a fresh conversation — either
   * because the parent passed `undefined` initially or because a
   * rehydration fetch returned 404 (saved thread no longer exists).
   * The drawer uses this to clear its persisted threadId.
   */
  onThreadCleared?: () => void;
  placeholder?: string;
  autoFocus?: boolean;
};

/**
 * Streaming chat. Connects to /api/assistant/stream, consumes SSE events,
 * and incrementally renders text_delta + tool_use + tool_result events.
 *
 * Persisted threads are loaded server-side; this component re-hydrates
 * them as RenderedMessages via the initialMessages prop.
 */
export function Chat({
  initialThreadId,
  initialMessages,
  pageContext,
  onThreadChange,
  onThreadCleared,
  placeholder,
  autoFocus,
}: ChatProps) {
  const [threadId, setThreadId] = useState<string | undefined>(initialThreadId);
  const [messages, setMessages] = useState<RenderedMessage[]>(initialMessages ?? []);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hydrating, setHydrating] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  // Rehydrate when the drawer reopens with a saved threadId but no
  // messages baked in (initialMessages is omitted by the drawer
  // because it can't run server queries). The /assistant/[threadId]
  // page passes initialMessages directly so this effect no-ops there.
  //
  // Tracks the last hydrated id so prop-driven thread changes
  // (drawer clears via "New chat", or a future "open another
  // conversation") refetch as expected.
  const lastHydratedRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!initialThreadId) {
      // Nothing to hydrate. If we'd previously loaded a different
      // thread, clear messages so the surface shows a clean slate.
      if (lastHydratedRef.current !== undefined) {
        lastHydratedRef.current = undefined;
        setMessages([]);
        setThreadId(undefined);
      }
      return;
    }
    if (initialMessages !== undefined) {
      // Server-rendered hydration path — no fetch needed.
      lastHydratedRef.current = initialThreadId;
      return;
    }
    if (lastHydratedRef.current === initialThreadId) return;

    let cancelled = false;
    setHydrating(true);
    setError(null);
    fetch(`/api/assistant/threads/${initialThreadId}`, {
      headers: { Accept: 'application/json' },
    })
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 404) {
          // Thread was deleted (or belongs to a different user after
          // a sign-out / sign-in). Drop it and start fresh.
          lastHydratedRef.current = undefined;
          setThreadId(undefined);
          setMessages([]);
          onThreadCleared?.();
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { rendered: RenderedMessage[] };
        if (cancelled) return;
        lastHydratedRef.current = initialThreadId;
        setThreadId(initialThreadId);
        setMessages(body.rendered ?? []);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : 'Failed to load conversation';
        setError(msg);
      })
      .finally(() => {
        if (!cancelled) setHydrating(false);
      });

    return () => {
      cancelled = true;
    };
  }, [initialThreadId, initialMessages, onThreadCleared]);

  const send = useCallback(async () => {
    const userText = input.trim();
    if (!userText || sending) return;
    setInput('');
    setError(null);
    setSending(true);

    const userMessageId = `local-user-${Date.now()}`;
    const assistantMessageId = `local-assistant-${Date.now()}`;
    setMessages((prev) => [
      ...prev,
      { id: userMessageId, kind: 'user', text: userText },
      { id: assistantMessageId, kind: 'assistant', text: '', toolUses: [], streaming: true },
    ]);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch('/api/assistant/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId, userText, pageContext }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() ?? '';
        for (const raw of events) {
          const line = raw.trim();
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          let event: StreamEvent;
          try {
            event = JSON.parse(payload) as StreamEvent;
          } catch {
            continue;
          }
          applyEvent(event, assistantMessageId, (t) => {
            setThreadId(t);
            onThreadChange?.(t);
          });
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg !== 'The user aborted a request.') setError(msg);
    } finally {
      setSending(false);
      setMessages((prev) =>
        prev.map((m) =>
          m.kind === 'assistant' && m.id === assistantMessageId
            ? { ...m, streaming: false }
            : m,
        ),
      );
    }
  }, [input, sending, threadId, pageContext, onThreadChange]);

  function applyEvent(
    event: StreamEvent,
    assistantMessageId: string,
    setThreadCb: (id: string) => void,
  ) {
    if (event.type === 'thread') {
      setThreadCb(event.threadId);
      return;
    }
    if (event.type === 'error') {
      setError(event.message);
      return;
    }
    if (event.type === 'text_delta') {
      setMessages((prev) =>
        prev.map((m) =>
          m.kind === 'assistant' && m.id === assistantMessageId
            ? { ...m, text: m.text + event.text }
            : m,
        ),
      );
      return;
    }
    if (event.type === 'tool_use_start') {
      setMessages((prev) =>
        prev.map((m) =>
          m.kind === 'assistant' && m.id === assistantMessageId
            ? { ...m, toolUses: [...m.toolUses, { id: event.id, name: event.name, input: null }] }
            : m,
        ),
      );
      return;
    }
    if (event.type === 'tool_use_input') {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(event.inputJson);
      } catch {
        parsed = event.inputJson;
      }
      setMessages((prev) =>
        prev.map((m) =>
          m.kind === 'assistant' && m.id === assistantMessageId
            ? {
                ...m,
                toolUses: m.toolUses.map((t) => (t.id === event.id ? { ...t, input: parsed } : t)),
              }
            : m,
        ),
      );
      return;
    }
    if (event.type === 'tool_result') {
      setMessages((prev) =>
        prev.map((m) => {
          if (m.kind !== 'assistant' || m.id !== assistantMessageId) return m;
          if (m.toolUses.some((t) => t.id === event.id)) {
            return {
              ...m,
              toolUses: m.toolUses.map((t) =>
                t.id === event.id
                  ? { ...t, result: { output: event.output, isError: event.isError } }
                  : t,
              ),
            };
          }
          // Tool result arrived before its tool_use_start — append anyway so
          // the result renders. Shouldn't happen in practice.
          return {
            ...m,
            toolUses: [
              ...m.toolUses,
              {
                id: event.id,
                name: event.name,
                input: null,
                result: { output: event.output, isError: event.isError },
              },
            ],
          };
        }),
      );
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollerRef} className="flex-1 overflow-y-auto px-4 py-4">
        {hydrating && messages.length === 0 && (
          <div className="mx-auto max-w-lg py-16 text-center text-sm text-[color:var(--color-muted-foreground)]">
            Loading conversation…
          </div>
        )}
        {!hydrating && messages.length === 0 && (
          <div className="mx-auto max-w-lg py-16 text-center text-sm text-[color:var(--color-muted-foreground)]">
            <p className="mb-2 text-base font-medium text-[color:var(--color-foreground)]">
              Ask anything about your pipeline
            </p>
            <p>Try: &ldquo;which pursuits are past deadline?&rdquo;, &ldquo;show me IT tenders in Guyana&rdquo;, or &ldquo;draft a differentiator section for pursuit X&rdquo;.</p>
          </div>
        )}
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
          {messages.map((m) => (
            <MessageView key={m.id} message={m} threadId={threadId} />
          ))}
          {error && (
            <div className="rounded-[var(--radius-sm)] border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-600">
              {error}
            </div>
          )}
        </div>
      </div>
      <div className="border-t border-[color:var(--color-border)] bg-[color:var(--color-background)] p-3">
        <div className="mx-auto max-w-2xl">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            rows={2}
            autoFocus={autoFocus}
            placeholder={placeholder ?? 'Ask the assistant…'}
            className="w-full resize-none rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-3 py-2 text-sm outline-none focus:border-[color:var(--color-foreground)]/50"
            disabled={sending}
          />
          <div className="mt-2 flex items-center justify-between text-xs text-[color:var(--color-muted-foreground)]">
            <span>Enter to send · Shift+Enter for newline</span>
            <button
              type="button"
              onClick={() => void send()}
              disabled={sending || input.trim().length === 0}
              className="rounded-[var(--radius-sm)] bg-[color:var(--color-foreground)] px-3 py-1 text-xs font-medium text-[color:var(--color-background)] disabled:opacity-40"
            >
              {sending ? 'Thinking…' : 'Send'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

type ProposalShape = {
  proposalId: string;
  toolName: string;
  title: string;
  description: string;
  preview: Record<string, unknown>;
  applyPayload: Record<string, unknown>;
};

function isProposalOutput(output: unknown): output is ProposalShape {
  if (!output || typeof output !== 'object') return false;
  const o = output as Record<string, unknown>;
  return (
    typeof o.proposalId === 'string' &&
    typeof o.toolName === 'string' &&
    typeof o.title === 'string' &&
    typeof o.applyPayload === 'object' &&
    o.applyPayload !== null
  );
}

function MessageView({
  message,
  threadId,
}: {
  message: RenderedMessage;
  threadId?: string;
}) {
  if (message.kind === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-3 py-2 text-sm text-[color:var(--color-background)]">
          {message.text}
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {message.toolUses.length > 0 && (
        <div className="flex flex-col gap-2">
          {message.toolUses.map((t) => {
            if (t.result && !t.result.isError) {
              if (isDealEconomicsOutput(t.result.output)) {
                return <DealEconomicsCard key={t.id} output={t.result.output} />;
              }
              if (isProposalOutput(t.result.output)) {
                return (
                  <ProposalCard key={t.id} proposal={t.result.output} threadId={threadId} />
                );
              }
            }
            return <ToolCard key={t.id} toolUse={t} />;
          })}
        </div>
      )}
      {message.text && (
        <div className="rounded-[var(--radius-md)] bg-[color:var(--color-muted)]/40 px-3 py-2 text-sm">
          <AssistantMarkdown text={message.text} />
        </div>
      )}
      {message.streaming && !message.text && message.toolUses.length === 0 && (
        <div className="text-xs italic text-[color:var(--color-muted-foreground)]">Thinking…</div>
      )}
    </div>
  );
}

type ApplyState =
  | { status: 'idle' }
  | { status: 'applying' }
  | { status: 'applied'; result: { redirectTo?: string } }
  | { status: 'dismissed' }
  | { status: 'error'; message: string };

function ProposalCard({
  proposal,
  threadId,
}: {
  proposal: ProposalShape;
  threadId?: string;
}) {
  const [state, setState] = useState<ApplyState>({ status: 'idle' });

  const apply = async () => {
    if (!threadId) {
      setState({ status: 'error', message: 'No active thread' });
      return;
    }
    setState({ status: 'applying' });
    try {
      const res = await fetch('/api/assistant/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          threadId,
          toolName: proposal.toolName,
          applyPayload: proposal.applyPayload,
        }),
      });
      const body = (await res.json()) as
        | { ok: true; result: { redirectTo?: string } }
        | { ok: false; error: string; message?: string };
      if (res.ok && 'ok' in body && body.ok) {
        setState({ status: 'applied', result: body.result });
      } else if ('error' in body) {
        setState({ status: 'error', message: body.message ?? body.error });
      } else {
        setState({ status: 'error', message: `HTTP ${res.status}` });
      }
    } catch (err) {
      setState({
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <div className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-3 text-sm shadow-sm">
      <div className="mb-1 flex items-center gap-2 text-xs uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
        <span>Proposed action</span>
        <span className="font-mono">{proposal.toolName}</span>
      </div>
      <div className="font-medium">{proposal.title}</div>
      <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">
        {proposal.description}
      </p>
      <pre className="mt-2 max-h-40 overflow-auto rounded-[var(--radius-sm)] bg-[color:var(--color-muted)]/40 p-2 text-[11px]">
        {JSON.stringify(proposal.preview, null, 2)}
      </pre>
      <div className="mt-3 flex items-center justify-between gap-2">
        <div className="text-xs">
          {state.status === 'applied' && (
            <span className="text-green-700">
              Applied
              {state.result.redirectTo && (
                <>
                  {' · '}
                  <a href={state.result.redirectTo} className="underline">
                    Open
                  </a>
                </>
              )}
            </span>
          )}
          {state.status === 'dismissed' && (
            <span className="text-[color:var(--color-muted-foreground)]">Dismissed</span>
          )}
          {state.status === 'error' && <span className="text-red-600">{state.message}</span>}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setState({ status: 'dismissed' })}
            disabled={state.status === 'applying' || state.status === 'applied'}
            className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-3 py-1 text-xs disabled:opacity-40"
          >
            Dismiss
          </button>
          <button
            type="button"
            onClick={() => void apply()}
            disabled={state.status === 'applying' || state.status === 'applied'}
            className="rounded-[var(--radius-sm)] bg-[color:var(--color-foreground)] px-3 py-1 text-xs font-medium text-[color:var(--color-background)] disabled:opacity-40"
          >
            {state.status === 'applying' ? 'Applying…' : 'Apply'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ToolCard({ toolUse }: { toolUse: RenderedToolUse }) {
  const [open, setOpen] = useState(false);
  const status = useMemo(() => {
    if (toolUse.result?.isError) return 'error';
    if (toolUse.result) return 'done';
    return 'running';
  }, [toolUse.result]);
  return (
    <div className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-2 py-1.5 text-left"
      >
        <span className="flex items-center gap-2">
          <span
            className={
              status === 'error'
                ? 'text-red-600'
                : status === 'running'
                  ? 'text-[color:var(--color-muted-foreground)]'
                  : 'text-green-700'
            }
          >
            {status === 'running' ? '…' : status === 'error' ? '✕' : '✓'}
          </span>
          <span className="font-mono">{toolUse.name}</span>
        </span>
        <span className="text-[color:var(--color-muted-foreground)]">{open ? 'hide' : 'show'}</span>
      </button>
      {open && (
        <div className="border-t border-[color:var(--color-border)] p-2">
          {toolUse.input !== null && (
            <div className="mb-2">
              <div className="mb-1 text-[color:var(--color-muted-foreground)]">input</div>
              <pre className="overflow-x-auto rounded-[var(--radius-sm)] bg-[color:var(--color-muted)]/40 p-2 text-[11px]">
                {JSON.stringify(toolUse.input, null, 2)}
              </pre>
            </div>
          )}
          {toolUse.result && (
            <div>
              <div className="mb-1 text-[color:var(--color-muted-foreground)]">result</div>
              <pre className="max-h-64 overflow-auto rounded-[var(--radius-sm)] bg-[color:var(--color-muted)]/40 p-2 text-[11px]">
                {JSON.stringify(toolUse.result.output, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Assistant text passes through Claude as Markdown. We render it
 * with react-markdown + GFM (tables, task lists, strikethrough,
 * autolinks) and override the default elements with chat-bubble-
 * appropriate styles — tighter spacing, no top margins on first-
 * child, scoped link colors.
 *
 * Streaming-safe: react-markdown re-parses on every text update,
 * so partial markdown (e.g. a closing `**` not yet streamed)
 * renders as best-effort plain text until completion.
 */
function AssistantMarkdown({ text }: { text: string }) {
  return (
    <div className="space-y-2 text-sm leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="m-0 first:mt-0 last:mb-0">{children}</p>,
          ul: ({ children }) => (
            <ul className="m-0 list-disc space-y-0.5 pl-5">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="m-0 list-decimal space-y-0.5 pl-5">{children}</ol>
          ),
          li: ({ children }) => <li className="m-0">{children}</li>,
          h1: ({ children }) => <h3 className="text-base font-semibold">{children}</h3>,
          h2: ({ children }) => <h3 className="text-base font-semibold">{children}</h3>,
          h3: ({ children }) => <h3 className="text-sm font-semibold">{children}</h3>,
          h4: ({ children }) => <h4 className="text-sm font-semibold">{children}</h4>,
          strong: ({ children }) => (
            <strong className="font-semibold text-[color:var(--color-foreground)]">
              {children}
            </strong>
          ),
          em: ({ children }) => <em className="italic">{children}</em>,
          hr: () => <hr className="my-2 border-[color:var(--color-border)]" />,
          a: ({ href, children }) => (
            <a
              href={href}
              target={href?.startsWith('http') ? '_blank' : undefined}
              rel={href?.startsWith('http') ? 'noopener noreferrer' : undefined}
              className="text-[color:var(--color-brand)] underline underline-offset-2 hover:opacity-80"
            >
              {children}
            </a>
          ),
          code: ({ children, className }) => {
            const inline = !className?.includes('language-');
            if (inline) {
              return (
                <code className="rounded bg-[color:var(--color-muted)]/60 px-1 py-0.5 font-mono text-[12px]">
                  {children}
                </code>
              );
            }
            return (
              <code className="block overflow-x-auto rounded-[var(--radius-sm)] bg-[color:var(--color-muted)]/60 p-2 font-mono text-[12px]">
                {children}
              </code>
            );
          },
          pre: ({ children }) => <pre className="m-0 p-0">{children}</pre>,
          table: ({ children }) => (
            <div className="overflow-x-auto">
              <table className="m-0 w-full border-collapse text-[13px]">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border-b border-[color:var(--color-border)] px-2 py-1 text-left font-semibold">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border-b border-[color:var(--color-border)]/40 px-2 py-1">
              {children}
            </td>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-[color:var(--color-border)] pl-3 italic text-[color:var(--color-muted-foreground)]">
              {children}
            </blockquote>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
