import { LABOR_RATE_SOURCES, type LaborCategory } from '@procur/db';
import { formatMoney } from '../../../lib/format';
import {
  aggregateYearTotals,
  type LaborCategoryCalculation,
  type PricingSummary,
} from '../../../lib/pricer-queries';
import {
  addLaborCategoryAction,
  removeLaborCategoryAction,
  updateLaborCategoryAction,
} from '../actions';
import { RATE_SOURCE_LABEL, RateSourceChip } from './rate-source';
import { ExpanderChevron, LcatRowExpander } from './lcat-row-expander';

/**
 * Labor Categories tab. Three sections, top-to-bottom:
 *
 *   1. Labor Cost Summary  — totals (hours / blended rate / direct / loaded)
 *   2. Year-by-Year Costs  — per-year totals across all categories with
 *                            escalation step labels (P3)
 *   3. Categories table    — inline-editable rows + Add form
 *
 * Mirrors the Govdash Labor Categories tab in Screenshot…1.26.14 PM.
 */
export function LaborTab({
  laborCategories,
  summary,
  pursuitId,
  hoursPerFte,
  escalationPct,
  currency,
}: {
  laborCategories: LaborCategory[];
  summary: PricingSummary & { laborCategories: LaborCategoryCalculation[] };
  pursuitId: string;
  hoursPerFte: number;
  escalationPct: number;
  currency: string;
}) {
  const yearTotals = aggregateYearTotals(summary.laborCategories);
  const totalHours = summary.laborCategories.reduce((s, c) => s + c.hoursPerYear * summary.periodYears, 0);
  const ftes = totalHours / Math.max(1, hoursPerFte * summary.periodYears);
  const directRateBlend =
    summary.laborCategories.length > 0
      ? summary.laborCategories.reduce((s, c) => s + c.directRate * c.hoursPerYear, 0) /
        Math.max(1, summary.laborCategories.reduce((s, c) => s + c.hoursPerYear, 0))
      : 0;
  const loadedBlend = directRateBlend * summary.wrapRate;
  const directLaborCost = summary.totalLaborCost / summary.wrapRate;

  return (
    <div className="space-y-4">
      {/* Labor Cost Summary */}
      <section className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-5">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-sm font-semibold">Labor Cost Summary</h2>
          <p className="text-xs text-[color:var(--color-muted-foreground)]">
            Wrap Rate: <span className="font-medium">{summary.wrapRate.toFixed(4)}x</span>
          </p>
        </div>
        <div className="grid gap-3 md:grid-cols-4">
          <Stat
            label="Total Hours"
            value={totalHours.toLocaleString()}
            sub={`${ftes.toFixed(1)} FTEs across ${summary.periodYears} year${summary.periodYears === 1 ? '' : 's'}`}
          />
          <Stat
            label="Blended Rate"
            value={`${formatMoney(loadedBlend, currency) ?? '—'}/hr`}
            sub={`${formatMoney(directRateBlend, currency) ?? '—'} direct`}
          />
          <Stat
            label="Direct Labor Cost"
            value={formatMoney(directLaborCost, currency) ?? '—'}
            sub="Before indirect rates"
          />
          <Stat
            label="Total Labor Cost"
            value={formatMoney(summary.totalLaborCost, currency) ?? '—'}
            sub="Fully burdened"
          />
        </div>
      </section>

      {/* Year-by-Year Costs (P3) */}
      {yearTotals.length > 0 && (
        <section className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-5">
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="text-sm font-semibold">Year-by-Year Costs</h2>
            <p className="text-xs text-[color:var(--color-muted-foreground)]">
              {escalationPct > 0 ? `${escalationPct.toFixed(1)}% escalation per year` : 'No escalation'}
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[color:var(--color-border)] text-[11px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
                  {yearTotals.map((y) => (
                    <th key={y.year} className="px-3 py-2 text-left font-medium">
                      {y.year === 1 ? 'Base Year' : `Option Yr ${y.year - 1}`}
                      {escalationPct > 0 && y.year > 1 && (
                        <span className="ml-1 text-[10px] normal-case text-[color:var(--color-muted-foreground)]/70">
                          ({((Math.pow(1 + escalationPct / 100, y.year - 1) - 1) * 100).toFixed(1)}% esc.)
                        </span>
                      )}
                    </th>
                  ))}
                  <th className="px-3 py-2 text-right font-medium">Total all years</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  {yearTotals.map((y) => (
                    <td key={y.year} className="px-3 py-3 font-medium">
                      {formatMoney(y.cost, currency) ?? '—'}
                    </td>
                  ))}
                  <td className="px-3 py-3 text-right font-semibold">
                    {formatMoney(summary.totalLaborCost, currency) ?? '—'}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Categories table */}
      <section className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)]">
        <header className="flex items-center justify-between border-b border-[color:var(--color-border)] px-5 py-3">
          <h2 className="text-sm font-semibold">
            Labor Categories ({summary.laborCategories.length})
          </h2>
        </header>

        {summary.laborCategories.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-[color:var(--color-border)] text-[11px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
                <tr>
                  <th className="px-4 py-2">Title</th>
                  <th className="px-4 py-2">Type</th>
                  <th className="px-4 py-2">Rate source</th>
                  <th className="px-4 py-2 text-right">Direct rate</th>
                  <th className="px-4 py-2 text-right">Loaded rate</th>
                  <th className="px-4 py-2 text-right">Hours/yr</th>
                  <th className="px-4 py-2 text-right">Total ({summary.periodYears}y)</th>
                  <th className="px-4 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {summary.laborCategories.map((calc) => {
                  const lc = laborCategories.find((l) => l.id === calc.id);
                  if (!lc) return null;
                  return (
                    <LcatRowExpander
                      key={lc.id}
                      colSpan={8}
                      renderSummary={({ open, toggle }) => (
                        <tr className="border-t border-[color:var(--color-border)]">
                          <td className="px-4 py-2">
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={toggle}
                                aria-label={open ? 'Collapse' : 'Expand'}
                                aria-expanded={open}
                                className="shrink-0 px-1"
                              >
                                <ExpanderChevron open={open} />
                              </button>
                              <form action={updateLaborCategoryAction} className="flex flex-1 gap-2">
                                <input type="hidden" name="pursuitId" value={pursuitId} />
                                <input type="hidden" name="laborCategoryId" value={lc.id} />
                                <input type="hidden" name="directRate" value={lc.directRate ?? '0'} />
                                <input type="hidden" name="hoursPerYear" value={lc.hoursPerYear ?? hoursPerFte} />
                                <input type="hidden" name="type" value={lc.type ?? ''} />
                                <input
                                  name="title"
                                  defaultValue={lc.title}
                                  className="w-full rounded-[var(--radius-sm)] border border-transparent bg-transparent px-2 py-1 text-sm font-medium hover:border-[color:var(--color-border)]"
                                />
                                <button
                                  type="submit"
                                  className="text-[10px] underline text-[color:var(--color-muted-foreground)]"
                                >
                                  Save
                                </button>
                              </form>
                            </div>
                          </td>
                      <td className="px-4 py-2">
                        <form action={updateLaborCategoryAction}>
                          <input type="hidden" name="pursuitId" value={pursuitId} />
                          <input type="hidden" name="laborCategoryId" value={lc.id} />
                          <input type="hidden" name="title" value={lc.title} />
                          <input type="hidden" name="directRate" value={lc.directRate ?? '0'} />
                          <input type="hidden" name="hoursPerYear" value={lc.hoursPerYear ?? hoursPerFte} />
                          <select
                            name="type"
                            defaultValue={lc.type ?? ''}
                            className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-1 py-0.5 text-xs"
                          >
                            <option value="">—</option>
                            <option value="key_personnel">Key personnel</option>
                            <option value="standard">Standard</option>
                          </select>
                          <button type="submit" className="ml-1 text-[10px] underline text-[color:var(--color-muted-foreground)]">
                            Save
                          </button>
                        </form>
                      </td>
                      <td className="px-4 py-2">
                        {/* Display the current rate-source chip, with an
                            expandable inline form (details/summary) to
                            change source + reference in-place without
                            introducing a modal. */}
                        <details className="inline-block">
                          <summary className="cursor-pointer list-none">
                            <RateSourceChip
                              source={lc.rateSource}
                              reference={lc.rateSourceReference}
                            />
                          </summary>
                          <form
                            action={updateLaborCategoryAction}
                            className="mt-1.5 flex flex-col gap-1 rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-2 shadow-sm"
                          >
                            <input type="hidden" name="pursuitId" value={pursuitId} />
                            <input type="hidden" name="laborCategoryId" value={lc.id} />
                            <select
                              name="rateSource"
                              defaultValue={lc.rateSource ?? 'manual'}
                              className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-1 py-0.5 text-[11px]"
                            >
                              {LABOR_RATE_SOURCES.map((s) => (
                                <option key={s} value={s}>
                                  {RATE_SOURCE_LABEL[s]}
                                </option>
                              ))}
                            </select>
                            <input
                              name="rateSourceReference"
                              defaultValue={lc.rateSourceReference ?? ''}
                              placeholder="Reference (e.g. GSA #, CBA 2024)"
                              className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-1.5 py-0.5 text-[11px]"
                            />
                            <button
                              type="submit"
                              className="self-end text-[10px] underline text-[color:var(--color-muted-foreground)]"
                            >
                              Save
                            </button>
                          </form>
                        </details>
                      </td>
                      <td className="px-4 py-2 text-right">
                        <form action={updateLaborCategoryAction} className="flex justify-end gap-1">
                          <input type="hidden" name="pursuitId" value={pursuitId} />
                          <input type="hidden" name="laborCategoryId" value={lc.id} />
                          <input type="hidden" name="title" value={lc.title} />
                          <input type="hidden" name="hoursPerYear" value={lc.hoursPerYear ?? hoursPerFte} />
                          <input type="hidden" name="type" value={lc.type ?? ''} />
                          <input
                            name="directRate"
                            type="number"
                            step="0.01"
                            defaultValue={lc.directRate ?? '0'}
                            className="w-24 rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-transparent px-2 py-1 text-right text-sm"
                          />
                          <button type="submit" className="text-[10px] underline text-[color:var(--color-muted-foreground)]">
                            Save
                          </button>
                        </form>
                      </td>
                      <td className="px-4 py-2 text-right font-medium">
                        {formatMoney(calc.loadedRate, currency) ?? '—'}/hr
                      </td>
                      <td className="px-4 py-2 text-right">
                        <form action={updateLaborCategoryAction} className="flex justify-end gap-1">
                          <input type="hidden" name="pursuitId" value={pursuitId} />
                          <input type="hidden" name="laborCategoryId" value={lc.id} />
                          <input type="hidden" name="title" value={lc.title} />
                          <input type="hidden" name="directRate" value={lc.directRate ?? '0'} />
                          <input type="hidden" name="type" value={lc.type ?? ''} />
                          <input
                            name="hoursPerYear"
                            type="number"
                            defaultValue={lc.hoursPerYear ?? hoursPerFte}
                            className="w-20 rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-transparent px-2 py-1 text-right text-sm"
                          />
                          <button type="submit" className="text-[10px] underline text-[color:var(--color-muted-foreground)]">
                            Save
                          </button>
                        </form>
                      </td>
                      <td className="px-4 py-2 text-right font-semibold">
                        {formatMoney(calc.totalCost, currency) ?? '—'}
                      </td>
                          <td className="px-4 py-2">
                            <form action={removeLaborCategoryAction}>
                              <input type="hidden" name="pursuitId" value={pursuitId} />
                              <input type="hidden" name="laborCategoryId" value={lc.id} />
                              <button
                                type="submit"
                                className="text-xs text-[color:var(--color-muted-foreground)] hover:text-red-600"
                                title="Remove"
                              >
                                ×
                              </button>
                            </form>
                          </td>
                        </tr>
                      )}
                      renderExpanded={() => (
                        <div className="grid gap-3 text-xs md:grid-cols-2">
                          <form action={updateLaborCategoryAction} className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-3">
                            <input type="hidden" name="pursuitId" value={pursuitId} />
                            <input type="hidden" name="laborCategoryId" value={lc.id} />
                            <label className="block">
                              <span className="text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
                                Description
                              </span>
                              <textarea
                                name="description"
                                rows={4}
                                defaultValue={lc.description ?? ''}
                                placeholder="Supports content editing, strategy, and architecture to deliver in a marketable way to audiences…"
                                className="mt-1 w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-xs"
                              />
                            </label>
                            <div className="mt-2 flex justify-end">
                              <button
                                type="submit"
                                className="text-[10px] underline text-[color:var(--color-muted-foreground)]"
                              >
                                Save description
                              </button>
                            </div>
                          </form>

                          <form action={updateLaborCategoryAction} className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-3">
                            <input type="hidden" name="pursuitId" value={pursuitId} />
                            <input type="hidden" name="laborCategoryId" value={lc.id} />
                            <label className="block">
                              <span className="text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
                                Requirements &amp; Certifications
                              </span>
                              <textarea
                                name="requirementsCertifications"
                                rows={4}
                                defaultValue={lc.requirementsCertifications ?? ''}
                                placeholder="Experience with X · certification Y · cleared to Z · 10+ years in…"
                                className="mt-1 w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-xs"
                              />
                            </label>
                            <div className="mt-2 flex justify-end">
                              <button
                                type="submit"
                                className="text-[10px] underline text-[color:var(--color-muted-foreground)]"
                              >
                                Save requirements
                              </button>
                            </div>
                          </form>

                          {/* Rate detail summary panel — read-only recap of
                              rate source + reference since both are edited
                              from the main row's rate-source chip popover. */}
                          <div className="md:col-span-2 rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-muted)]/30 p-3">
                            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
                              Rate information
                            </p>
                            <div className="grid gap-2 sm:grid-cols-4">
                              <div>
                                <p className="text-[10px] text-[color:var(--color-muted-foreground)]">Base rate</p>
                                <p className="font-medium">
                                  {formatMoney(calc.directRate, currency) ?? '—'}/hr
                                </p>
                              </div>
                              <div>
                                <p className="text-[10px] text-[color:var(--color-muted-foreground)]">Burdened rate</p>
                                <p className="font-medium">
                                  {formatMoney(calc.loadedRate, currency) ?? '—'}/hr
                                </p>
                              </div>
                              <div>
                                <p className="text-[10px] text-[color:var(--color-muted-foreground)]">Source</p>
                                <p className="font-medium">
                                  {RATE_SOURCE_LABEL[lc.rateSource ?? 'manual']}
                                </p>
                              </div>
                              <div>
                                <p className="text-[10px] text-[color:var(--color-muted-foreground)]">Reference</p>
                                <p className="truncate font-medium" title={lc.rateSourceReference ?? ''}>
                                  {lc.rateSourceReference ?? '—'}
                                </p>
                              </div>
                            </div>
                          </div>
                        </div>
                      )}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <form
          action={addLaborCategoryAction}
          className="flex flex-wrap items-end gap-3 border-t border-[color:var(--color-border)] p-4"
        >
          <input type="hidden" name="pursuitId" value={pursuitId} />
          <label className="flex flex-1 flex-col gap-1 text-sm">
            <span className="text-[11px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
              Add labor category
            </span>
            <input
              name="title"
              required
              placeholder="e.g. Senior Engineer / Project Manager"
              className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[11px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
              Direct rate
            </span>
            <input
              name="directRate"
              type="number"
              step="0.01"
              placeholder="0.00"
              className="w-28 rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[11px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
              Hours/yr
            </span>
            <input
              name="hoursPerYear"
              type="number"
              defaultValue={hoursPerFte}
              className="w-20 rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[11px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
              Type
            </span>
            <select
              name="type"
              className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-sm"
            >
              <option value="">—</option>
              <option value="key_personnel">Key personnel</option>
              <option value="standard">Standard</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[11px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
              Rate source
            </span>
            <select
              name="rateSource"
              defaultValue="manual"
              className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-sm"
            >
              {LABOR_RATE_SOURCES.map((s) => (
                <option key={s} value={s}>
                  {RATE_SOURCE_LABEL[s]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-1 min-w-[160px] flex-col gap-1 text-sm">
            <span className="text-[11px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
              Reference (optional)
            </span>
            <input
              name="rateSourceReference"
              placeholder="GSA #, CBA 2024, IDB Loan 45/24…"
              className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1 text-sm"
            />
          </label>
          <button
            type="submit"
            className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-3 py-1.5 text-sm font-medium text-[color:var(--color-background)]"
          >
            + Add
          </button>
          {/* Optional detail fields collapsed by default so the add form
              stays one line on wide screens. Description and requirements
              can also be edited post-creation from the expanded row. */}
          <details className="w-full">
            <summary className="cursor-pointer text-[11px] text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]">
              + description &amp; requirements (optional)
            </summary>
            <div className="mt-2 grid gap-2 md:grid-cols-2">
              <label className="block text-sm">
                <span className="text-[11px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
                  Description
                </span>
                <textarea
                  name="description"
                  rows={3}
                  placeholder="Role narrative — shown on the expanded row and available to AI drafting."
                  className="mt-1 w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1.5 text-xs"
                />
              </label>
              <label className="block text-sm">
                <span className="text-[11px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
                  Requirements &amp; certifications
                </span>
                <textarea
                  name="requirementsCertifications"
                  rows={3}
                  placeholder="Experience · certification · clearance · years in role…"
                  className="mt-1 w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1.5 text-xs"
                />
              </label>
            </div>
          </details>
        </form>
      </section>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
        {label}
      </p>
      <p className="mt-1 text-lg font-semibold">{value}</p>
      {sub && (
        <p className="mt-0.5 text-[11px] text-[color:var(--color-muted-foreground)]">{sub}</p>
      )}
    </div>
  );
}
