import Link from 'next/link';
import type { RefineryImportContext } from '@procur/catalog';

/**
 * Slate × actual customs flow cross-reference, rendered as a small
 * table on the refinery profile page. Each row is a slate-compatible
 * grade with the refinery's country's last-12mo import flow for that
 * grade's origin country.
 *
 * Bigger flow first — that's the strongest "slate isn't lying" signal.
 * Slate-fit-but-no-flow rows fall to the bottom; they're either
 * whitespace or a supply route procur can't see (private cargoes,
 * non-Eurostat reporters).
 */
export function RefineryImportContextPanel({
  ctx,
}: {
  ctx: RefineryImportContext;
}) {
  const totalKg = ctx.summary.totalQuantityKg;
  const realismPct =
    ctx.summary.slateCompatibleGradeCount > 0
      ? (ctx.summary.gradesWithImportEvidence /
          ctx.summary.slateCompatibleGradeCount) *
        100
      : 0;

  return (
    <section className="mb-6">
      <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
        Supply realism · slate × customs flow
      </h2>
      <div className="rounded-[var(--radius-lg)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-4 shadow-sm">
        <div className="mb-3 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs text-[color:var(--color-muted-foreground)]">
          <span>
            Slate accepts{' '}
            <span className="font-semibold text-[color:var(--color-foreground)]">
              {ctx.summary.slateCompatibleGradeCount}
            </span>{' '}
            grades
          </span>
          <span>
            <span className="font-semibold text-[color:var(--color-foreground)]">
              {ctx.summary.gradesWithImportEvidence}
            </span>{' '}
            with active flow ({realismPct.toFixed(0)}%)
          </span>
          {totalKg != null && (
            <span>
              Total HS {ctx.productCode} imports last {ctx.monthsLookback}mo:{' '}
              <span className="font-semibold text-[color:var(--color-foreground)] tabular-nums">
                {(totalKg / 1_000_000).toFixed(1)}M kg
              </span>
            </span>
          )}
        </div>

        <div className="overflow-hidden rounded-[var(--radius-md)] border border-[color:var(--color-border)]">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-[color:var(--color-border)] bg-[color:var(--color-muted)]/30 text-[10px] uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
              <tr>
                <th className="px-3 py-1.5 font-medium">Grade</th>
                <th className="px-3 py-1.5 font-medium">Origin</th>
                <th className="px-3 py-1.5 text-right font-medium">
                  Imports {ctx.monthsLookback}mo
                </th>
                <th className="px-3 py-1.5 text-right font-medium">Months</th>
                <th className="px-3 py-1.5 text-right font-medium">Latest</th>
              </tr>
            </thead>
            <tbody>
              {ctx.rows.map((r) => {
                const hasFlow = r.quantityKg != null && r.quantityKg > 0;
                return (
                  <tr
                    key={r.gradeSlug}
                    className="border-b border-[color:var(--color-border)] last:border-b-0"
                  >
                    <td className="px-3 py-1.5">
                      <Link
                        href={`/crudes/${r.gradeSlug}`}
                        className="font-medium hover:underline"
                      >
                        {r.gradeName}
                      </Link>
                      {r.gradeApiGravity != null && (
                        <span className="ml-2 text-[10px] text-[color:var(--color-muted-foreground)] tabular-nums">
                          {r.gradeApiGravity.toFixed(1)}° API
                          {r.gradeSulfurPct != null
                            ? ` · ${r.gradeSulfurPct.toFixed(2)}% S`
                            : ''}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-[color:var(--color-muted-foreground)]">
                      {r.gradeOriginCountry}
                    </td>
                    <td
                      className={`px-3 py-1.5 text-right tabular-nums ${
                        hasFlow ? '' : 'text-[color:var(--color-muted-foreground)]'
                      }`}
                    >
                      {hasFlow
                        ? `${(r.quantityKg! / 1_000_000).toFixed(1)}M kg`
                        : '—'}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-[color:var(--color-muted-foreground)]">
                      {r.monthsActive > 0 ? r.monthsActive : '—'}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-[color:var(--color-muted-foreground)]">
                      {r.mostRecentPeriod ?? '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <p className="mt-2 text-[10px] text-[color:var(--color-muted-foreground)]">
          Customs flows are reporter × partner-country level (Eurostat /
          UN Comtrade) — strong signal that {ctx.refineryCountry} as a
          country buys from these origins, not vessel-level proof of this
          refinery doing so. Slate-fit + zero flow = whitespace or
          private supply route.
        </p>
      </div>
    </section>
  );
}
