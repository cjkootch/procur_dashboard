import Link from 'next/link';
import { notFound } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { approvals, db } from '@procur/db';
import { requireCompany } from '@procur/auth';
import { OperatorJoinForm } from './OperatorJoinForm';
import { joinConferenceAction } from './actions';

export const dynamic = 'force-dynamic';

/**
 * /voice/[id] — operator-join landing for a conference-mode outbound
 * call. The "id" path segment is the approval id of the originating
 * outbound_call action; the conference room name derives as
 * `procur-${approvalId}` (matches what the TwiML route configures
 * for the recipient leg).
 *
 * The flow:
 *   1. Operator clicks "Join from browser" on /calls/[callSid]
 *   2. Lands here, enters/confirms their phone number
 *   3. Server action dials that number from TWILIO_PHONE_NUMBER and
 *      drops both legs into the same conference room
 *   4. Operator answers → talks to the recipient
 *
 * We use phone dial-out instead of the Twilio Voice JS SDK because
 * the SDK requires a TwiML App SID + browser microphone permission
 * + JWT minting — complexity the dial-out approach avoids entirely.
 * The trade-off: requires a phone the operator can answer, which for
 * a desk-side workflow is fine.
 *
 * AI-mode calls (aiMode=true) cannot be joined here — they connect
 * straight to the voice-bridge instead of a conference room. The
 * server action enforces that.
 */
export default async function VoiceJoinPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireCompany();
  const { id: approvalId } = await params;

  const approvalRows = await db
    .select({
      actionType: approvals.actionType,
      decision: approvals.decision,
      appliedAt: approvals.appliedAt,
      appliedObjectId: approvals.appliedObjectId,
      payload: approvals.proposedPayload,
    })
    .from(approvals)
    .where(eq(approvals.id, approvalId))
    .limit(1);
  const approval = approvalRows[0];
  if (!approval || approval.actionType !== 'outbound_call') notFound();

  const payload = (approval.payload as Record<string, unknown> | null) ?? {};
  const aiMode = payload['aiMode'] === true;
  const toNumber =
    typeof payload['toNumber'] === 'string'
      ? (payload['toNumber'] as string)
      : null;
  const goalHint =
    typeof payload['goalHint'] === 'string'
      ? (payload['goalHint'] as string)
      : null;
  const conferenceRoom = `procur-${approvalId}`;

  return (
    <div className="mx-auto max-w-md px-8 py-10">
      <header className="mb-6">
        <Link
          href={
            approval.appliedObjectId
              ? `/calls/${approval.appliedObjectId}`
              : '/calls'
          }
          className="text-xs text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"
        >
          ← Back to call detail
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">
          Join the call
        </h1>
        {toNumber && (
          <p className="mt-1 text-sm">
            Recipient:{' '}
            <span className="font-mono">{toNumber}</span>
          </p>
        )}
        {goalHint && (
          <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">
            Goal: {goalHint}
          </p>
        )}
      </header>

      {aiMode ? (
        <div
          role="alert"
          className="rounded-[var(--radius-md)] border border-yellow-200 bg-yellow-50 px-4 py-3 text-sm text-yellow-900"
        >
          This call is in <strong className="font-semibold">AI mode</strong> —
          it connects directly to the voice-bridge, not a conference room.
          You can&apos;t join it from this page. Listen to the recording when
          the call completes.
        </div>
      ) : approval.decision !== 'approved' &&
        approval.decision !== 'auto_approved' ? (
        <div
          role="alert"
          className="rounded-[var(--radius-md)] border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
        >
          Approval is <strong className="font-semibold">{approval.decision}</strong>{' '}
          — approve it from{' '}
          <Link href={`/approvals/${approvalId}`} className="underline">
            /approvals/{approvalId}
          </Link>{' '}
          first to dispatch the call.
        </div>
      ) : !approval.appliedAt ? (
        <div
          role="alert"
          className="rounded-[var(--radius-md)] border border-yellow-200 bg-yellow-50 px-4 py-3 text-sm text-yellow-900"
        >
          The call hasn&apos;t been dispatched to Twilio yet — the executor
          may have failed. Check the approval row at{' '}
          <Link href={`/approvals/${approvalId}`} className="underline">
            /approvals/{approvalId}
          </Link>
          .
        </div>
      ) : (
        <OperatorJoinForm
          approvalId={approvalId}
          conferenceRoom={conferenceRoom}
          action={joinConferenceAction}
        />
      )}
    </div>
  );
}
