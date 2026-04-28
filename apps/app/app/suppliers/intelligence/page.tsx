import Link from 'next/link';
import {
  findCompetingSellers,
  getCommodityTicker,
  getMonthlyAvgDelta,
  getMonthlyAwardsVolume,
  getNewBuyers,
  getPriceDeltaHistogram,
  getTopBuyersByCategory,
  getTopSuppliersByCategory,
} from '@procur/catalog';
import { BarChart, type BarDatum } from './_components/BarChart';
import { LineChart, type LinePoint } from './_components/LineChart';

/**
 * Continuous-intelligence dashboard for the supplier-graph data
 * augmented with commodity prices + price-delta analytics.
 *
 * Server component. Auth via apps/app/middleware.ts.
 *
 * URL params:
 *   ?category=diesel|gasoline|jet-fuel|...|all
 *   ?country=ISO-2 (filters to that buyer country)
 *   ?months=3|6|12|24|36
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

const COUNTRY_QUICK_FILTERS = [
  { code: 'DO', label: 'Dominican Republic' },
  { code: 'JM', label: 'Jamaica' },
  { code: 'TT', label: 'Trinidad' },
  { code: 'BS', label: 'Bahamas' },
  { code: 'HT', label: 'Haiti' },
  { code: 'IT', label: 'Italy' },
  { code: 'ES', label: 'Spain' },
  { code: 'GR', label: 'Greece' },
  { code: 'TR', label: 'Türkiye' },
  { code: 'IN', label: 'India' },
];

/** Commodity series shown in the top-of-page ticker. */
const TICKER_SERIES = [
  { slug: 'brent', label: 'Brent', short: 'BRT' },
  { slug: 'wti', label: 'WTI', short: 'WTI' },
  { slug: 'nyh-diesel', label: 'NYH ULSD', short: 'ULSD' },
  { slug: 'nyh-gasoline', label: 'NYH RBOB', short: 'RBOB' },
  { slug: 'nyh-heating-oil', label: 'NYH No.2', short: 'HO' },
];

interface Props {
  searchParams: Promise<{ category?: string; country?: string; months?: string }>;
}

const REGION_NAMES = new Intl.DisplayNames(['en'], { type: 'region' });
function fmtCountry(iso2: string): string {
  try {
    return REGION_NAMES.of(iso2) ?? iso2;
  } catch {
    return iso2;
  }
}

const fmtUsd = (n: number | null) =>
  n != null ? `$${Math.round(n).toLocaleString()}` : '—';

