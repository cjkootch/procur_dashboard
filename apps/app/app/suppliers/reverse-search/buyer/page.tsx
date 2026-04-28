import Link from 'next/link';
import { getBuyerAwardHistory, getBuyerStats } from '@procur/catalog';

/**
 * Buyer drill-down — full award history for a single buyer reached
 * by clicking through from the reverse-search results table.
 *
 * Buyers don't have stable IDs in our schema (we identify them by
 * the composite (buyer_name, buyer_country)), so the URL uses query
 * params instead of a dynamic [id] segment.
 *
 * Server component. Auth via apps/app/middleware.ts.
 */
export const dynamic = 'force-dynamic';

interface Props {
  searchParams: Promise<{
    name?: string;
    country?: string;
    category?: string;
    years?: string;
  }>;
}

export default async function BuyerDrilldownPage({ searchParams }: Props) {
  const { name, country, category, years } = await searchParams;

  if (!name || !country) {
    return (
      <div className="mx-auto max-w-4xl px-6 py-10">
        <p className="text-sm text-red-700">
          Missing buyer parameters. Pass <code>?name=...&country=XX</code> in the URL.
        </p>
      </div>
    );
  }

  const yearsLookback = years ? Number.parseInt(years, 10) : undefined;
  const args = {
    buyerName: name,
    buyerCountry: country,
    categoryTag: category ?? undefined,
    yearsLookback,
  };

  const [stats, rows] = await Promise.all([
    getBuyerStats(args),
    getBuyerAwardHistory(args),
  ]);

  const fmtUsd = (n: number | null) =>
    n != null ? `$${Math.round(n).toLocaleString()}` : '—';
  const fmtNative = (n: number | null, cur: string | null) =>
    n != null ? `${Math.round(n).toLocaleString()} ${cur ?? ''}`.trim() : '—';

  const sortedCategories = Object.entries(stats.awardsByCategory).sort(
    (a, b) => b[1] - a[1],
  );

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <nav className="mb-4 text-sm text-[color:var(--color-muted-foreground)]">
        <Link
          href="/suppliers/reverse-search"
          className="hover:text-[color:var(--color-foreground)]"
        >
          ← Reverse search
        </Link>
      </nav>

      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">{name}</h1>
        <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">
          {country}
          {category && (
            <>
              {' · filtered by '}
              <span className="font-medium">{category}</span>{' '}
              <Link
                href={`/suppliers/reverse-search/buyer?name=${encodeURIComponent(
                  name,
                )}&country=${encodeURIComponent(country)}`}
                className="text-xs hover:underline"
              >
                clear
              </Link>
            </>
          )}
        </p>
      </header>

      <section className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="Total awards" value={stats.totalAwards.toLocaleString()} />
        <Stat label="Total $USD" value={fmtUsd(stats.totalValueUsd)} />
        <Stat label="First award" value={stats.firstAwardDate ?? '—'} />
        <Stat label="Most recent" value={stats.mostRecentAwardDate ?? '—'} />
      </section>

      {stats.topSupplier && (
        <p className="mb-4 text-sm">
          Top supplier:{' '}
          <Link
            href={`/suppliers/${stats.topSupplier.supplierId}`}
            className="font-medium hover:underline"
          >
            {stats.topSupplier.supplierName}
          </Link>{' '}
          <span className="text-[color:var(--color-muted-foreground)]">
            ({stats.topSupplier.awardsCount} awards)
          </span>
        </p>
      )}

      {sortedCategories.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Awards by category
          </h2>
          <div className="flex flex-wrap gap-2">
            {sortedCategories.map(([tag, n]) => (
              <Link
                key={tag}
                href={`/suppliers/reverse-search/buyer?name=${encodeURIComponent(
                  name,
                )}&country=${encodeURIComponent(country)}&category=${encodeURIComponent(tag)}`}
                className={`rounded-[var(--radius-sm)] border px-2 py-1 text-xs hover:border-[color:var(--color-foreground)] ${
                  category === tag
                    ? 'border-[color:var(--color-foreground)] bg-[color:var(--color-muted)]/40'
                    : 'border-[color:var(--color-border)]'
                }`}
              >
                {tag} <span className="font-semibold">×{n}</span>
              </Link>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
          Award history{rows.length === 200 && ' (capped at 200 most recent)'}
        </h2>
        {rows.length === 0 ? (
          <div className="rounded-[var(--radius-lg)] border border-dashed border-[color:var(--color-border)] p-8 text-center text-sm text-[color:var(--color-muted-foreground)]">
            No awards in the lookback window. Try widening it via{' '}
            <code>?years=20</code> in the URL.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-[var(--radius-lg)] border border-[color:var(--color-border)]">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-[color:var(--color-border)] bg-[color:var(--color-muted)]/30">
                <tr>
                  <Th>Date</Th>
                  <Th>Title / commodity</Th>
                  <Th>Categories</Th>
                  <Th>Supplier</Th>
                  <Th>Value</Th>
                  <Th>$USD</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.awardId}
                    className="border-b border-[color:var(--color-border)] last:border-b-0"
                  >
                    <Td>{r.awardDate}</Td>
                    <Td className="max-w-md truncate" title={r.title ?? r.commodityDescription ?? ''}>
                      {r.sourceUrl ? (
                        <a
                          href={r.sourceUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="hover:underline"
                        >
                          {r.title ?? r.commodityDescription ?? '—'}
                        </a>
                      ) : (
                        r.title ?? r.commodityDescription ?? '—'
                      )}
                    </Td>
                    <Td className="max-w-xs">
                      <div className="flex flex-wrap gap-1">
                        {r.categoryTags.slice(0, 3).map((tag) => (
                          <span
                            key={tag}
                            className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-1.5 py-0.5 text-xs"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    </Td>
                    <Td className="max-w-xs truncate">
                      <Link
                        href={`/suppliers/${r.supplierId}`}
                        className="hover:underline"
                        title={r.supplierName}
                      >
                        {r.supplierName}
                      </Link>
                    </Td>
                    <Td className="tabular-nums">
                      {fmtNative(r.contractValueNative, r.contractCurrency)}
                    </Td>
                    <Td className="tabular-nums">{fmtUsd(r.contractValueUsd)}</Td>
                    <Td>
                      <span
                        className={
                          r.status === 'active'
                            ? ''
                            : 'text-[color:var(--color-muted-foreground)]'
                        }
                      >
                        {r.status}
                      </span>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

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
