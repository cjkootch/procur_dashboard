import Link from 'next/link';
import { requireCompany } from '@procur/auth';
import { listPlaybooks } from '@procur/catalog';

export const dynamic = 'force-dynamic';

const STATUS_TONE: Record<string, string> = {
  draft: 'bg-yellow-100 text-yellow-900',
  active: 'bg-green-100 text-green-900',
  deprecated: 'bg-[color:var(--color-muted)]/60',
};

/**
 * Market Playbooks index. Reusable templates — each playbook
 * captures what worked in a probe (segments, contact titles, first-
 * touch angle) so the next probe in a similar market starts smarter.
 */
export default async function MarketPlaybooksIndexPage() {
  await requireCompany();
  const playbooks = await listPlaybooks({});

  return (
    <div className="mx-auto max-w-4xl px-8 py-10">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Market Playbooks</h1>
        <p className="mt-1 max-w-2xl text-sm text-[color:var(--color-muted-foreground)]">
          Reusable templates extracted from completed probes. Each playbook
          carries the segments, contact titles, first-touch angle, and
          conversion benchmarks that worked in a market — so the next
          probe in a similar market starts pre-loaded with what you
          already learned.
        </p>
      </header>

      {playbooks.length === 0 ? (
        <div className="rounded-[var(--radius-lg)] border border-dashed border-[color:var(--color-border)] p-10 text-center text-sm text-[color:var(--color-muted-foreground)]">
          No playbooks yet. Run a probe, generate a Learning Report,
          then click <strong>Save as playbook</strong> to extract the
          probe&apos;s nominations into a reusable template.
        </div>
      ) : (
        <ul className="space-y-2">
          {playbooks.map((p) => (
            <Link
              key={p.id}
              href={`/market-playbooks/${p.id}`}
              className="flex items-start gap-4 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4 transition hover:border-[color:var(--color-foreground)]"
            >
              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-baseline gap-2">
                  <h2 className="text-sm font-medium">{p.name}</h2>
                  <span className="text-xs font-mono text-[color:var(--color-muted-foreground)]">
                    v{p.version}
                  </span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_TONE[p.status] ?? ''}`}
                  >
                    {p.status}
                  </span>
                  {p.applicableCountries.length > 0 && (
                    <span className="rounded-full bg-[color:var(--color-muted)]/60 px-2 py-0.5 text-xs font-mono">
                      {p.applicableCountries.join(', ')}
                    </span>
                  )}
                </div>
                {p.description && (
                  <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)] line-clamp-2">
                    {p.description}
                  </p>
                )}
                <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">
                  {p.recommendedSegments.length} recommended segment
                  {p.recommendedSegments.length === 1 ? '' : 's'} ·{' '}
                  {p.bestContactTitles.length} contact title
                  {p.bestContactTitles.length === 1 ? '' : 's'} ·{' '}
                  {p.sourceProbeIds.length} source probe
                  {p.sourceProbeIds.length === 1 ? '' : 's'}
                </p>
              </div>
              <time
                className="shrink-0 text-xs text-[color:var(--color-muted-foreground)]"
                dateTime={p.updatedAt.toISOString()}
              >
                {p.updatedAt.toLocaleDateString()}
              </time>
            </Link>
          ))}
        </ul>
      )}
    </div>
  );
}
