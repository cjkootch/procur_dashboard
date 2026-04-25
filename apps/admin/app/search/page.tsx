import Link from 'next/link';
import { AdminShell } from '../../components/shell/AdminShell';
import {
  searchEverything,
  type SearchHit,
  type SearchResults,
} from '../../lib/search-queries';

type SearchParams = { q?: string };

export default async function AdminSearchPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const q = (sp.q ?? '').trim();
  const results = await searchEverything(q);

  return (
    <AdminShell title="Search">
      <div className="mx-auto max-w-4xl px-8 py-10">
        <header className="mb-4">
          <h2 className="text-lg font-semibold">Cross-tenant search</h2>
          <p className="mt-0.5 text-xs text-[color:var(--color-muted-foreground)]">
            Find a tenant, user, pursuit, contract, or opportunity by name,
            id, email, slug, contract number, or Stripe / Clerk identifier.
          </p>
        </header>

        <form method="GET" className="mb-6 flex gap-2">
          <input
            name="q"
            defaultValue={q}
            autoFocus
            placeholder="Try: alice@example.com, ACME, evt_…, or a UUID"
            className="flex-1 rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-3 py-2 text-sm"
          />
          <button
            type="submit"
            className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-4 py-2 text-sm font-medium text-[color:var(--color-background)]"
          >
            Search
          </button>
        </form>

        {q.length === 0 ? (
          <p className="rounded-[var(--radius-md)] border border-dashed border-[color:var(--color-border)] p-8 text-center text-xs text-[color:var(--color-muted-foreground)]">
            Type a query above to begin. Searches all tables in parallel and
            caps each bucket at 10 hits.
          </p>
        ) : q.length < 2 ? (
          <p className="rounded-[var(--radius-md)] border border-dashed border-[color:var(--color-border)] p-8 text-center text-xs text-[color:var(--color-muted-foreground)]">
            Query too short. Use at least 2 characters.
          </p>
        ) : results.totalHits === 0 ? (
          <p className="rounded-[var(--radius-md)] border border-dashed border-[color:var(--color-border)] p-8 text-center text-xs text-[color:var(--color-muted-foreground)]">
            No matches for &ldquo;{q}&rdquo;.
          </p>
        ) : (
          <div className="space-y-6">
            <p className="text-xs text-[color:var(--color-muted-foreground)]">
              {results.totalHits} hits across {bucketCount(results)} categories.
            </p>
            <Bucket label="Tenants" bucket={results.companies} />
            <Bucket label="Users" bucket={results.users} />
            <Bucket label="Pursuits" bucket={results.pursuits} />
            <Bucket label="Contracts" bucket={results.contracts} />
            <Bucket label="Opportunities" bucket={results.opportunities} />
          </div>
        )}
      </div>
    </AdminShell>
  );
}

function bucketCount(r: SearchResults): number {
  let n = 0;
  if (r.companies.hits.length > 0) n += 1;
  if (r.users.hits.length > 0) n += 1;
  if (r.pursuits.hits.length > 0) n += 1;
  if (r.contracts.hits.length > 0) n += 1;
  if (r.opportunities.hits.length > 0) n += 1;
  return n;
}

function Bucket({
  label,
  bucket,
}: {
  label: string;
  bucket: { hits: SearchHit[]; truncated: boolean };
}) {
  if (bucket.hits.length === 0) return null;
  return (
    <section>
      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
        {label} ({bucket.hits.length}
        {bucket.truncated ? '+' : ''})
      </h3>
      <ul className="divide-y divide-[color:var(--color-border)] rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)]">
        {bucket.hits.map((h) => (
          <li key={`${h.kind}:${h.id}`}>
            <HitRow hit={h} />
          </li>
        ))}
      </ul>
      {bucket.truncated && (
        <p className="mt-1 text-[10px] text-[color:var(--color-muted-foreground)]">
          Showing first 10 — refine your query for more.
        </p>
      )}
    </section>
  );
}

function HitRow({ hit }: { hit: SearchHit }) {
  const inner = (
    <div className="flex items-baseline justify-between gap-3 px-4 py-2.5 text-sm">
      <div className="min-w-0">
        <p className="truncate font-medium">{hit.title}</p>
        {hit.subtitle && (
          <p className="truncate font-mono text-[10px] text-[color:var(--color-muted-foreground)]">
            {hit.subtitle}
          </p>
        )}
      </div>
      {hit.kind === 'pursuit' || hit.kind === 'contract' ? (
        <Link
          href={hit.tenantHref}
          className="shrink-0 text-[10px] text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)] hover:underline"
        >
          tenant →
        </Link>
      ) : null}
    </div>
  );
  if (hit.kind === 'opportunity') {
    // Opportunities aren't tenant-scoped — no admin page yet.
    return <div>{inner}</div>;
  }
  return (
    <Link
      href={hit.href}
      className="block transition hover:bg-[color:var(--color-muted)]/40"
    >
      {inner}
    </Link>
  );
}
