import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireCompany } from '@procur/auth';
import { getCallDetail } from '@procur/catalog';

export const dynamic = 'force-dynamic';

const STATUS_TONE: Record<string, string> = {
  initiated: 'bg-blue-100 text-blue-900',
  ringing: 'bg-yellow-100 text-yellow-900',
  'in-progress': 'bg-yellow-100 text-yellow-900',
  answered: 'bg-yellow-100 text-yellow-900',
  completed: 'bg-green-100 text-green-900',
  failed: 'bg-red-100 text-red-900',
  busy: 'bg-yellow-100 text-yellow-900',
  'no-answer': 'bg-yellow-100 text-yellow-900',
  canceled: 'bg-[color:var(--color-muted)]/60',
};

const TIMELINE_TONE: Record<string, string> = {
  'voice.initiated': 'bg-blue-100 text-blue-900',
  'voice.ringing': 'bg-yellow-100 text-yellow-900',
  'voice.answered': 'bg-yellow-100 text-yellow-900',
  'voice.in-progress': 'bg-yellow-100 text-yellow-900',
  'voice.completed': 'bg-green-100 text-green-900',
  'voice.failed': 'bg-red-100 text-red-900',
  'voice.busy': 'bg-yellow-100 text-yellow-900',
  'voice.no-answer': 'bg-yellow-100 text-yellow-900',
  'voice.recorded': 'bg-purple-100 text-purple-900',
};

/**
 * /calls/[id] — single-call detail. Identified by Twilio CallSid
 * (the natural key — survives DB rebuilds, matches Twilio Console
 * queries, shared by every status / recording callback).
 *
 * Shows the originating approval context (toNumber, mode, goal,
 * AI instructions if aiMode), the merged lifecycle timeline, and
 * recording playback when available. For conference-mode calls
 * still in progress, surfaces a join button pointing at /voice/[id].
 *
 * Phase 7 brief called for this page; only the index existed before.
 */
export default async function CallDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireCompany();
  const { id } = await params;
  const detail = await getCallDetail(id);
  if (!detail) notFound();

  const isOpen = detail.status !== 'completed' &&
    detail.status !== 'failed' &&
    detail.status !== 'busy' &&
    detail.status !== 'no-answer' &&
    detail.status !== 'canceled';

  return (
    <div className="mx-auto max-w-3xl px-8 py-10">
      <header className="mb-6">
        <Link
          href="/calls"
          className="text-xs text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"
        >
          ← Back to calls
        </Link>
        <div className="mt-2 flex flex-wrap items-baseline gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">
            Call to{' '}
            <span className="font-mono">
              {detail.toNumber ?? 'unknown number'}
            </span>
          </h1>
          {detail.status && (
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_TONE[detail.status] ?? 'bg-[color:var(--color-muted)]/60'}`}
            >
              {detail.status}
            </span>
          )}
          {detail.aiMode && (
            <span className="rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-900">
              AI mode
            </span>
          )}
        </div>
        <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">
          CallSid: <span className="font-mono">{detail.callSid}</span>
          {detail.approvalId && (
            <>
              {' · '}
              Approval:{' '}
              <Link
                href={`/approvals/${detail.approvalId}`}
                className="font-mono underline"
              >
                {detail.approvalId}
              </Link>
            </>
          )}
          {detail.durationSeconds != null && (
            <> · Duration: {detail.durationSeconds}s</>
          )}
        </p>
      </header>

      {/* Contact / org card */}
      {(detail.contact || detail.org) && (
        <section className="mb-6 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4">
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Counterparty
          </h2>
          {detail.contact && (
            <p className="text-sm">
              <Link
                href={`/contacts/${detail.contact.id}`}
                className="font-medium underline"
              >
                {detail.contact.fullName ?? detail.contact.id}
              </Link>
            </p>
          )}
          {detail.org && (
            <p className="text-xs text-[color:var(--color-muted-foreground)]">
              <Link
                href={`/organizations/${detail.org.id}`}
                className="underline"
              >
                {detail.org.legalName}
              </Link>
            </p>
          )}
        </section>
      )}

      {/* Goal + rationale + AI instructions */}
      {(detail.goalHint || detail.rationale || detail.aiInstructions) && (
        <section className="mb-6 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4">
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Context
          </h2>
          {detail.goalHint && (
            <p className="text-sm">
              <span className="font-medium">Goal:</span> {detail.goalHint}
            </p>
          )}
          {detail.rationale && (
            <p className="mt-1 text-sm">
              <span className="font-medium">Rationale:</span> {detail.rationale}
            </p>
          )}
          {detail.aiInstructions && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs font-medium text-[color:var(--color-muted-foreground)]">
                AI system prompt
              </summary>
              <pre className="mt-2 whitespace-pre-wrap break-words rounded-[var(--radius-md)] bg-[color:var(--color-muted)]/40 p-3 font-mono text-xs">
                {detail.aiInstructions}
              </pre>
            </details>
          )}
        </section>
      )}

      {/* Operator-join button — conference-mode calls still in flight. */}
      {isOpen && detail.conferenceRoom && (
        <section className="mb-6 rounded-[var(--radius-lg)] border border-emerald-200 bg-emerald-50 p-4">
          <h2 className="text-sm font-semibold text-emerald-900">
            This call is live
          </h2>
          <p className="mt-1 text-xs text-emerald-800">
            Conference room:{' '}
            <span className="font-mono">{detail.conferenceRoom}</span>
          </p>
          <Link
            href={`/voice/${detail.approvalId ?? ''}`}
            className="mt-3 inline-block rounded-[var(--radius-md)] bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700"
          >
            Join from browser
          </Link>
        </section>
      )}

      {/* Recordings */}
      {detail.recordings.length > 0 && (
        <section className="mb-6 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4">
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Recordings
          </h2>
          <ul className="space-y-3">
            {detail.recordings.map((r) => (
              <li key={r.sid} className="space-y-1">
                {/* Twilio recordings need the Account auth tier to play.
                    The <audio> element lets the browser do basic auth
                    via the URL Twilio returns; in production you may
                    want to proxy this through a signed-URL endpoint. */}
                <audio controls preload="none" className="w-full">
                  <source src={`${r.url}.mp3`} type="audio/mpeg" />
                </audio>
                <p className="text-[10px] text-[color:var(--color-muted-foreground)]">
                  <span className="font-mono">{r.sid}</span>
                  {r.durationSeconds != null && <> · {r.durationSeconds}s</>}
                  {' · '}
                  <a
                    href={`${r.url}.mp3`}
                    className="underline"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Download
                  </a>
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Full timeline */}
      <section>
        <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
          Timeline
        </h2>
        <ul className="space-y-2">
          {detail.timeline.map((entry, idx) => (
            <li
              key={`${entry.type}-${entry.occurredAt.toISOString()}-${idx}`}
              className="flex items-start gap-3 rounded-[var(--radius-md)] border border-[color:var(--color-border)] p-3"
            >
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-medium ${TIMELINE_TONE[entry.type] ?? 'bg-[color:var(--color-muted)]/60'}`}
              >
                {entry.type}
              </span>
              <div className="flex-1">
                <time
                  className="text-xs text-[color:var(--color-muted-foreground)]"
                  dateTime={entry.occurredAt.toISOString()}
                >
                  {entry.occurredAt.toLocaleString()}
                </time>
                {entry.metadata['duration_seconds'] != null && (
                  <span className="ml-2 text-xs text-[color:var(--color-muted-foreground)]">
                    · {String(entry.metadata['duration_seconds'])}s
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
