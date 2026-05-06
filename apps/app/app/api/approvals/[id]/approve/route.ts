import { NextResponse } from 'next/server';
import { recordApprovalDecision } from '@procur/catalog';
import { getCurrentUser } from '@procur/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/approvals/[id]/approve
 *
 * Records the reviewer's approval. Idempotent on (id, decision) — re-
 * approving a row that's already approved is a no-op. The actual
 * side-effect (sending email, creating deal, etc.) is applied later
 * by per-domain executor logic landing in Phase 3+.
 */
export async function POST(
  _req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const { id } = await context.params;
  const result = await recordApprovalDecision(id, {
    decision: 'approved',
    reviewerId: user.id,
  });
  if (!result.row) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  return NextResponse.json({ ok: true, updated: result.updated, row: result.row });
}
