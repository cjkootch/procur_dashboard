import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getSupplierProfile } from '@procur/catalog';

/**
 * Supplier profile page — renders the analyzeSupplier output as a
 * full-screen view. Reached via:
 *   - the buyer-drilldown page (each award row links its supplier)
 *   - direct URL (post-merge: assistant tool responses can deep-link)
 *
 * Server component — calls the query directly. Auth is handled by
 * apps/app/middleware.ts (Clerk gates everything outside the public
 * route list).
 *
 * Disambiguation/not-found cases of analyzeSupplier shouldn't fire
 * here because the URL carries a UUID that we already resolved
 * elsewhere (clicking a supplier link from a buyer page = we have the
 * canonical id). If it does happen, fall through to notFound() so
 * the user sees the 404 instead of a half-rendered profile.
 */
export const dynamic = 'force-dynamic';

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ years?: string }>;
}

export default async function SupplierProfilePage({ params, searchParams }: Props) {
  const { id } = await params;
  const { years } = await searchParams;
  const yearsLookback = years ? Number.parseInt(years, 10) : undefined;

  const result = await getSupplierProfile(id, yearsLookback);

  if (result.kind !== 'profile') {
    notFound();
  }

  const { supplier, summary, topBuyers, recentAwards, signals } = result;
  const fmtUsd = (n: number | null) =>
    n != null ? `$${Math.round(n).toLocaleString()}` : '—';
  const sortedCategories = Object.entries(summary.awardsByCategory).sort(
    (a, b) => b[1] - a[1],
  );

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <nav className="mb-4 text-sm text-[color:var(--color-muted-foreground)]">
        <Link href="/suppliers/reverse-search" className="hover:text-[color:var(--color-foreground)]">
          ← Reverse search
        </Link>
      </nav>

      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">{supplier.canonicalName}</h1>
        <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">
          {supplier.country ?? 'Unknown country'}
          {supplier.aliases.length > 0 && (
            <>
              {' · '}
              <span title={supplier.aliases.join(' • ')}>
                Also known as: {supplier.aliases.slice(0, 3).join(' · ')}
                {supplier.aliases.length > 3 ? ` (+${supplier.aliases.length - 3})` : ''}
              </span>
            </>
          )}
        </p>
      </header>

      <section className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="Total awards" value={summary.totalAwards.toLocaleString()} />
        <Stat label="Total $USD" value={fmtUsd(summary.totalValueUsd)} />
        <Stat label="First award" value={summary.firstAwardDate ?? '—'} />
        <Stat label="Most recent" value={summary.mostRecentAwardDate ?? '—'} />
      </section>

      {sortedCategories.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Awards by category
          </h2>
          <div className="flex flex-wrap gap-2">
            {sortedCategories.map(([tag, n]) => (
              <span
                key={tag}
                className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1 text-xs"
              >
                {tag} <span className="font-semibold">×{n}</span>
              </span>
            ))}
          </div>
        </section>
      )}

      <section className="mb-6 grid gap-6 md:grid-cols-2">
        <div>
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Top buyers
          </h2>
          {topBuyers.length === 0 ? (
            <p className="text-sm text-[color:var(--color-muted-foreground)]">No buyer data.</p>
          ) : (
            <ol className="space-y-1 text-sm">
              {topBuyers.map((b) => (
                <li key={b.buyerName} className="flex justify-between gap-3">
                  <span className="truncate" title={b.buyerName}>{b.buyerName}</span>
                  <span className="shrink-0 text-[color:var(--color-muted-foreground)]">
                    {b.awardsCount} · {fmtUsd(b.totalValueUsd)}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
        <div>
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Geography
          </h2>
          <p className="text-sm">
            <span className="text-[color:var(--color-muted-foreground)]">Buyer countries: </span>
            {summary.buyerCountries.length > 0 ? summary.buyerCountries.join(', ') : '—'}
          </p>
          {summary.beneficiaryCountries.length > 0 && (
            <p className="mt-1 text-sm">
              <span className="text-[color:var(--color-muted-foreground)]">
                Beneficiary countries:{' '}
              </span>
              {summary.beneficiaryCountries.join(', ')}
            </p>
          )}
        </div>
      </section>

      {recentAwards.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Recent awards
          </h2>
          <div className="overflow-x-auto rounded-[var(--radius-lg)] border border-[color:var(--color-border)]">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-[color:var(--color-border)] bg-[color:var(--color-muted)]/30">
                <tr>
                  <Th>Date</Th>
                  <Th>Buyer</Th>
                  <Th>Country</Th>
                  <Th>Title</Th>
                  <Th>Value $USD</Th>
                </tr>
              </thead>
              <tbody>
                {recentAwards.map((a, i) => (
                  <tr
                    key={`${a.awardDate}-${a.buyerName}-${i}`}
                    className="border-b border-[color:var(--color-border)] last:border-b-0"
                  >
                    <Td>{a.awardDate}</Td>
                    <Td>
                      <Link
                        href={`/suppliers/reverse-search/buyer?name=${encodeURIComponent(
                          a.buyerName,
                        )}&country=${encodeURIComponent(a.buyerCountry)}`}
                        className="hover:underline"
                      >
                        {a.buyerName}
                      </Link>
                    </Td>
                    <Td>{a.buyerCountry}</Td>
                    <Td className="max-w-md truncate" title={a.title ?? ''}>
                      {a.title ?? '—'}
                    </Td>
                    <Td>{fmtUsd(a.contractValueUsd)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {signals.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Signals
          </h2>
          <ul className="space-y-1 text-sm">
            {signals.map((s, i) => (
              <li key={i}>
                <span className="font-medium">{s.signalType}</span>{' '}
                <span className="text-[color:var(--color-muted-foreground)]">{s.observedAt}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <footer className="mt-10 border-t border-[color:var(--color-border)] pt-4 text-xs text-[color:var(--color-muted-foreground)]">
        Aggregated from public-tender award data only. Private commercial flows are not represented.
      </footer>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4">
      <div className="text-xs uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
        {label}
      </div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
      {children}
    </th>
  );
}

function Td({
  children,
  className,
  title,
}: {
  children: React.ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <td className={`px-3 py-2 align-top ${className ?? ''}`} title={title}>
      {children}
    </td>
  );
}
