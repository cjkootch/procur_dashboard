import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireCompany } from '@procur/auth';
import { getPlaybook } from '@procur/catalog';
import { setPlaybookStatusAction } from '../../market-probes/actions';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function MarketPlaybookDetailPage({ params }: PageProps) {
  await requireCompany();
  const { id } = await params;
  const playbook = await getPlaybook(id);
  if (!playbook) notFound();

  return (
    <div className="mx-auto max-w-4xl px-8 py-10">
      <Link
        href="/market-playbooks"
        className="text-sm text-[color:var(--color-muted-foreground)] hover:underline"
      >
        ← Market Playbooks
      </Link>
      <header className="mt-4 mb-6">
        <div className="flex flex-wrap items-baseline gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">
            {playbook.name}
          </h1>
          <span className="text-sm font-mono text-[color:var(--color-muted-foreground)]">
            v{playbook.version}
          </span>
          <span className="rounded-full bg-[color:var(--color-muted)]/60 px-2 py-0.5 text-xs font-medium">
            {playbook.status}
          </span>
        </div>
        {playbook.description && (
          <p className="mt-2 text-sm">{playbook.description}</p>
        )}
        {playbook.applicableCountries.length > 0 && (
          <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">
            Applicable: {playbook.applicableCountries.join(', ')}
          </p>
        )}

        {/* Status promotion controls */}
        <div className="mt-3 flex items-center gap-2">
          {playbook.status === 'draft' && (
            <form action={setPlaybookStatusAction}>
              <input type="hidden" name="playbookId" value={playbook.id} />
              <input type="hidden" name="status" value="active" />
              <button
                type="submit"
                className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-3 py-1 text-xs font-medium text-[color:var(--color-background)]"
              >
                Promote to active
              </button>
            </form>
          )}
          {playbook.status === 'active' && (
            <form action={setPlaybookStatusAction}>
              <input type="hidden" name="playbookId" value={playbook.id} />
              <input type="hidden" name="status" value="deprecated" />
              <button
                type="submit"
                className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-3 py-1 text-xs hover:bg-[color:var(--color-muted)]/40"
              >
                Deprecate
              </button>
            </form>
          )}
        </div>
      </header>

      <div className="space-y-6">
        <PlaybookSection title="Recommended segments" items={playbook.recommendedSegments} />
        {playbook.avoidedSegments.length > 0 && (
          <PlaybookSection title="Avoided segments" items={playbook.avoidedSegments} tone="negative" />
        )}
        <PlaybookSection title="Best contact titles" items={playbook.bestContactTitles} />
        {playbook.avoidedContactTitles.length > 0 && (
          <PlaybookSection title="Avoided contact titles" items={playbook.avoidedContactTitles} tone="negative" />
        )}

        {playbook.bestFirstTouchAngle && (
          <section className="rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4">
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
              Best first-touch angle
            </h2>
            <p className="text-sm">{playbook.bestFirstTouchAngle}</p>
          </section>
        )}

        {playbook.complianceNotes && (
          <section className="rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4">
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
              Compliance notes
            </h2>
            <p className="text-sm whitespace-pre-wrap">
              {playbook.complianceNotes}
            </p>
          </section>
        )}

        {Object.keys(playbook.conversionBenchmarksJson ?? {}).length > 0 && (
          <section className="rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4">
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
              Source-probe benchmarks
            </h2>
            <dl className="grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
              {Object.entries(playbook.conversionBenchmarksJson).map(
                ([k, v]) => (
                  <div key={k}>
                    <dt className="text-[10px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
                      {k}
                    </dt>
                    <dd className="font-mono">
                      {(Number(v) * 100).toFixed(1)}%
                    </dd>
                  </div>
                ),
              )}
            </dl>
          </section>
        )}

        {playbook.sourceProbeIds.length > 0 && (
          <section className="rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4">
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
              Source probes
            </h2>
            <ul className="space-y-1">
              {playbook.sourceProbeIds.map((pid) => (
                <li key={pid}>
                  <Link
                    href={`/market-probes/${pid}`}
                    className="text-xs font-mono hover:underline"
                  >
                    {pid}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        {playbook.parentPlaybookId && (
          <p className="text-xs text-[color:var(--color-muted-foreground)]">
            Forked from{' '}
            <Link
              href={`/market-playbooks/${playbook.parentPlaybookId}`}
              className="font-mono hover:underline"
            >
              {playbook.parentPlaybookId}
            </Link>
          </p>
        )}
      </div>
    </div>
  );
}

function PlaybookSection({
  title,
  items,
  tone,
}: {
  title: string;
  items: string[];
  tone?: 'negative';
}) {
  if (items.length === 0) return null;
  return (
    <section className="rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
        {title}
      </h2>
      <ul className="flex flex-wrap gap-1.5">
        {items.map((item, i) => (
          <li
            key={i}
            className={`rounded-full px-2 py-0.5 text-xs ${
              tone === 'negative'
                ? 'bg-red-100 text-red-900'
                : 'bg-[color:var(--color-muted)]/60'
            }`}
          >
            {item}
          </li>
        ))}
      </ul>
    </section>
  );
}
