import type {
  BuyerConsumptionEstimateRow,
  FuelConsumptionSignalRow,
} from '@procur/catalog';

/**
 * Surfaces fuel-consumption signals shipped via PR #414 + Tier A
 * sources (#416/#417/#418/#420/#421). Until now they were only
 * visible through chat tools (lookup_known_entities,
 * analyze_supplier); this panel makes them readable on the entity
 * profile too.
 *
 * Layout:
 *   - Header: aggregated weighted estimate from
 *     buyer_consumption_estimate view (confidence-weighted midpoint
 *     × source count × dominant fuel types)
 *   - Per-source rows: source / fuel_type / volume range / confidence
 *     / coverage_year / notes / source URL
 *
 * Confidence framing per the brief: regulatory disclosure (EITI,
 * NI 43-101, customs) sits at 0.85+; analyst-curated mining ~0.7;
 * website-extracted marketing 0.4-0.6.
 */
export function ConsumptionSignalsPanel({
  estimate,
  signals,
}: {
  estimate: BuyerConsumptionEstimateRow | null;
  signals: FuelConsumptionSignalRow[];
}) {
  if (!estimate && signals.length === 0) {
    return null;
  }

  return (
    <section className="mb-6 rounded-md border border-[color:var(--color-border)]/60 bg-[color:var(--color-muted)]/30 p-3">
      <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
        Fuel consumption signals
      </h2>

      {estimate && estimate.weightedVolumeBblYr != null && (
        <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat
            label="Estimate (bbl/yr)"
            value={formatBbl(estimate.weightedVolumeBblYr)}
            sub={
              estimate.volumeBblYrMin != null && estimate.volumeBblYrMax != null
                ? `${formatBbl(estimate.volumeBblYrMin)} – ${formatBbl(estimate.volumeBblYrMax)}`
                : null
            }
          />
          <Stat
            label="Sources"
            value={String(estimate.signalCount)}
            sub={estimate.sources.slice(0, 3).join(', ')}
          />
          <Stat
            label="Fuel mix"
            value={
              estimate.fuelTypes.length > 0 ? estimate.fuelTypes.join(' / ') : '—'
            }
          />
          <Stat
            label="Confidence"
            value={
              estimate.avgConfidence != null ? estimate.avgConfidence.toFixed(2) : '—'
            }
            sub={estimate.mostRecentSignal ? `latest ${estimate.mostRecentSignal}` : null}
          />
        </div>
      )}

      {signals.length > 0 && (
        <div>
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Per-source detail
          </div>
          <ul className="divide-y divide-[color:var(--color-border)]/60">
            {signals.map((s) => (
              <li
                key={s.id}
                className="grid grid-cols-[110px_72px_minmax(0,1fr)_72px_72px] items-baseline gap-3 py-2 text-xs"
              >
                <span className="font-medium">{s.source}</span>
                <span className="text-[color:var(--color-muted-foreground)]">
                  {s.fuelType ?? '—'}
                </span>
                <span className="text-[color:var(--color-muted-foreground)]">
                  {s.volumeBblYrMin != null && s.volumeBblYrMax != null
                    ? `${formatBbl(s.volumeBblYrMin)} – ${formatBbl(s.volumeBblYrMax)}`
                    : '—'}
                </span>
                <span className="text-right tabular-nums">
                  {s.confidence != null ? s.confidence.toFixed(2) : '—'}
                </span>
                <span className="text-right tabular-nums text-[color:var(--color-muted-foreground)]">
                  {s.coverageYear ?? '—'}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="mt-3 text-[10px] text-[color:var(--color-muted-foreground)]">
        Signals from regulatory disclosure (EITI, NI 43-101, customs) sit at
        0.85+ confidence; analyst-curated estimates ~0.7; website-extracted
        marketing data 0.4-0.6.
      </p>
    </section>
  );
}

function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string | null;
}) {
  return (
    <div className="rounded border border-[color:var(--color-border)]/40 bg-[color:var(--color-background)] p-2">
      <div className="text-[10px] uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
        {label}
      </div>
      <div className="text-sm font-medium">{value}</div>
      {sub && <div className="text-[10px] text-[color:var(--color-muted-foreground)]">{sub}</div>}
    </div>
  );
}

function formatBbl(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return n.toFixed(0);
}
