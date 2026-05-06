import { NextResponse } from 'next/server';
import { listPendingApprovals } from '@procur/catalog';
import { getCurrentUser } from '@procur/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/approvals
 *
 * Pending-approvals queue per docs/vex-into-procur-merge-brief.md
 * Phase 2. Default 20 most-recent pending rows; pagination deferred
 * to a later phase (single-user scope keeps backlog small).
 */
export async function GET(req: Request): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const limitParam = url.searchParams.get('limit');
  const limit = limitParam ? Math.min(parseInt(limitParam, 10) || 20, 100) : 20;

  const rows = await listPendingApprovals({ limit });
  return NextResponse.json({ rows });
}
