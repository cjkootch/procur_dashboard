import 'server-only';
import { and, desc, eq } from 'drizzle-orm';
import { db, summaries } from '@procur/db';

/**
 * Daily-brief read helper (vex-into-procur merge Phase 6). Reads the
 * latest `daily_brief` summary row and parses its JSON content.
 * Returns null when no brief has been generated yet.
 */

export interface DailyBriefSummary {
  id: string;
  generatedAt: string;
  greeting: string;
  recommendedFocus: string;
  pendingApprovalsCount: number;
  unacknowledgedSignalsCount: number;
  staleLeadsCount: number;
  activeDealsCount: number;
  topApprovals: Array<{
    id: string;
    actionType: string;
    createdAt: string;
    rationale: string | null;
  }>;
  topSignals: Array<{
    id: string;
    severity: string;
    title: string;
    createdAt: string;
  }>;
  riskyDeals: Array<{
    id: string;
    dealRef: string;
    status: string;
    complianceHold: boolean;
  }>;
  yesterdayAgentRuns: number;
  yesterdayCompletedAgentRuns: number;
  /** When this row was last written. */
  updatedAt: Date;
}

export async function getLatestDailyBrief(): Promise<DailyBriefSummary | null> {
  const rows = await db
    .select({
      id: summaries.id,
      content: summaries.content,
      updatedAt: summaries.updatedAt,
    })
    .from(summaries)
    .where(
      and(
        eq(summaries.subjectType, 'workspace'),
        eq(summaries.subjectId, 'global'),
        eq(summaries.summaryType, 'daily_brief'),
      ),
    )
    .orderBy(desc(summaries.updatedAt))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.content) as Omit<
      DailyBriefSummary,
      'id' | 'updatedAt'
    >;
    return {
      id: row.id,
      ...parsed,
      updatedAt: row.updatedAt,
    };
  } catch {
    return null;
  }
}
