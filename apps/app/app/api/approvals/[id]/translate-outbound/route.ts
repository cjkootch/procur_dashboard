import { NextResponse } from 'next/server';
import { z } from 'zod';
import { translateApprovalField } from '@procur/catalog';
import { getCurrentUser } from '@procur/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/approvals/[id]/translate-outbound
 *
 * Operator-driven outbound translation memory. Operator composed
 * (or edited) a body / subject in their native language; this
 * route translates it to the target language for the wire copy
 * while preserving the original on payload.translation_audit so
 * the approval card can show "Original (en): ..." alongside.
 *
 * Pairs with the inbox auto-translation feature (#591) — that
 * handles inbound rendering ("Translated from <Lang>" on display);
 * this handles outbound composition ("Translated to <Lang>" on
 * send).
 *
 * Probe-aware: when the approval came from probe autopilot, the
 * catalog helper reads the probe's formality_level + domain_hint
 * and threads them into the translator so the wire copy honors
 * the same per-probe steering as the original draft did.
 *
 * Whitelisted to body / subject so a malicious / confused caller
 * can't translate structural fields (recipient list, contact id,
 * tier).
 */
const TranslateSchema = z.object({
  field: z.enum(['body', 'subject']),
  /** ISO 639-1 lowercase. Validated again in the helper; we
   *  duplicate the regex here to give a clean 400 on bad input. */
  targetLanguage: z
    .string()
    .regex(/^[a-z]{2}$/, 'expected 2-letter ISO 639-1 lowercase'),
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
  const parsed = TranslateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_input', details: parsed.error.issues },
      { status: 400 },
    );
  }

  const result = await translateApprovalField({
    approvalId: id,
    field: parsed.data.field,
    targetLanguage: parsed.data.targetLanguage,
    userId: user.id,
  });
  if (!result.ok) {
    const status =
      result.reason === 'not_found'
        ? 404
        : result.reason === 'not_pending'
          ? 409
          : result.reason === 'translation_failed'
            ? 502
            : 400;
    return NextResponse.json({ error: result.reason }, { status });
  }
  return NextResponse.json({
    ok: true,
    translated: result.translated,
    sourceLanguage: result.sourceLanguage,
    row: result.row,
  });
}
