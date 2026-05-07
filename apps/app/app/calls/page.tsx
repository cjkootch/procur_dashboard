import Link from 'next/link';
import { requireCompany } from '@procur/auth';
import { listMessagingTimeline, listVoiceTimeline } from '@procur/catalog';

export const dynamic = 'force-dynamic';

const CHANNEL_TONE: Record<string, string> = {
  'voice.initiated': 'bg-blue-100 text-blue-900',
  'voice.completed': 'bg-green-100 text-green-900',
  'voice.failed': 'bg-red-100 text-red-900',
  'voice.busy': 'bg-yellow-100 text-yellow-900',
  'voice.no-answer': 'bg-yellow-100 text-yellow-900',
  'voice.recorded': 'bg-[color:var(--color-muted)]/60',
  'sms.sent': 'bg-green-100 text-green-900',
  'sms.received': 'bg-blue-100 text-blue-900',
  'whatsapp.sent': 'bg-green-100 text-green-900',
  'whatsapp.received': 'bg-blue-100 text-blue-900',
};

/**
 * Calls + messaging timeline per docs/vex-into-procur-merge-brief.md
 * Phase 7. Reads the touchpoints table — voice.* + sms.* +
 * whatsapp.* channels merged. AI talkback voice ships in Phase 7.5
 * via a separate Fly app; v1 supports operator-join-conference only.
 */
export default async function CallsPage() {
  await requireCompany();
  const [voice, messaging] = await Promise.all([
    listVoiceTimeline({ limit: 50 }),
    listMessagingTimeline({ limit: 50 }),
  ]);

  return (
    <div className="mx-auto max-w-3xl px-8 py-10">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Calls &amp; messaging
          </h1>
          <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">
            Twilio outbound + inbound timeline. Outbound calls + SMS +
            WhatsApp route through the approval queue at T2 / T3.
          </p>
        </div>
        <Link
          href="/inbox"
          className="text-sm text-[color:var(--color-muted-foreground)] underline hover:text-[color:var(--color-foreground)]"
        >
          Email inbox →
        </Link>
      </header>

      <Section title="Voice" rows={voice} channelToneMap={CHANNEL_TONE} />
      <Section title="SMS / WhatsApp" rows={messaging} channelToneMap={CHANNEL_TONE} />
    </div>
  );
}

function Section({
  title,
  rows,
  channelToneMap,
}: {
  title: string;
  rows: Array<{
    id: string;
    channel: string;
    occurredAt: Date;
    metadata: Record<string, unknown>;
    contactId: string | null;
  }>;
  channelToneMap: Record<string, string>;
}) {
  return (
    <section className="mb-6">
      <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
        {title}
      </h2>
      {rows.length === 0 ? (
        <div className="rounded-[var(--radius-lg)] border border-dashed border-[color:var(--color-border)] p-6 text-center text-sm text-[color:var(--color-muted-foreground)]">
          No {title.toLowerCase()} activity yet.
        </div>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => {
            const meta = row.metadata;
            const callSid = meta['provider_call_id'] as string | undefined;
            const provider =
              callSid ??
              ((meta['provider_message_id'] as string | undefined) ?? '');
            const to = (meta['to'] ?? meta['to_number'] ?? '') as string;
            const from = (meta['from'] ?? '') as string;
            const preview = (meta['body_preview'] ??
              meta['body_text'] ??
              '') as string;
            const duration = meta['duration_seconds'] as number | undefined;
            // Voice rows link to the call detail page (/calls/<callSid>);
            // SMS / WhatsApp rows stay non-clickable for now (no per-message
            // surface yet).
            const detailHref =
              row.channel.startsWith('voice.') && callSid
                ? `/calls/${callSid}`
                : null;
            const inner = (
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${channelToneMap[row.channel] ?? ''}`}
                  >
                    {row.channel}
                  </span>
                  {to && <span className="font-mono text-xs">→ {to}</span>}
                  {from && !to && (
                    <span className="font-mono text-xs">from {from}</span>
                  )}
                  <time
                    className="ml-auto text-xs text-[color:var(--color-muted-foreground)]"
                    dateTime={row.occurredAt.toISOString()}
                  >
                    {row.occurredAt.toLocaleString()}
                  </time>
                </div>
                {preview && (
                  <p className="mt-1 text-xs">{preview.slice(0, 240)}</p>
                )}
                <p className="mt-0.5 text-xs text-[color:var(--color-muted-foreground)]">
                  {duration != null && <>Duration: {duration}s · </>}
                  {provider && <span className="font-mono">{provider}</span>}
                </p>
              </div>
            );
            return (
              <li
                key={row.id}
                className="flex items-start gap-3 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-3 hover:border-[color:var(--color-foreground)]"
              >
                {detailHref ? (
                  <Link href={detailHref} className="flex flex-1 items-start">
                    {inner}
                  </Link>
                ) : (
                  inner
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
