import Link from 'next/link';
import {
  findCompetingSellers,
  findRecentPortCalls,
  getAwardValueHistogram,
  getCommoditySpreadHistory,
  getCommodityTicker,
  getCountriesWithAwards,
  getDataFreshness,
  getIntelligenceKpis,
  getMarketConcentration,
  getMonthlyAvgAwardValue,
  getMonthlyAwardsVolume,
  getNewBuyers,
  getRolodexCoverage,
  getSupplierBuyerMatrix,
  getTopBuyersByCategory,
  getTopImportersByPartner,
  getTopSourcesForReporter,
  getTopSuppliersByCategory,
} from '@procur/catalog';
import { BarChart, type BarDatum } from './_components/BarChart';
import { CountryPicker } from './_components/CountryPicker';
import { Heatmap } from './_components/Heatmap';
import { LineChart, type LinePoint } from './_components/LineChart';
import { MultiLineChart, type MultiLineSeries } from './_components/MultiLineChart';
import { Sparkline } from './_components/Sparkline';

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

/**
 * Internal taxonomy → HS code (6-digit where possible). Used to
 * pull customs-flow data for the selected category. When a category
 * doesn't map cleanly to an HS chapter, we just skip the customs
 * section.
 */
const CATEGORY_HS_CODES: Record<string, string> = {
  'crude-oil': '2709',
  diesel: '271019',
  gasoline: '271012',
  'jet-fuel': '271019',
  'heating-oil': '271019',
  'heavy-fuel-oil': '271019',
  'marine-bunker': '271019',
  lpg: '271111',
};

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

