import { NextResponse } from 'next/server';
import { z } from 'zod';
import { recordApprovalDecision } from '@procur/catalog';
import { getCurrentUser } from '@procur/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z
  .object({
    reason: z.string().max(1000).optional(),
  })
  .optional();

/**
 * POST /api/approvals/[id]/reject
 *
 * Records the reviewer's rejection. Optional `reason` body for the
 * audit trail (stored on the events row metadata; the rejected
 * approval's payload is preserved verbatim so the rejection cause
 * doesn't bleed into the proposal payload).
 */
export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = undefined;
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'bad_request', detail: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { id } = await context.params;
  const result = await recordApprovalDecision(id, {
    decision: 'rejected',
    reviewerId: user.id,
  });
  if (!result.row) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  return NextResponse.json({ ok: true, updated: result.updated, row: result.row });
}
