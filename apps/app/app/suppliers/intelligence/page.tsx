import Link from 'next/link';
import {
  getMonthlyAwardsVolume,
  getNewBuyers,
  getTopBuyersByCategory,
  getTopSuppliersByCategory,
} from '@procur/catalog';

/**
 * Continuous-intelligence dashboard for the supplier-graph data.
 * Shifts the workflow from "remember to run a search" to "see what's
 * changing in the categories you trade".
 *
 * Server component. Auth via apps/app/middleware.ts.
 *
 * URL params drive filters (server-side, no client state):
 *   ?category=diesel|gasoline|jet-fuel|...|food-commodities|all
 *   ?country=ISO-2 (e.g. DO, JM)
 *   ?months=12 (lookback)
 */
export const dynamic = 'force-dynamic';

const CATEGORY_OPTIONS = [
  'all',
  'crude-oil',
  'diesel',
  'gasoline',
  'jet-fuel',
  'lpg',
  'marine-bunker',
  'heating-oil',
  'heavy-fuel-oil',
  'food-commodities',
  'vehicles',
  'minerals-metals',
] as const;

interface Props {
  searchParams: Promise<{ category?: string; country?: string; months?: string }>;
}

export default async function IntelligencePage({ searchParams }: Props) {
  const { category, country, months } = await searchParams;
  const categoryTag = category ?? 'diesel';
  const buyerCountry = country?.trim() || undefined;
  const monthsLookback = months ? Number.parseInt(months, 10) : 12;

  const filters = { categoryTag, buyerCountry, monthsLookback };

  const [topBuyers, topSuppliers, monthly, newBuyers] = await Promise.all([
    getTopBuyersByCategory(filters, 10),
    getTopSuppliersByCategory(filters, 10),
    getMonthlyAwardsVolume(filters),
    getNewBuyers(filters, 90, 15),
  ]);

  const fmtUsd = (n: number | null) =>
    n != null ? `$${Math.round(n).toLocaleString()}` : '—';

  const maxMonthly = monthly.reduce((m, b) => Math.max(m, b.awardsCount), 0) || 1;

  const baseHref = (override: Partial<{ category: string; country: string; months: string }>) => {
    const next = new URLSearchParams();
    next.set('category', override.category ?? categoryTag);
    if (override.country ?? buyerCountry) next.set('country', override.country ?? buyerCountry!);
    next.set('months', String(override.months ?? monthsLookback));
    return `/suppliers/intelligence?${next.toString()}`;
  };

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <nav className="mb-4 text-sm text-[color:var(--color-muted-foreground)]">
        <Link href="/suppliers/reverse-search" className="hover:text-[color:var(--color-foreground)]">
          ← Reverse search
        </Link>
        {' · '}
        <Link
          href="/suppliers/intelligence/tool-calls"
          className="hover:text-[color:var(--color-foreground)]"
        >
          Tool-call analytics →
        </Link>
      </nav>

      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Supplier-graph intelligence</h1>
        <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">
          Top buyers + suppliers, monthly volume, and new buyers for{' '}
          <span className="font-medium">{categoryTag}</span>
          {buyerCountry && (
            <>
              {' in '}
              <span className="font-medium">{buyerCountry}</span>
            </>
          )}
          {' over the last '}
          <span className="font-medium">{monthsLookback} months</span>.
        </p>
      </header>

      <section className="mb-6">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-[color:var(--color-muted-foreground)]">Category:</span>
          {CATEGORY_OPTIONS.map((c) => (
            <Link
              key={c}
              href={baseHref({ category: c })}
              className={`rounded-[var(--radius-sm)] border px-2 py-1 hover:border-[color:var(--color-foreground)] ${
                categoryTag === c
                  ? 'border-[color:var(--color-foreground)] bg-[color:var(--color-muted)]/40'
                  : 'border-[color:var(--color-border)]'
              }`}
            >
              {c}
            </Link>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-[color:var(--color-muted-foreground)]">Window:</span>
          {[3, 6, 12, 24, 36].map((m) => (
            <Link
              key={m}
              href={baseHref({ months: String(m) })}
              className={`rounded-[var(--radius-sm)] border px-2 py-1 hover:border-[color:var(--color-foreground)] ${
                monthsLookback === m
                  ? 'border-[color:var(--color-foreground)] bg-[color:var(--color-muted)]/40'
                  : 'border-[color:var(--color-border)]'
              }`}
            >
              {m}m
            </Link>
          ))}
          {buyerCountry && (
            <Link
              href={`/suppliers/intelligence?category=${encodeURIComponent(
                categoryTag,
              )}&months=${monthsLookback}`}
              className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1 hover:border-[color:var(--color-foreground)]"
            >
              Clear country filter ({buyerCountry})
            </Link>
          )}
        </div>
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
          Monthly awards volume
        </h2>
        {monthly.every((b) => b.awardsCount === 0) ? (
          <div className="rounded-[var(--radius-lg)] border border-dashed border-[color:var(--color-border)] p-6 text-center text-sm text-[color:var(--color-muted-foreground)]">
            No awards in this window. Try a different category or widen the window.
          </div>
        ) : (
          <div className="rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4">
            <div className="flex h-32 items-end gap-1">
              {monthly.map((b) => (
                <div
                  key={b.month}
                  className="flex flex-1 flex-col items-center justify-end gap-1"
                  title={`${b.month}: ${b.awardsCount} awards · ${fmtUsd(b.totalValueUsd)}`}
                >
                  <div
                    className="w-full rounded-sm bg-[color:var(--color-foreground)]/80"
                    style={{ height: `${(b.awardsCount / maxMonthly) * 100}%` }}
                  />
                  <span className="text-[10px] text-[color:var(--color-muted-foreground)]">
                    {b.month.slice(5)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      <section className="mb-8 grid gap-6 md:grid-cols-2">
        <div>
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Top buyers
          </h2>
          {topBuyers.length === 0 ? (
            <p className="text-sm text-[color:var(--color-muted-foreground)]">No data.</p>
          ) : (
            <ol className="space-y-1.5 text-sm">
              {topBuyers.map((b, i) => (
                <li
                  key={`${b.buyerName}-${b.buyerCountry}`}
                  className="flex items-baseline justify-between gap-3"
                >
                  <span className="truncate" title={b.buyerName}>
                    <span className="text-[color:var(--color-muted-foreground)]">
                      {String(i + 1).padStart(2, '0')}.{' '}
                    </span>
                    <Link
                      href={`/suppliers/reverse-search/buyer?name=${encodeURIComponent(
                        b.buyerName,
                      )}&country=${encodeURIComponent(b.buyerCountry)}${
                        categoryTag !== 'all' ? `&category=${encodeURIComponent(categoryTag)}` : ''
                      }`}
                      className="hover:underline"
                    >
                      {b.buyerName}
                    </Link>{' '}
                    <span className="text-[color:var(--color-muted-foreground)]">{b.buyerCountry}</span>
                  </span>
                  <span className="shrink-0 text-[color:var(--color-muted-foreground)] tabular-nums">
                    {b.awardsCount} · {fmtUsd(b.totalValueUsd)}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
        <div>
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Top suppliers
          </h2>
          {topSuppliers.length === 0 ? (
            <p className="text-sm text-[color:var(--color-muted-foreground)]">No data.</p>
          ) : (
            <ol className="space-y-1.5 text-sm">
              {topSuppliers.map((s, i) => (
                <li
                  key={s.supplierId}
                  className="flex items-baseline justify-between gap-3"
                >
                  <span className="truncate" title={s.supplierName}>
                    <span className="text-[color:var(--color-muted-foreground)]">
                      {String(i + 1).padStart(2, '0')}.{' '}
                    </span>
                    <Link href={`/suppliers/${s.supplierId}`} className="hover:underline">
                      {s.supplierName}
                    </Link>{' '}
                    {s.country && (
                      <span className="text-[color:var(--color-muted-foreground)]">{s.country}</span>
                    )}
                  </span>
                  <span className="shrink-0 text-[color:var(--color-muted-foreground)] tabular-nums">
                    {s.awardsCount} · {fmtUsd(s.totalValueUsd)}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
          New buyers — active in last 90 days, not in the prior 90
        </h2>
        {newBuyers.length === 0 ? (
          <p className="text-sm text-[color:var(--color-muted-foreground)]">
            No new buyers in this window. Either the data is stable or the lookback is too narrow
            to surface a real change.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-[var(--radius-lg)] border border-[color:var(--color-border)]">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-[color:var(--color-border)] bg-[color:var(--color-muted)]/30">
                <tr>
                  <th className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
                    Buyer
                  </th>
                  <th className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
                    Country
                  </th>
                  <th className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
                    Awards (90d)
                  </th>
                  <th className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
                    First award
                  </th>
                </tr>
              </thead>
              <tbody>
                {newBuyers.map((b) => (
                  <tr
                    key={`${b.buyerName}-${b.buyerCountry}`}
                    className="border-b border-[color:var(--color-border)] last:border-b-0"
                  >
                    <td className="px-3 py-2">
                      <Link
                        href={`/suppliers/reverse-search/buyer?name=${encodeURIComponent(
                          b.buyerName,
                        )}&country=${encodeURIComponent(b.buyerCountry)}${
                          categoryTag !== 'all' ? `&category=${encodeURIComponent(categoryTag)}` : ''
                        }`}
                        className="hover:underline"
                      >
                        {b.buyerName}
                      </Link>
                    </td>
                    <td className="px-3 py-2">{b.buyerCountry}</td>
                    <td className="px-3 py-2 tabular-nums">{b.awardsCount}</td>
                    <td className="px-3 py-2">{b.firstAwardDate}</td>
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
