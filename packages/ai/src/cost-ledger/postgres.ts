import { sql } from 'drizzle-orm';
import { db, costLedger as costLedgerTable } from '@procur/db';
import { ulid } from 'ulid';
import type { CostEntry, CostLedger } from './index';

/**
 * Postgres-backed implementation of CostLedger. Idempotent on
 * `idempotency_key` — replaying the same entry collapses to one row
 * via `ON CONFLICT DO NOTHING`. Failures fail open: a logging warning
 * is emitted and the call returns. The ledger MUST NEVER block the
 * caller — vex's invariant ("missing ledger never blocks agents") ports
 * verbatim.
 */
export class PostgresCostLedger implements CostLedger {
  async record(entry: CostEntry): Promise<void> {
    try {
      await db
        .insert(costLedgerTable)
        .values({
          id: ulid(),
          agentRunId: entry.agentRunId ?? null,
          idempotencyKey: entry.idempotencyKey,
          operation: entry.operation,
          provider: entry.provider,
          model: entry.model ?? null,
          units: entry.units,
          unitKind: entry.unitKind,
          costUsdMicros: entry.costUsdMicros,
          occurredAt: entry.occurredAt,
        })
        .onConflictDoNothing({ target: costLedgerTable.idempotencyKey });
    } catch (err) {
      // Fail open — never block the caller on ledger writes.
      // eslint-disable-next-line no-console
      console.warn(
        JSON.stringify({
          level: 'warn',
          service: 'cost_ledger.record',
          msg: 'cost ledger write failed — continuing',
          error: (err as Error).message,
          idempotency_key: entry.idempotencyKey,
        }),
      );
    }
  }
}

/**
 * Sum cost_usd_micros for occurrences in [start, end). Powers the
 * AgentRunner pre-run cost gate. Returns 0 on query failure (fail
 * open).
 */
export async function sumCostLedgerToday(
  now: Date = new Date(),
): Promise<number> {
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
  try {
    const rows = await db
      .select({
        total: sql<number>`coalesce(sum(${costLedgerTable.costUsdMicros}), 0)::bigint`,
      })
      .from(costLedgerTable)
      .where(
        sql`${costLedgerTable.occurredAt} >= ${start} AND ${costLedgerTable.occurredAt} < ${end}`,
      );
    return Number(rows[0]?.total ?? 0);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      JSON.stringify({
        level: 'warn',
        service: 'cost_ledger.sumToday',
        msg: 'cost ledger sum failed — returning 0',
        error: (err as Error).message,
      }),
    );
    return 0;
  }
}
