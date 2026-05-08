/**
 * Cost ledger — append-only record of every chargeable operation.
 * Per the agent-runtime invariant (vex-into-procur merge brief Phase 2):
 * every LLM call, embedding, voice turn, and provider-metered action
 * MUST write a CostEntry. The ledger is the source of truth for cost
 * attribution; `ai_usage` becomes a fast daily aggregate fed by the
 * dual-write path in `assistant/loop.ts`.
 */

export type CostOperation =
  | 'llm.completion'
  | 'llm.embedding'
  | 'llm.voice'
  | 'tts'
  | 'stt'
  | 'pstn.minute'
  | 'pstn.call'
  | 'email.send'
  | 'lead_form.submit'
  | 'sms.send'
  | 'whatsapp.send'
  | 'whatsapp.send_template'
  | 'web.search';

export interface CostEntry {
  /** Stable idempotency key — duplicate keys collapse to one row. */
  readonly idempotencyKey: string;
  /** Optional link to the agent run that produced the cost. */
  readonly agentRunId?: string | undefined;
  readonly operation: CostOperation;
  /** "anthropic", "openai", "twilio", "resend", "tavily", … */
  readonly provider: string;
  /** "claude-sonnet-4-5", "text-embedding-3-small", … */
  readonly model?: string | undefined;
  /** Units billed: tokens, seconds, messages, etc. */
  readonly units: number;
  /** "input_tokens" | "output_tokens" | "seconds" | "calls" | … */
  readonly unitKind: string;
  /** USD micros (1 USD = 1_000_000) — integer to avoid float drift. */
  readonly costUsdMicros: number;
  readonly occurredAt: Date;
}

export interface CostLedger {
  record(entry: CostEntry): Promise<void>;
}

/** In-memory implementation for tests + dev-without-DB scenarios. */
export class InMemoryCostLedger implements CostLedger {
  private readonly entries = new Map<string, CostEntry>();

  async record(entry: CostEntry): Promise<void> {
    if (!this.entries.has(entry.idempotencyKey)) {
      this.entries.set(entry.idempotencyKey, entry);
    }
  }

  snapshot(): readonly CostEntry[] {
    return [...this.entries.values()];
  }

  totalMicros(): number {
    let total = 0;
    for (const e of this.entries.values()) total += e.costUsdMicros;
    return total;
  }

  sumMicrosBetween(start: Date, end: Date): number {
    let total = 0;
    for (const e of this.entries.values()) {
      const t = e.occurredAt.getTime();
      if (t < start.getTime()) continue;
      if (t >= end.getTime()) continue;
      total += e.costUsdMicros;
    }
    return total;
  }

  sumMicrosToday(now: Date = new Date()): number {
    const start = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        0,
        0,
        0,
        0,
      ),
    );
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    return this.sumMicrosBetween(start, end);
  }
}

export { PostgresCostLedger, sumCostLedgerToday } from './postgres';
