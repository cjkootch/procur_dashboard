import { getMarketMoveBanner } from '@procur/catalog';

/**
 * Site-wide ribbon shown when at least one tracked benchmark moved
 * more than the threshold (default ±5%) over the trailing window
 * (default 7 days). Renders nothing when nothing material moved —
 * traders shouldn't get banner fatigue.
 *
 * Server component; queries directly. Cached by the layout's
 * dynamic = 'force-dynamic' policy (re-fetched per request, which
 * is fine because the underlying data only changes on benchmark
 * ingest cadence — the banner is essentially constant within a
 * trading day).
 */
export async function MarketMoveBanner() {
  let banner;
  try {
    banner = await getMarketMoveBanner(7, 0.05);
  } catch {
    // Banner is best-effort — never let a benchmark query failure
    // crash the entire app shell. Render nothing on error.
    return null;
  }
  if (!banner.shouldDisplay) return null;

  // Only show series that actually moved past the threshold; quiet
  // series stay off the ribbon to keep it scannable.
  const moving = banner.series.filter(
    (s) => s.pctChange != null && Math.abs(s.pctChange) >= banner.thresholdAbs,
  );
  if (moving.length === 0) return null;

  return (
    <div className="sticky top-0 z-40 flex flex-wrap items-center justify-center gap-3 border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-xs text-amber-900">
      <span className="font-medium uppercase tracking-wide">
        Market moved {banner.windowDays}d:
      </span>
      {moving.map((s) => {
        const pct = (s.pctChange ?? 0) * 100;
        const sign = pct >= 0 ? '+' : '';
        const directionClass = pct >= 0 ? 'text-emerald-800' : 'text-red-800';
        return (
          <span key={s.seriesSlug} className="inline-flex items-center gap-1">
            <span className="font-semibold">{s.label}</span>
            <span className={`font-mono ${directionClass}`}>
              {sign}
              {pct.toFixed(1)}%
            </span>
            <span className="text-amber-700/80">
              ({formatPrice(s.latestPrice, s.unit)})
            </span>
          </span>
        );
      })}
      <span className="hidden sm:inline text-amber-700">
        Re-check open quotes against today&rsquo;s anchors.
      </span>
    </div>
  );
}

function formatPrice(price: number, unit: string): string {
  if (unit === 'usd-bbl') return `$${price.toFixed(2)}/bbl`;
  if (unit === 'usd-gal') return `$${price.toFixed(3)}/gal`;
  return `${price.toFixed(2)} ${unit}`;
}
