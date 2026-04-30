import { getCommodityTicker } from '@procur/catalog';
import { Sparkline } from './Sparkline';

/**
 * Commodity price ticker shared between the brief (`/`) and the market
 * intelligence page (`/suppliers/intelligence`). Renders the same five
 * series (Brent, WTI, NYH ULSD/RBOB/HO) with latest price, 30-day pct
 * change, and a sparkline.
 *
 * Server component; queries directly. Wrapped in try/catch so a benchmark
 * fetch failure doesn't crash either surface that mounts it — the
 * component renders nothing on error rather than show a partial ticker.
 */

const TICKER_SERIES: Array<{ slug: string; label: string }> = [
  { slug: 'brent', label: 'Brent' },
  { slug: 'wti', label: 'WTI' },
  { slug: 'nyh-diesel', label: 'NYH ULSD' },
  { slug: 'nyh-gasoline', label: 'NYH RBOB' },
  { slug: 'nyh-heating-oil', label: 'NYH No.2' },
];

export async function CommodityPriceTicker() {
  let ticker;
  try {
    ticker = await getCommodityTicker(TICKER_SERIES.map((s) => s.slug));
  } catch {
    return null;
  }
  if (ticker.length === 0) return null;

  return (
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
  );
}
