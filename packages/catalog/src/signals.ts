import 'server-only';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db, signals } from '@procur/db';

/**
 * Read/write helpers for the signals layer (vex-into-procur merge
 * Phase 6). The signals table itself landed in Phase 1; agents fire
 * rows directly via drizzle (no central rules engine — vex-style).
 */

export interface SignalListRow {
  id: string;
  ruleId: string;
  severity: string;
  subjectType: string | null;
  subjectId: string | null;
  title: string;
  body: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  acknowledgedAt: Date | null;
  acknowledgedBy: string | null;
}

export async function listSignals(
  options: {
    onlyUnacknowledged?: boolean;
    limit?: number;
  } = {},
): Promise<SignalListRow[]> {
  const limit = options.limit ?? 100;
  const rows = await db
    .select({
      id: signals.id,
      ruleId: signals.ruleId,
      severity: signals.severity,
      subjectType: signals.subjectType,
      subjectId: signals.subjectId,
      title: signals.title,
      body: signals.body,
      metadata: signals.metadata,
      createdAt: signals.createdAt,
      acknowledgedAt: signals.acknowledgedAt,
      acknowledgedBy: signals.acknowledgedBy,
    })
    .from(signals)
    .where(options.onlyUnacknowledged ? isNull(signals.acknowledgedAt) : undefined)
    .orderBy(desc(signals.createdAt))
    .limit(limit);
  return rows as SignalListRow[];
}

export async function acknowledgeSignal(
  id: string,
  reviewerId: string,
): Promise<{ updated: boolean }> {
  const updated = await db
    .update(signals)
    .set({
      acknowledgedAt: new Date(),
      acknowledgedBy: reviewerId,
    })
    .where(and(eq(signals.id, id), isNull(signals.acknowledgedAt)))
    .returning({ id: signals.id });
  return { updated: updated.length > 0 };
}

export async function countUnacknowledgedSignals(): Promise<number> {
  try {
    const rows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(signals)
      .where(isNull(signals.acknowledgedAt));
    return Number(rows[0]?.count ?? 0);
  } catch {
    return 0;
  }
}
