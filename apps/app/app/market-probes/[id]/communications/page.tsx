import Link from 'next/link';
import { requireCompany } from '@procur/auth';
import { listProbeConversations } from '@procur/catalog';

const CHANNEL_TONE: Record<string, string> = {
  email: 'bg-blue-100 text-blue-900',
  lead_form: 'bg-purple-100 text-purple-900',
  voice: 'bg-amber-100 text-amber-900',
  rvm: 'bg-amber-100 text-amber-900',
  sms: 'bg-green-100 text-green-900',
  whatsapp: 'bg-green-100 text-green-900',
};

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function ProbeCommunicationsPage({ params }: PageProps) {
  await requireCompany();
  const { id } = await params;
  const conversations = await listProbeConversations(id);

  return (
    <section className="rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-5">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
          Conversations ({conversations.length})
        </h2>
        <p className="text-[10px] text-[color:var(--color-muted-foreground)]">
          Threads linked to this probe via{' '}
          <code>conversation_settings.linkedProbeId</code>
        </p>
      </div>

      {conversations.length === 0 ? (
        <p className="text-sm text-[color:var(--color-muted-foreground)]">
          No conversations yet. Once outreach dispatches via this probe
          (autopilot batch or chat-driven{' '}
          <code>propose_email_send</code> /{' '}
          <code>propose_rvm_dispatch</code> /{' '}
          <code>submit_lead_form</code>), threads land here.
        </p>
      ) : (
        <ul className="divide-y divide-[color:var(--color-border)]">
          {conversations.map((c) => {
            // Email channel: deep-link to inbox by conversation key. Other
            // channels: deep-link to entity page when we have a slug,
            // otherwise just render the row read-only. The inbox doesn't
            // surface lead_form / voice / rvm threads today.
            const inboxHref =
              c.channel === 'email'
                ? `/inbox?email=${encodeURIComponent(c.conversationKey)}`
                : null;
            const entityHref = c.linkedEntitySlug
              ? `/entities/${encodeURIComponent(c.linkedEntitySlug)}`
              : null;
            return (
              <li
                key={`${c.channel}:${c.conversationKey}`}
                className="flex flex-wrap items-center gap-3 py-2 text-xs"
              >
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                    CHANNEL_TONE[c.channel] ??
                    'bg-[color:var(--color-muted)]/60 text-[color:var(--color-muted-foreground)]'
                  }`}
                >
                  {c.channel}
                </span>
                <code className="flex-1 truncate">{c.conversationKey}</code>
                {c.entityName && (
                  <span className="text-[color:var(--color-muted-foreground)]">
                    {c.entityName}
                  </span>
                )}
                <span className="text-[10px] text-[color:var(--color-muted-foreground)]">
                  {c.lastActivityAt.toLocaleString()}
                </span>
                <span
                  className="rounded-full border border-[color:var(--color-border)] px-1.5 py-0.5 text-[10px] font-mono"
                  title="Approval mode for this conversation. tiered = auto-send safe replies; full_approval = always queue."
                >
                  {c.approvalMode}
                </span>
                <div className="flex gap-2 text-[10px]">
                  {inboxHref && (
                    <Link
                      href={inboxHref}
                      className="text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)] hover:underline"
                    >
                      open in inbox →
                    </Link>
                  )}
                  {entityHref && (
                    <Link
                      href={entityHref}
                      className="text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)] hover:underline"
                    >
                      entity →
                    </Link>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
