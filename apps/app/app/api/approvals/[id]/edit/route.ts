import { NextResponse } from 'next/server';
import { z } from 'zod';
import { editApprovalPayloadField } from '@procur/catalog';
import { getCurrentUser } from '@procur/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/approvals/[id]/edit
 *
 * Replace one free-text field on a pending approval's payload —
 * powers the inline pencil-edit on the chat assistant's approval
 * cards. Whitelisted to body / subject / aiInstructions / goalHint
 * so a malicious / confused caller can't rewrite contact ids,
 * ULIDs, or tier.
 *
 * The catalog helper records the before/after to feedback_events
 * (kind: communication_edit) so the user's revisions accumulate
 * into a training signal — model drafted X, operator wanted Y, for
 * action_type Z.
 */
const EditSchema = z.object({
  field: z.enum(['body', 'subject', 'aiInstructions', 'goalHint']),
  value: z.string().min(1).max(50_000),
});

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { id } = await context.params;

  const body = (await req.json().catch(() => null)) as unknown;
  const parsed = EditSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_input', details: parsed.error.issues },
      { status: 400 },
    );
  }

  const result = await editApprovalPayloadField({
    approvalId: id,
    field: parsed.data.field,
    value: parsed.data.value,
    userId: user.id,
  });
  if (!result.ok) {
    const status = result.reason === 'not_found' ? 404 : 409;
    return NextResponse.json({ error: result.reason }, { status });
  }
  return NextResponse.json({ ok: true, row: result.row });
}
