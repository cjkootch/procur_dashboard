import { NextResponse } from 'next/server';
import { recordApprovalDecision } from '@procur/catalog';
import { dispatchApprovalExecutor } from '@procur/ai';
import { getCurrentCompany, getCurrentUser } from '@procur/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/approvals/[id]/approve
 *
 * Records the reviewer's approval AND dispatches the matching
 * executor (email send / SMS send / Twilio call / etc).
 *
 * Idempotent on (id, decision) — re-approving a row that's already
 * approved is a no-op at the decision layer; each executor
 * additionally short-circuits on `applied_at` so a duplicate POST
 * won't double-send.
 *
 * This route is called by the inline `<ApprovalActionCard>` in
 * the chat assistant. Before the dispatch was wired here, clicking
 * Approve in chat recorded the decision but never fired the
 * executor — emails / SMS / calls all silently failed.
 */
export async function POST(
  _req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const company = await getCurrentCompany();

  const { id } = await context.params;
  const result = await recordApprovalDecision(id, {
    decision: 'approved',
    reviewerId: user.id,
  });
  if (!result.row) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  await dispatchApprovalExecutor(
    {
      id: result.row.id,
      actionType: result.row.actionType,
      proposedPayload: result.row.proposedPayload as Record<string, unknown>,
    },
    user.id,
    company ? { companyId: company.id } : {},
  );
  return NextResponse.json({ ok: true, updated: result.updated, row: result.row });
}
