import type { FuelBuyerImportContext } from '@procur/catalog';

/**
 * Fuel-buyer profile validation panel — country-level customs flow
 * vs buyer's declared annual volume + fuel mix. Same shape as the
 * refinery import context panel: render the buyer's claim alongside
 * country reality, with a partner-country breakdown showing where
 * the country actually imports refined product from.
 *
 * Surfaces:
 *   - Country's HS 2710 imports last 12mo (total kg + USD)
 *   - Buyer's declared volume (bbl/yr range with confidence flag)
 *   - Implied share — buyer's max declared / country's total
 *   - Partner-country source mix — top 25 sources by volume
 *
 * Implausibility warnings flow through `ctx.notes` (rendered as
 * pills below the table when present).
 */
export function FuelBuyerImportContextPanel({
  ctx,
}: {
  ctx: FuelBuyerImportContext;
}) {
  const totalKg = ctx.countryImportTotalKg;
  const sharePct =
    ctx.impliedShareOfCountryMax != null ? ctx.impliedShareOfCountryMax * 100 : null;

  return (
    <section className="mb-6">
      <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
        Demand validation · declared volume × country flows
      </h2>
      <div className="rounded-[var(--radius-lg)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-4 shadow-sm">
        <div className="mb-3 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs text-[color:var(--color-muted-foreground)]">
          {totalKg != null && (
            <span>
              {ctx.buyerCountry} HS {ctx.productCode} imports {ctx.monthsLookback}mo:{' '}
              <span className="font-semibold text-[color:var(--color-foreground)] tabular-nums">
                {(totalKg / 1_000_000).toFixed(1)}M kg
              </span>
            </span>
          )}
          {ctx.buyerVolumeBblMax != null && (
            <span>
              Buyer claim:{' '}
              <span className="font-semibold text-[color:var(--color-foreground)] tabular-nums">
                {ctx.buyerVolumeBblMin != null
                  ? `${(ctx.buyerVolumeBblMin / 1_000_000).toFixed(2)}–${(ctx.buyerVolumeBblMax / 1_000_000).toFixed(2)}M bbl/yr`
                  : `${(ctx.buyerVolumeBblMax / 1_000_000).toFixed(2)}M bbl/yr`}
              </span>
            </span>
          )}
          {sharePct != null && (
            <span>
              Implied share:{' '}
              <span
                className={`font-semibold tabular-nums ${
                  sharePct > 100
                    ? 'text-amber-700'
                    : 'text-[color:var(--color-foreground)]'
                }`}
              >
                {sharePct.toFixed(0)}%
              </span>
            </span>
          )}
        </div>

        {ctx.fuelTypesDeclared.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-1 text-[10px]">
            <span className="text-[color:var(--color-muted-foreground)]">Declared mix:</span>
            {ctx.fuelTypesDeclared.map((f) => (
              <span
                key={f}
                className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-1.5 py-0.5 font-mono"
              >
                {f}
              </span>
            ))}
          </div>
        )}

        {ctx.partnerBreakdown.length > 0 ? (
          <div className="overflow-hidden rounded-[var(--radius-md)] border border-[color:var(--color-border)]">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-[color:var(--color-border)] bg-[color:var(--color-muted)]/30 text-[10px] uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
                <tr>
                  <th className="px-3 py-1.5 font-medium">Source country</th>
                  <th className="px-3 py-1.5 text-right font-medium">
                    Imports {ctx.monthsLookback}mo
                  </th>
                  <th className="px-3 py-1.5 text-right font-medium">USD value</th>
                  <th className="px-3 py-1.5 text-right font-medium">Months</th>
                  <th className="px-3 py-1.5 text-right font-medium">Latest</th>
                </tr>
              </thead>
              <tbody>
                {ctx.partnerBreakdown.map((r) => (
                  <tr
                    key={r.partnerCountry}
                    className="border-b border-[color:var(--color-border)] last:border-b-0"
                  >
                    <td className="px-3 py-1.5 font-medium">{r.partnerCountry}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {r.quantityKg != null
                        ? `${(r.quantityKg / 1_000_000).toFixed(1)}M kg`
                        : '—'}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-[color:var(--color-muted-foreground)]">
                      {r.valueUsd != null
                        ? `$${(r.valueUsd / 1_000_000).toFixed(1)}M`
                        : '—'}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-[color:var(--color-muted-foreground)]">
                      {r.monthsActive > 0 ? r.monthsActive : '—'}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-[color:var(--color-muted-foreground)]">
                      {r.mostRecentPeriod ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-xs text-[color:var(--color-muted-foreground)]">
            No customs flows surfaced for {ctx.buyerCountry} HS {ctx.productCode} in
            the last {ctx.monthsLookback} months.
          </p>
        )}

        {ctx.notes.length > 0 && (
          <div className="mt-3 space-y-1 text-[11px] text-amber-800">
            {ctx.notes.map((n, i) => (
              <p key={i} className="rounded-[var(--radius-sm)] bg-amber-50 px-2 py-1">
                {n}
              </p>
            ))}
          </div>
        )}

        <p className="mt-2 text-[10px] text-[color:var(--color-muted-foreground)]">
          Customs flows are reporter × partner-country level (Eurostat /
          UN Comtrade) — strong signal that {ctx.buyerCountry} as a country
          imports from these origins, not vessel-level proof of this buyer
          doing so. Buyer-volume vs country-import comparison uses ~7.0 bbl/MT
          for refined-product blend conversion.
        </p>
      </div>
    </section>
  );
}
