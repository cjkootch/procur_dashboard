import Link from 'next/link';
import { requireCompany } from '@procur/auth';
import { runGlobalSearch, type SearchHit } from '../../lib/search-queries';
import { formatDate } from '../../lib/format';

export const dynamic = 'force-dynamic';

const KIND_LABEL: Record<SearchHit['kind'], string> = {
  opportunity: 'Opportunity',
  pursuit: 'Pursuit',
  contract: 'Contract',
  past_performance: 'Past performance',
  library: 'Library',
};

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const { company } = await requireCompany();
  const query = (q ?? '').trim();
  const results = query.length > 0 ? await runGlobalSearch(company.id, query) : null;

  return (
    <div className="mx-auto max-w-5xl px-8 py-10">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Search</h1>
        <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">
          Search across your pursuits, contracts, past performance, content library, and active
          opportunities in the Procur index.
        </p>
      </header>

      <form method="get" className="mb-6">
        <input
          type="search"
          name="q"
          defaultValue={query}
          autoFocus
          placeholder="e.g. cybersecurity, Trinidad, RFP-2024, project manager…"
          className="w-full rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-4 py-3 text-base"
        />
      </form>

      {!results && (
        <div className="rounded-[var(--radius-lg)] border border-dashed border-[color:var(--color-border)] p-10 text-center text-sm text-[color:var(--color-muted-foreground)]">
          Enter a query to search. Matches title, description, reference numbers, and
          narrative content across every module.
        </div>
      )}

      {results && results.totalCount === 0 && (
        <div className="rounded-[var(--radius-lg)] border border-dashed border-[color:var(--color-border)] p-10 text-center text-sm text-[color:var(--color-muted-foreground)]">
          No matches for &ldquo;{query}&rdquo;. Try a broader term or different spelling.
        </div>
      )}

      {results && results.totalCount > 0 && (
        <p className="mb-4 text-xs text-[color:var(--color-muted-foreground)]">
          {results.totalCount} result{results.totalCount === 1 ? '' : 's'}
        </p>
      )}

      {results && (
        <div className="space-y-8">
          <Group title="Pursuits" hits={results.pursuits} />
          <Group title="Your contracts" hits={results.contracts} />
          <Group title="Past performance" hits={results.pastPerformance} />
          <Group title="Content library" hits={results.library} />
          <Group title="Active opportunities" hits={results.opportunities} />
        </div>
      )}
    </div>
  );
}

function Group({ title, hits }: { title: string; hits: SearchHit[] }) {
  if (hits.length === 0) return null;
  return (
    <section>
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
        {title} ({hits.length})
      </h2>
      <div className="space-y-2">
        {hits.map((h) => {
          const isExternal = h.href.startsWith('http');
          const body = (
            <>
              <div className="flex items-baseline gap-2">
                <span className="rounded-full bg-[color:var(--color-muted)]/60 px-2 py-0.5 text-[10px] uppercase tracking-wide">
                  {KIND_LABEL[h.kind]}
                </span>
                <p className="text-sm font-medium">{h.title}</p>
              </div>
              {h.subtitle && (
                <p className="mt-0.5 text-xs text-[color:var(--color-muted-foreground)]">
                  {h.subtitle}
                </p>
              )}
              {h.meta && (
                <p className="mt-1 line-clamp-2 text-xs text-[color:var(--color-muted-foreground)]/80">
                  {h.meta}
                </p>
              )}
              <p className="mt-1 text-[11px] text-[color:var(--color-muted-foreground)]">
                Updated {formatDate(h.updatedAt)}
              </p>
            </>
          );
          const className =
            'block rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4 transition hover:border-[color:var(--color-foreground)]';
          return isExternal ? (
            <a key={h.id} href={h.href} target="_blank" rel="noopener noreferrer" className={className}>
              {body}
            </a>
          ) : (
            <Link key={h.id} href={h.href} className={className}>
              {body}
            </Link>
          );
        })}
      </div>
    </section>
  );
}