const fmtUsdShort = (n: number | null): string => {
  if (n == null) return '—';
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}k`;
  return `$${Math.round(n)}`;
};

function pctChange(current: number, prior: number): number | null {
  if (prior === 0) return null;
  return ((current - prior) / prior) * 100;
}

function formatRelativeTime(iso: string | null): string {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return 'just now';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 90) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

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
  const valueFilters = {
    buyerCountry,
    categoryTag: categoryTag === 'all' ? undefined : categoryTag,
    monthsLookback,
  };

  // Customs-flow product code for the selected category (skips when
  // the category doesn't map to an HS code we recognize).
  const productCode = CATEGORY_HS_CODES[categoryTag];

  /**
   * Run a query, returning fallback if it throws. Keeps the dashboard
   * rendering when one section's data source is missing or the query
   * has an issue — section shows its own empty-state instead of the
   * whole page erroring.
   */
  async function safe<T>(p: Promise<T>, fallback: T, label: string): Promise<T> {
    try {
      return await p;
    } catch (err) {
      console.error(`[intelligence] ${label} failed:`, err);
      return fallback;
    }
  }

  const [
    topBuyers,
    topSuppliers,
    monthly,
    newBuyers,
    competing,
    ticker,
    valueHist,
    avgAwardMonthly,
    customsImports,
    customsExports,
    spreadHistory,
    concentration,
    portCalls,
    seasonalityVolume,
    supplierBuyerMatrix,
    rolodexCoverage,
    kpis,
    countriesWithAwards,
    freshness,
  ] = await Promise.all([
    safe(getTopBuyersByCategory(filters, 10), [], 'top-buyers'),
    safe(getTopSuppliersByCategory(filters, 10), [], 'top-suppliers'),
    safe(getMonthlyAwardsVolume(filters), [], 'monthly-volume'),
    safe(getNewBuyers(filters, 90, 15), [], 'new-buyers'),
    categoryTag === 'all'
      ? Promise.resolve(null)
      : safe(findCompetingSellers(competingArgs), null, 'competing-sellers'),
    safe(getCommodityTicker(TICKER_SERIES.map((s) => s.slug)), [], 'ticker'),
    safe(getAwardValueHistogram(valueFilters), [], 'value-hist'),
    safe(getMonthlyAvgAwardValue(valueFilters), [], 'monthly-avg-value'),
    buyerCountry && productCode
      ? safe(
          getTopSourcesForReporter(
            { reporterCountry: buyerCountry, productCode, monthsLookback },
            10,
          ),
          [],
          'customs-sources',
        )
      : Promise.resolve([]),
    buyerCountry && productCode
      ? safe(
          getTopImportersByPartner(
            { partnerCountry: buyerCountry, productCode, monthsLookback },
            10,
          ),
          [],
          'customs-destinations',
        )
      : Promise.resolve([]),
    safe(
      getCommoditySpreadHistory('brent', 'wti', monthsLookback),
      [],
      'spread-history',
    ),
    safe(
      getMarketConcentration(valueFilters),
      {
        buyerHhi: null,
        supplierHhi: null,
        top3BuyerSharePct: null,
        top3SupplierSharePct: null,
        totalValueUsd: null,
        buyerCount: 0,
        supplierCount: 0,
      },
      'concentration',
    ),
    buyerCountry
      ? safe(
          findRecentPortCalls({ country: buyerCountry, daysBack: 30, limit: 200 }),
          [],
          'port-calls',
        )
      : Promise.resolve([]),
    // 36-month seasonality: pull a wider window than the user picked
    // so we can split into year-overlay lines regardless of the main
    // window setting.
    safe(
      getMonthlyAwardsVolume({
        ...filters,
        monthsLookback: Math.max(monthsLookback, 36),
      }),
      [],
      'seasonality-volume',
    ),
    safe(
      getSupplierBuyerMatrix({
        categoryTag: categoryTag === 'all' ? undefined : categoryTag,
        monthsLookback,
        topSuppliers: 10,
        topBuyerCountries: 10,
      }),
      { suppliers: [], buyerCountries: [], cells: [] },
      'supplier-buyer-matrix',
    ),
    buyerCountry
      ? safe(
          getRolodexCoverage(buyerCountry),
          { total: 0, byRole: {}, withCoords: 0, withSlate: 0 },
          'rolodex-coverage',
        )
      : Promise.resolve(null),
    safe(
      getIntelligenceKpis(valueFilters),
      {
        awardsCurrent: 0,
        awardsPrior: 0,
        totalUsdCurrent: null,
        totalUsdPrior: null,
        uniqueBuyers: 0,
        uniqueSuppliers: 0,
        topBuyerName: null,
        topBuyerSharePct: null,
      },
      'kpis',
    ),
    safe(
      getCountriesWithAwards({
        categoryTag: categoryTag === 'all' ? undefined : categoryTag,
        monthsLookback: Math.max(monthsLookback, 36),
      }),
      [],
      'countries-with-awards',
    ),
    safe(
      getDataFreshness(),
      {
        awards: { latest: null, count: 0 },
        commodityPrices: { latest: null, count: 0 },
        vesselPositions: { latest: null, count: 0 },
        customsImports: { latest: null, count: 0 },
      },
      'freshness',
    ),
  ]);

  // Aggregate port calls into per-port distinct-vessel counts.
  type PortAgg = {
    portSlug: string;
    portName: string;
    portCountry: string;
    portType: string;
    vesselCount: number;
    lastCallAt: string;
  };
  const portAgg: PortAgg[] = (() => {
    const byPort = new Map<string, PortAgg>();
    const seen = new Map<string, Set<string>>();
    for (const c of portCalls) {
      const slug = c.portSlug;
      if (!seen.has(slug)) seen.set(slug, new Set());
      seen.get(slug)!.add(c.mmsi);
      const existing = byPort.get(slug);
      if (!existing) {
        byPort.set(slug, {
          portSlug: c.portSlug,
          portName: c.portName,
          portCountry: c.portCountry,
          portType: c.portType,
          vesselCount: 0,
          lastCallAt: c.lastSeenAt,
        });
      } else if (c.lastSeenAt > existing.lastCallAt) {
        existing.lastCallAt = c.lastSeenAt;
      }
    }
    for (const [slug, agg] of byPort) {
      agg.vesselCount = seen.get(slug)!.size;
    }
    return [...byPort.values()].sort((a, b) =>
      a.lastCallAt < b.lastCallAt ? 1 : -1,
    );
  })();

  // Seasonality: split monthly volume into year buckets, each
  // containing a 12-element array indexed by month-of-year (0-11).
  const seasonalityYears = (() => {
    const byYear = new Map<number, Array<number | null>>();
    for (const r of seasonalityVolume) {
      const [yyyy, mm] = r.month.split('-');
      if (!yyyy || !mm) continue;
      const y = Number.parseInt(yyyy, 10);
      const m = Number.parseInt(mm, 10) - 1;
      if (!byYear.has(y)) byYear.set(y, Array(12).fill(null));
      byYear.get(y)![m] = r.awardsCount;
    }
    return [...byYear.entries()].sort((a, b) => a[0] - b[0]);
  })();
  const currentYear = new Date().getFullYear();
  const seasonalitySeries: MultiLineSeries[] = seasonalityYears.map(
    ([year, values]) => ({
      label: String(year),
      values,
      emphasized: year === currentYear,
    }),
  );
  const monthLabels = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // Supplier × buyer-country matrix → Heatmap input.
  const matrixCells = new Map<string, Map<string, number>>();
  for (const c of supplierBuyerMatrix.cells) {
    if (!matrixCells.has(c.supplierId)) matrixCells.set(c.supplierId, new Map());
    matrixCells.get(c.supplierId)!.set(c.buyerCountry, c.awardCount);
  }

  const hhiLabel = (h: number | null) => {
    if (h == null) return '—';
    if (h < 1500) return `${Math.round(h)} (unconcentrated)`;
    if (h < 2500) return `${Math.round(h)} (moderately concentrated)`;
    return `${Math.round(h)} (highly concentrated)`;
  };
  const fmtPct = (n: number | null) => (n == null ? '—' : `${n.toFixed(1)}%`);

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

  // Award-value histogram — log-bucketed contract_value_usd. Replaces
  // the per-bbl delta histogram (which depended on quantity extraction
  // that mostly returned null for our corpus).
  const histData: BarDatum[] = valueHist.map((b) => ({
    label: b.bucketLabel,
    value: b.awardsCount,
    hint: `${b.awardsCount} awards`,
  }));

  // Monthly average + median award value (USD), log-scale-friendly via
  // formatY. Replaces the per-bbl delta line.
  const avgAwardData: LinePoint[] = avgAwardMonthly.map((m) => ({
    label: m.month.slice(2, 7),
    value: m.avgValueUsd,
  }));
  const medianAwardData: LinePoint[] = avgAwardMonthly.map((m) => ({
    label: m.month.slice(2, 7),
    value: m.medianValueUsd,
  }));

  // Brent–WTI spread series (downsample to weekly to keep the line
  // chart readable when the window spans 2-3 years of daily data).
  const spreadStride = Math.max(1, Math.floor(spreadHistory.length / 60));
  const spreadData: LinePoint[] = spreadHistory
    .filter((_, i) => i % spreadStride === 0)
    .map((p) => ({ label: p.priceDate.slice(2, 7), value: p.spread }));
  const latestSpread = spreadHistory.length
    ? spreadHistory[spreadHistory.length - 1]!
    : null;

  return (
    <div className="-mx-6 -my-10 min-h-screen bg-[color:var(--color-muted)]/40 px-6 py-8 sm:-mx-8 sm:px-8">
    <div className="mx-auto max-w-screen-2xl">
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

      {/* Data freshness strip */}
      <section className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-[color:var(--color-muted-foreground)]">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
          <span className="font-medium uppercase tracking-wider">Live</span>
        </span>
        <span>
          Awards: {formatRelativeTime(freshness.awards.latest)}{' '}
          <span className="opacity-60">({freshness.awards.count.toLocaleString()})</span>
        </span>
        <span>
          Prices: {formatRelativeTime(freshness.commodityPrices.latest)}{' '}
          <span className="opacity-60">({freshness.commodityPrices.count.toLocaleString()})</span>
        </span>
        <span>
          AIS: {formatRelativeTime(freshness.vesselPositions.latest)}{' '}
          <span className="opacity-60">({freshness.vesselPositions.count.toLocaleString()})</span>
        </span>
        <span>
          Customs: {formatRelativeTime(freshness.customsImports.latest)}{' '}
          <span className="opacity-60">({freshness.customsImports.count.toLocaleString()})</span>
        </span>
      </section>

      {/* KPI cards — current period vs prior */}
      <section className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        {(() => {
          const dAwards = pctChange(kpis.awardsCurrent, kpis.awardsPrior);
          const dUsd =
            kpis.totalUsdCurrent != null && kpis.totalUsdPrior != null
              ? pctChange(kpis.totalUsdCurrent, kpis.totalUsdPrior)
              : null;
          const cards: Array<{
            label: string;
            value: string;
            delta: number | null;
            sub?: string;
          }> = [
            {
              label: `Awards (${monthsLookback}m)`,
              value: kpis.awardsCurrent.toLocaleString(),
              delta: dAwards,
              sub: `prior ${monthsLookback}m: ${kpis.awardsPrior.toLocaleString()}`,
            },
            {
              label: `Total $USD (${monthsLookback}m)`,
              value: fmtUsdShort(kpis.totalUsdCurrent),
              delta: dUsd,
              sub: `prior: ${fmtUsdShort(kpis.totalUsdPrior)}`,
            },
            {
              label: 'Unique buyers / suppliers',
              value: `${kpis.uniqueBuyers.toLocaleString()} / ${kpis.uniqueSuppliers.toLocaleString()}`,
              delta: null,
            },
            {
              label: 'Top buyer share',
              value:
                kpis.topBuyerSharePct != null
                  ? `${kpis.topBuyerSharePct.toFixed(1)}%`
                  : '—',
              delta: null,
              sub: kpis.topBuyerName
                ? kpis.topBuyerName.length > 32
                  ? `${kpis.topBuyerName.slice(0, 32)}…`
                  : kpis.topBuyerName
                : undefined,
            },
          ];
          return cards.map((c, i) => (
            <div
              key={i}
              className="rounded-[var(--radius-lg)] border border-[color:var(--color-border)] bg-[color:var(--color-card,white)] p-4 shadow-sm dark:bg-[color:var(--color-card,#0a0a0a)]"
              style={{ background: 'var(--color-card, var(--color-background))' }}
            >
              <div className="text-[10px] font-medium uppercase tracking-widest text-[color:var(--color-muted-foreground)]">
                {c.label}
              </div>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="text-2xl font-semibold tabular-nums leading-none">
                  {c.value}
                </span>
                {c.delta != null && (
                  <span
                    className={`text-xs tabular-nums ${
                      c.delta >= 0
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : 'text-rose-600 dark:text-rose-400'
                    }`}
                  >
                    {c.delta >= 0 ? '▲' : '▼'} {Math.abs(c.delta).toFixed(1)}%
                  </span>
                )}
              </div>
              {c.sub && (
                <div className="mt-1 truncate text-[11px] text-[color:var(--color-muted-foreground)]">
                  {c.sub}
                </div>
              )}
            </div>
          ));
        })()}
      </section>

      {/* Commodity price ticker */}
      <section className="mb-6 overflow-hidden rounded-[var(--radius-lg)] border border-[color:var(--color-border)] bg-gradient-to-b from-[color:var(--color-muted)]/30 to-transparent">
        <div className="grid grid-cols-2 divide-x divide-y divide-[color:var(--color-border)] sm:grid-cols-3 lg:grid-cols-5">
          {TICKER_SERIES.map((s) => {
            const t = ticker.find((x) => x.seriesSlug === s.slug);
            const price = t?.latestPrice ?? null;
            const change = t?.pctChange30d ?? null;
            const unit = t?.unit ?? null;
            const priceLabel =
              price == null
                ? '—'
                : unit === 'usd-gal'
                  ? `$${price.toFixed(3)}`
                  : `$${price.toFixed(2)}`;
            const unitLabel = price == null ? '' : unit === 'usd-gal' ? '/gal' : '/bbl';
            const changeColor =
              change == null
                ? 'text-[color:var(--color-muted-foreground)]'
                : change >= 0
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : 'text-rose-600 dark:text-rose-400';
            return (
              <div
                key={s.slug}
                className="px-4 py-3 transition-colors hover:bg-[color:var(--color-muted)]/40"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10px] font-medium uppercase tracking-widest text-[color:var(--color-muted-foreground)]">
                    {s.label}
                  </span>
                  {t?.spark && t.spark.length >= 2 && <Sparkline values={t.spark} />}
                </div>
                <div className="mt-1 flex items-baseline gap-1">
                  <span className="text-lg font-semibold tabular-nums leading-none">
                    {priceLabel}
                  </span>
                  <span className="text-[11px] text-[color:var(--color-muted-foreground)]">
                    {unitLabel}
                  </span>
                </div>
                <div className="mt-0.5 flex items-baseline gap-2 text-[11px]">
                  <span className={`tabular-nums ${changeColor}`}>
                    {change == null
                      ? '—'
                      : `${change >= 0 ? '▲' : '▼'} ${Math.abs(change).toFixed(1)}%`}
                  </span>
                  {t?.latestDate && (
                    <span className="text-[10px] text-[color:var(--color-muted-foreground)]">
                      {t.latestDate}
                    </span>
                  )}
                </div>
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
          <CountryPicker
            countries={countriesWithAwards}
            selected={buyerCountry}
            buildHref={(c) => baseHref({ country: c })}
          />
          {/* Quick chips for the most-pitched countries — keeps the
              workflow fast for repeat filters without forcing the
              picker open every time. */}
          {['DO', 'JM', 'TT', 'IT', 'IN'].map((code) => (
            <Link
              key={code}
              href={baseHref({ country: code })}
              className={`rounded-[var(--radius-sm)] border px-2 py-1 hover:border-[color:var(--color-foreground)] ${
                buyerCountry === code
                  ? 'border-[color:var(--color-foreground)] bg-[color:var(--color-muted)]/40'
                  : 'border-[color:var(--color-border)]'
              }`}
            >
              {code}
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
            Award size distribution (contract value $USD)
          </h2>
          <BarChart
            data={histData}
            yLabel="awards"
            emptyMessage="No awards with USD values in this window."
          />
        </div>
      </section>

      <section className="mb-8 grid gap-4 lg:grid-cols-2">
        <div>
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Average award size, monthly
          </h2>
          <LineChart
            points={avgAwardData}
            yLabel="$USD"
            formatY={(n) =>
              n >= 1_000_000
                ? `$${(n / 1_000_000).toFixed(1)}M`
                : n >= 1_000
                  ? `$${(n / 1_000).toFixed(0)}k`
                  : `$${n.toFixed(0)}`
            }
            emptyMessage="Need at least 2 months of priced awards."
          />
        </div>
        <div>
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Median award size, monthly
          </h2>
          <LineChart
            points={medianAwardData}
            yLabel="$USD"
            formatY={(n) =>
              n >= 1_000_000
                ? `$${(n / 1_000_000).toFixed(1)}M`
                : n >= 1_000
                  ? `$${(n / 1_000).toFixed(0)}k`
                  : `$${n.toFixed(0)}`
            }
            emptyMessage="Need at least 2 months of priced awards."
          />
        </div>
      </section>

      {/* Year-over-year seasonality */}
      <section className="mb-8">
        <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
          Year-over-year seasonality — monthly award count by year
        </h2>
        <MultiLineChart
          xLabels={monthLabels}
          series={seasonalitySeries}
          yLabel="awards"
          formatY={(n) => Math.round(n).toLocaleString()}
          emptyMessage="Need 2+ years of data to show seasonality."
        />
      </section>

      {/* Rolodex coverage — only when country filter is set */}
      {buyerCountry && rolodexCoverage && (
        <section className="mb-8">
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Rolodex coverage — {fmtCountry(buyerCountry)}
          </h2>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-6">
            <Stat label="Total entities" value={String(rolodexCoverage.total)} />
            <Stat
              label="With coordinates"
              value={`${rolodexCoverage.withCoords} / ${rolodexCoverage.total}`}
            />
            <Stat
              label="With slate metadata"
              value={`${rolodexCoverage.withSlate} / ${rolodexCoverage.total}`}
            />
            {Object.entries(rolodexCoverage.byRole)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 3)
              .map(([role, n]) => (
                <Stat key={role} label={role} value={String(n)} />
              ))}
          </div>
          <p className="mt-2 text-xs text-[color:var(--color-muted-foreground)]">
            Curated rolodex depth for this country. Higher counts +
            slate-metadata coverage = more reliable downstream queries
            (refinery compatibility, port-call attribution).
          </p>
        </section>
      )}

      {/* Market concentration (HHI) */}
      <section className="mb-8">
        <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
          Market concentration ({monthsLookback}m)
        </h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat
            label={`Buyer HHI (${concentration.buyerCount} buyers)`}
            value={hhiLabel(concentration.buyerHhi)}
          />
          <Stat
            label="Top 3 buyers"
            value={fmtPct(concentration.top3BuyerSharePct)}
          />
          <Stat
            label={`Supplier HHI (${concentration.supplierCount} suppliers)`}
            value={hhiLabel(concentration.supplierHhi)}
          />
          <Stat
            label="Top 3 suppliers"
            value={fmtPct(concentration.top3SupplierSharePct)}
          />
        </div>
        <p className="mt-2 text-xs text-[color:var(--color-muted-foreground)]">
          Herfindahl-Hirschman Index = Σ(share%)². Reads:{' '}
          <span className="font-medium">&lt;1500</span> unconcentrated ·{' '}
          <span className="font-medium">1500–2500</span> moderate ·{' '}
          <span className="font-medium">≥2500</span> highly concentrated.
        </p>
      </section>

      {/* Active tanker activity at country ports — only when country filter is set */}
      {buyerCountry && (
        <section className="mb-8">
          <div className="mb-2 flex items-baseline justify-between gap-4">
            <h2 className="text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
              Recent tanker calls — {fmtCountry(buyerCountry)} (last 30d)
            </h2>
            <span className="text-xs text-[color:var(--color-muted-foreground)]">
              {portAgg.reduce((s, p) => s + p.vesselCount, 0)} distinct vessels
              across {portAgg.length} ports
            </span>
          </div>
          {portAgg.length === 0 ? (
            <p className="rounded-[var(--radius-lg)] border border-dashed border-[color:var(--color-border)] p-4 text-sm text-[color:var(--color-muted-foreground)]">
              No port-call activity for {fmtCountry(buyerCountry)} in the last 30 days.
              Either AISStream hasn&apos;t run recently or no tankers have called this country&apos;s ports
              in the window.
            </p>
          ) : (
            <div className="overflow-hidden rounded-[var(--radius-lg)] border border-[color:var(--color-border)]">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-[color:var(--color-border)] bg-[color:var(--color-muted)]/30">
                  <tr>
                    <th className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
                      Port
                    </th>
                    <th className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
                      Type
                    </th>
                    <th className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
                      Vessels (30d)
                    </th>
                    <th className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
                      Last call
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {portAgg.map((p) => (
                    <tr
                      key={p.portSlug}
                      className="border-b border-[color:var(--color-border)] last:border-b-0"
                    >
                      <td className="px-3 py-2">{p.portName}</td>
                      <td className="px-3 py-2 text-[color:var(--color-muted-foreground)]">
                        {p.portType}
                      </td>
                      <td className="px-3 py-2 tabular-nums">{p.vesselCount}</td>
                      <td className="px-3 py-2 text-[color:var(--color-muted-foreground)] tabular-nums">
                        {p.lastCallAt.slice(0, 10)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* Brent–WTI spread chart */}
      <section className="mb-8">
        <div className="mb-2 flex items-baseline justify-between gap-4">
          <h2 className="text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Brent − WTI spread (USD/bbl)
          </h2>
          {latestSpread && (
            <span className="text-xs text-[color:var(--color-muted-foreground)] tabular-nums">
              Brent ${latestSpread.basePrice.toFixed(2)} ·{' '}
              WTI ${latestSpread.targetPrice.toFixed(2)} ·{' '}
              <span className="font-medium text-[color:var(--color-foreground)]">
                {latestSpread.spread >= 0 ? '+' : ''}${latestSpread.spread.toFixed(2)}
              </span>{' '}
              ({latestSpread.priceDate})
            </span>
          )}
        </div>
        <LineChart
          points={spreadData}
          yLabel="$/bbl"
          formatY={(n) => `${n >= 0 ? '+' : ''}$${n.toFixed(2)}`}
          emptyMessage="No price data in this window. Run ingest-fred-prices to populate Brent + WTI."
        />
      </section>

      {/* Customs flows — only when a country filter is active */}
      {buyerCountry && productCode && (
        <section className="mb-8 grid gap-6 md:grid-cols-2">
          <div>
            <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
              Top sources of {categoryTag} for {fmtCountry(buyerCountry)} (HS {productCode})
            </h2>
            {customsImports.length === 0 ? (
              <p className="text-sm text-[color:var(--color-muted-foreground)]">
                No customs-import rows for {buyerCountry} × {productCode} in this window.
                Eurostat covers EU reporters; UN Comtrade covers the rest. Some
                countries publish at coarser HS granularity.
              </p>
            ) : (
              <ol className="space-y-1.5 text-sm">
                {customsImports.map((r, i) => (
                  <li key={r.partnerCountry} className="flex items-baseline justify-between gap-3">
                    <span>
                      <span className="text-[color:var(--color-muted-foreground)]">
                        {String(i + 1).padStart(2, '0')}.{' '}
                      </span>
                      {fmtCountry(r.partnerCountry)}{' '}
                      <span className="text-[color:var(--color-muted-foreground)]">
                        {r.partnerCountry}
                      </span>
                    </span>
                    <span className="shrink-0 text-[color:var(--color-muted-foreground)] tabular-nums">
                      {fmtUsd(r.totalValueUsd)}
                      {r.totalQuantityKg != null && (
                        <span> · {(r.totalQuantityKg / 1_000_000).toFixed(1)}k MT</span>
                      )}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </div>
          <div>
            <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
              Top destinations of {categoryTag} from {fmtCountry(buyerCountry)} (HS {productCode})
            </h2>
            {customsExports.length === 0 ? (
              <p className="text-sm text-[color:var(--color-muted-foreground)]">
                No customs rows showing {buyerCountry} as the partner (origin) for{' '}
                {productCode} in this window. {buyerCountry} may be primarily an importer
                for this category, or its exports aren&apos;t captured by EU/UN reporters.
              </p>
            ) : (
              <ol className="space-y-1.5 text-sm">
                {customsExports.map((r, i) => (
                  <li
                    key={r.reporterCountry}
                    className="flex items-baseline justify-between gap-3"
                  >
                    <span>
                      <span className="text-[color:var(--color-muted-foreground)]">
                        {String(i + 1).padStart(2, '0')}.{' '}
                      </span>
                      {fmtCountry(r.reporterCountry)}{' '}
                      <span className="text-[color:var(--color-muted-foreground)]">
                        {r.reporterCountry}
                      </span>
                    </span>
                    <span className="shrink-0 text-[color:var(--color-muted-foreground)] tabular-nums">
                      {fmtUsd(r.totalValueUsd)}
                      {r.totalQuantityKg != null && (
                        <span> · {(r.totalQuantityKg / 1_000_000).toFixed(1)}k MT</span>
                      )}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </section>
      )}

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

      {/* Supplier × buyer-country award matrix */}
      <section className="mb-8">
        <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
          Top suppliers × buyer countries — award count
        </h2>
        <Heatmap
          rows={supplierBuyerMatrix.suppliers.map((s) => ({
            id: s.supplierId,
            label: s.supplierName,
            sublabel: `${s.total}`,
          }))}
          cols={supplierBuyerMatrix.buyerCountries.map((c) => ({
            id: c.country,
            label: c.country,
          }))}
          cells={matrixCells}
          emptyMessage="Need supplier + buyer-country data to render the matrix. Try a wider window or different category."
        />
        <p className="mt-2 text-xs text-[color:var(--color-muted-foreground)]">
          Reveals geographic specialization — concentrated rows =
          supplier serves few markets; concentrated columns = country
          buys from few suppliers. Hover a cell for the exact count.
        </p>
      </section>

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