export default async function IntelligencePage({ searchParams }: Props) {
  const { category, country, months } = await searchParams;
  const categoryTag = category ?? 'diesel';
  const buyerCountry = country?.trim() || undefined;
  const monthsLookback = months ? Number.parseInt(months, 10) : 12;

  const filters = { categoryTag, buyerCountry, monthsLookback };
  const competingArgs = {
    categoryTag,
    buyerCountries: buyerCountry ? [buyerCountry] : undefined,
    monthsLookback,
    dormantLookbackMonths: Math.max(monthsLookback * 3, 36),
    limit: 15,
  };
  const deltaFilters = {
    buyerCountry,
    categoryTag: categoryTag === 'all' ? undefined : categoryTag,
    monthsLookback,
    minConfidence: 0.6,
  };

  const [
    topBuyers,
    topSuppliers,
    monthly,
    newBuyers,
    competing,
    ticker,
    deltaHist,
    deltaMonthly,
  ] = await Promise.all([
    getTopBuyersByCategory(filters, 10),
    getTopSuppliersByCategory(filters, 10),
    getMonthlyAwardsVolume(filters),
    getNewBuyers(filters, 90, 15),
    categoryTag === 'all'
      ? Promise.resolve(null)
      : findCompetingSellers(competingArgs),
    getCommodityTicker(TICKER_SERIES.map((s) => s.slug)),
    getPriceDeltaHistogram({ ...deltaFilters, bucketUsd: 5, maxAbsUsd: 80 }),
    getMonthlyAvgDelta(deltaFilters),
  ]);

  const baseHref = (
    override: Partial<{ category: string; country: string | null; months: string }>,
  ) => {
    const next = new URLSearchParams();
    next.set('category', override.category ?? categoryTag);
    const c = override.country !== undefined ? override.country : buyerCountry;
    if (c) next.set('country', c);
    next.set('months', String(override.months ?? monthsLookback));
    return `/suppliers/intelligence?${next.toString()}`;
  };

  // Monthly volume chart data — values + tooltip.
  const monthlyData: BarDatum[] = monthly.map((b) => ({
    label: b.month.slice(2, 7), // YY-MM
    value: b.awardsCount,
    hint: `${b.awardsCount} awards · ${fmtUsd(b.totalValueUsd)}`,
  }));

  // Price-delta histogram — fill empty buckets between min and max
  // for a cleaner visualization.
  const histData: BarDatum[] = (() => {
    if (deltaHist.length === 0) return [];
    const bucket = 5;
    const minStart = Math.min(...deltaHist.map((b) => b.bucketStart));
    const maxStart = Math.max(...deltaHist.map((b) => b.bucketStart));
    const byStart = new Map(deltaHist.map((b) => [b.bucketStart, b]));
    const out: BarDatum[] = [];
    for (let s = minStart; s <= maxStart; s += bucket) {
      const b = byStart.get(s);
      const value = b?.awardsCount ?? 0;
      const sign = s >= 0 ? '+' : '';
      out.push({
        label: `${sign}${s}`,
        value,
        hint: `${value} awards · $${s} to $${s + bucket}/bbl over benchmark`,
        highlight: s <= 0 && s + bucket > 0, // around-zero bucket
      });
    }
    return out;
  })();

  // Avg-delta-over-time line chart.
  const deltaMonthlyData: LinePoint[] = deltaMonthly.map((m) => ({
    label: m.month.slice(2, 7),
    value: m.avgDeltaUsdPerBbl,
  }));

  return (
    <div className="mx-auto max-w-screen-2xl px-6 py-8">
      <nav className="mb-3 text-sm text-[color:var(--color-muted-foreground)]">
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
        {' · '}
        <Link
          href="/suppliers/known-entities"
          className="hover:text-[color:var(--color-foreground)]"
        >
          Known entities →
        </Link>
      </nav>

      <header className="mb-4">
        <h1 className="text-2xl font-semibold tracking-tight">Intelligence</h1>
        <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">
          Awards activity, pricing-vs-benchmark, and competitive landscape for{' '}
          <span className="font-medium">{categoryTag}</span>
          {buyerCountry && (
            <>
              {' in '}
              <span className="font-medium">{fmtCountry(buyerCountry)}</span>
            </>
          )}
          {' over the last '}
          <span className="font-medium">{monthsLookback} months</span>.
        </p>
      </header>

      {/* Commodity price ticker */}
      <section className="mb-6 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] bg-[color:var(--color-muted)]/20 px-4 py-3">
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2 text-sm">
          {TICKER_SERIES.map((s) => {
            const t = ticker.find((x) => x.seriesSlug === s.slug);
            const price = t?.latestPrice ?? null;
            const change = t?.pctChange30d ?? null;
            const unit = t?.unit ?? null;
            const priceLabel =
              price == null ? '—' : unit === 'usd-gal' ? `$${price.toFixed(3)}/gal` : `$${price.toFixed(2)}/bbl`;
            return (
              <div key={s.slug} className="flex items-baseline gap-2">
                <span className="text-[10px] uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
                  {s.label}
                </span>
                <span className="font-semibold tabular-nums">{priceLabel}</span>
                {change != null && (
                  <span
                    className={`text-xs tabular-nums ${
                      change >= 0
                        ? 'text-[color:var(--color-success)]'
                        : 'text-[color:var(--color-destructive)]'
                    }`}
                  >
                    {change >= 0 ? '+' : ''}
                    {change.toFixed(1)}%
                  </span>
                )}
                {t?.latestDate && (
                  <span className="text-[10px] text-[color:var(--color-muted-foreground)]">
                    {t.latestDate}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* Filters */}
      <section className="mb-6 space-y-2 text-xs">
        <div className="flex flex-wrap items-center gap-2">
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
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[color:var(--color-muted-foreground)]">Country:</span>
          <Link
            href={baseHref({ country: null })}
            className={`rounded-[var(--radius-sm)] border px-2 py-1 hover:border-[color:var(--color-foreground)] ${
              !buyerCountry
                ? 'border-[color:var(--color-foreground)] bg-[color:var(--color-muted)]/40'
                : 'border-[color:var(--color-border)]'
            }`}
          >
            all
          </Link>
          {COUNTRY_QUICK_FILTERS.map((c) => (
            <Link
              key={c.code}
              href={baseHref({ country: c.code })}
              title={c.label}
              className={`rounded-[var(--radius-sm)] border px-2 py-1 hover:border-[color:var(--color-foreground)] ${
                buyerCountry === c.code
                  ? 'border-[color:var(--color-foreground)] bg-[color:var(--color-muted)]/40'
                  : 'border-[color:var(--color-border)]'
              }`}
            >
              {c.code}
            </Link>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
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
        </div>
      </section>

      {/* Charts row: monthly volume + price-delta histogram + avg-delta line */}
      <section className="mb-8 grid gap-4 lg:grid-cols-2">
        <div>
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Monthly awards volume
          </h2>
          <BarChart
            data={monthlyData}
            yLabel="awards"
            emptyMessage="No awards in this window. Try a different category or widen the window."
          />
        </div>
        <div>
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Price delta over benchmark — distribution ($/bbl)
          </h2>
          <BarChart
            data={histData}
            yLabel="awards"
            emptyMessage="No priced awards in this window. Run backfill-award-quantities + REFRESH MATERIALIZED VIEW award_price_deltas to populate."
          />
        </div>
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
          Average per-bbl delta vs benchmark, monthly
        </h2>
        <LineChart
          points={deltaMonthlyData}
          yLabel="$/bbl over benchmark"
          formatY={(n) => `${n >= 0 ? '+' : ''}$${n.toFixed(1)}`}
          emptyMessage="Need at least 2 months of priced awards to draw a trend. Backfill quantities + refresh the MV first."
        />
      </section>

      {/* Competitive landscape */}
      {competing && (
        <section className="mb-8">
          <div className="mb-2 flex items-baseline justify-between gap-4">
            <h2 className="text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
              Competitive landscape — sell-side
            </h2>
            <span className="text-xs text-[color:var(--color-muted-foreground)]">
              {competing.marketStats.activeSellersCount} active sellers ·{' '}
              {competing.marketStats.totalAwardsInWindow} awards
            </span>
          </div>

          {(competing.marketStats.medianAwardValueUsd != null ||
            competing.marketStats.totalValueUsd != null) && (
            <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat
                label="Total $USD"
                value={fmtUsd(competing.marketStats.totalValueUsd)}
              />
              <Stat
                label="Median award $USD"
                value={fmtUsd(competing.marketStats.medianAwardValueUsd)}
              />
              <Stat
                label="p25 / p75 $USD"
                value={`${fmtUsd(competing.marketStats.p25AwardValueUsd)} / ${fmtUsd(
                  competing.marketStats.p75AwardValueUsd,
                )}`}
              />
              <Stat
                label="Active sellers"
                value={String(competing.marketStats.activeSellersCount)}
              />
            </div>
          )}

          <div className="grid gap-6 md:grid-cols-2">
            <div>
              <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
                Active ({monthsLookback}m)
              </h3>
              {competing.activeSellers.length === 0 ? (
                <p className="text-sm text-[color:var(--color-muted-foreground)]">
                  No active sellers in this window.
                </p>
              ) : (
                <ol className="space-y-1.5 text-sm">
                  {competing.activeSellers.map((s, i) => (
                    <li key={s.supplierId} className="flex items-baseline justify-between gap-3">
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
            <div>
              <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
                Dormant — capable but inactive recently
              </h3>
              {competing.dormantSellers.length === 0 ? (
                <p className="text-sm text-[color:var(--color-muted-foreground)]">
                  No dormant suppliers — every historical seller has won in the active window.
                </p>
              ) : (
                <ol className="space-y-1.5 text-sm">
                  {competing.dormantSellers.map((s, i) => (
                    <li key={s.supplierId} className="flex items-baseline justify-between gap-3">
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
                        {s.historicalAwardsCount} · last {s.mostRecentAwardDate}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </div>
          <p className="mt-2 text-xs text-[color:var(--color-muted-foreground)]">
            Dormant = won historically but no public awards in the active window. Capability +
            silence often signals receptiveness to back-to-back or off-take arrangements; a
            supplier may also still be active in private channels we can&apos;t see.
          </p>
        </section>
      )}

      {/* Top buyers + suppliers */}
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
                <li key={s.supplierId} className="flex items-baseline justify-between gap-3">
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

      {/* New buyers */}
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
        Aggregated from public-tender awards + commodity_prices + the award_price_deltas
        materialized view (refresh nightly to keep deltas current). Private commercial flows
        not represented; for cargo-level insight pair with /suppliers/known-entities + AIS port
        calls.
      </footer>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-3">
      <div className="text-[10px] uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
        {label}
      </div>
      <div className="mt-1 text-sm font-semibold tabular-nums">{value}</div>
    </div>
  );
}
