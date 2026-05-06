import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireCompany } from '@procur/auth';
import { getCampaignDetail } from '@procur/catalog';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function CampaignDetailPage({ params }: PageProps) {
  await requireCompany();
  const { id } = await params;
  const detail = await getCampaignDetail(id);
  if (!detail) notFound();

  return (
    <div className="mx-auto max-w-3xl px-8 py-10">
      <Link
        href="/campaigns"
        className="text-sm text-[color:var(--color-muted-foreground)] hover:underline"
      >
        ← Campaigns
      </Link>

      <header className="mt-4 mb-6">
        <h1 className="font-mono text-2xl font-semibold tracking-tight">
          {detail.campaign.id}
        </h1>
        <div className="mt-1 flex items-center gap-2 text-sm">
          <span className="rounded-full bg-[color:var(--color-muted)]/60 px-2 py-0.5 text-xs font-medium">
            {detail.campaign.channel}
          </span>
          <span className="rounded-full bg-[color:var(--color-muted)]/60 px-2 py-0.5 text-xs font-medium">
            {detail.campaign.status}
          </span>
        </div>
        {detail.campaign.objective && (
          <p className="mt-2 text-sm">{detail.campaign.objective}</p>
        )}
      </header>

      <section className="rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4">
        <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
          Steps
        </h2>
        {detail.steps.length === 0 ? (
          <p className="text-sm text-[color:var(--color-muted-foreground)]">
            No steps configured.
          </p>
        ) : (
          <ol className="space-y-3">
            {detail.steps.map((s) => (
              <li
                key={s.id}
                className="flex items-start gap-3 rounded-[var(--radius-md)] border border-[color:var(--color-border)] p-3"
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[color:var(--color-muted)]/60 text-xs font-medium">
                  {s.position}
                </span>
                <div className="flex-1">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="font-medium">{s.channel}</span>
                    <span className="rounded-full bg-[color:var(--color-muted)]/60 px-2 py-0.5 text-xs">
                      {s.tier}
                    </span>
                    {s.autoApprove && (
                      <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-900">
                        auto-approve
                      </span>
                    )}
                  </div>
                  {s.delayAfterPriorMs > 0 && (
                    <p className="mt-0.5 text-xs text-[color:var(--color-muted-foreground)]">
                      delay: {Math.round(s.delayAfterPriorMs / 60_000)} min
                    </p>
                  )}
                  {s.templateRef && (
                    <p className="mt-0.5 text-xs">
                      Template:{' '}
                      <code className="bg-[color:var(--color-muted)]/40 px-1">
                        {s.templateRef}
                      </code>
                    </p>
                  )}
                  {s.subjectOverride && (
                    <p className="mt-0.5 text-xs">
                      Subject: {s.subjectOverride}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
