import { db, toolCallLogs } from '@procur/db';
import type { AssistantContext } from './types';

/**
 * Structured tool-call telemetry — one row per tool invocation. Used
 * for adoption + coverage-gap analytics across the assistant's
 * tool-calling surface.
 *
 * Tools call this from inside their handler — typically wrap the
 * existing handler body in `withToolTelemetry()` rather than calling
 * `logToolCall()` directly so latency + success/failure is captured
 * without per-tool boilerplate.
 *
 * Best-effort: failures here never propagate. The point of telemetry
 * is to be invisible until you query it — losing rows is preferable
 * to breaking the user's chat turn.
 */
export type LogToolCallInput = {
  ctx: Pick<AssistantContext, 'companyId' | 'userId'>;
  threadId?: string | null;
  toolName: string;
  args: unknown;
  resultCount?: number | null;
  resultSummary?: Record<string, unknown> | null;
  success: boolean;
  errorMessage?: string | null;
  latencyMs: number;
};

export async function logToolCall(input: LogToolCallInput): Promise<void> {
  try {
    await db.insert(toolCallLogs).values({
      companyId: input.ctx.companyId,
      userId: input.ctx.userId,
      threadId: input.threadId ?? null,
      toolName: input.toolName,
      args: input.args as Record<string, unknown>,
      resultCount: input.resultCount ?? null,
      resultSummary: input.resultSummary ?? null,
      success: input.success,
      errorMessage: input.errorMessage ?? null,
      latencyMs: input.latencyMs,
    });
  } catch (err) {
    console.error('[tool-telemetry] insert failed', err);
  }
}

export type ToolTelemetrySummary = {
  /** Items returned (length of buyers/suppliers/awards array). Use null when not applicable. */
  resultCount?: number | null;
  /** Cheap key-value pairs for downstream filtering. */
  resultSummary?: Record<string, unknown> | null;
};

/**
 * Wrap a handler body so it logs telemetry on completion. Returns the
 * handler's result unchanged.
 *
 * Tool authors who want bespoke summary extraction (e.g. count
 * `buyers.length` for find_buyers_for_offer but `suppliers.length`
 * for find_suppliers_for_tender) pass a `summarize` callback that
 * derives `{resultCount, resultSummary}` from the result.
 */
export async function withToolTelemetry<O>(
  opts: {
    ctx: Pick<AssistantContext, 'companyId' | 'userId'>;
    threadId?: string | null;
    toolName: string;
    args: unknown;
    summarize?: (out: O) => ToolTelemetrySummary;
  },
  fn: () => Promise<O>,
): Promise<O> {
  const started = Date.now();
  try {
    const out = await fn();
    const summary = opts.summarize ? opts.summarize(out) : {};
    await logToolCall({
      ctx: opts.ctx,
      threadId: opts.threadId,
      toolName: opts.toolName,
      args: opts.args,
      resultCount: summary.resultCount,
      resultSummary: summary.resultSummary,
      success: true,
      latencyMs: Date.now() - started,
    });
    return out;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logToolCall({
      ctx: opts.ctx,
      threadId: opts.threadId,
      toolName: opts.toolName,
      args: opts.args,
      success: false,
      errorMessage: message,
      latencyMs: Date.now() - started,
    });
    throw err;
  }
}
