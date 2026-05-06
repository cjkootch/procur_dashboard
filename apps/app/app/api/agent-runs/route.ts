import { NextResponse } from 'next/server';
import { listAgentRuns } from '@procur/catalog';
import { getCurrentUser } from '@procur/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/agent-runs
 *
 * Recent agent runs per docs/vex-into-procur-merge-brief.md Phase 2.
 * Optional `?status=` filter (pending|running|completed|failed).
 */
const ALLOWED_STATUSES = new Set([
  'pending',
  'running',
  'completed',
  'failed',
]);

export async function GET(req: Request): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const statusParam = url.searchParams.get('status');
  const status =
    statusParam && ALLOWED_STATUSES.has(statusParam)
      ? (statusParam as 'pending' | 'running' | 'completed' | 'failed')
      : undefined;
  const limitParam = url.searchParams.get('limit');
  const limit = limitParam ? Math.min(parseInt(limitParam, 10) || 50, 200) : 50;

  const rows = await listAgentRuns({ ...(status ? { status } : {}), limit });
  return NextResponse.json({ rows });
}
