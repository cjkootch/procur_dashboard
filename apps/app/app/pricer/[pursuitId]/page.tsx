import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireCompany } from '@procur/auth';
import { getPricerByPursuitId, summarize } from '../../../lib/pricer-queries';
import { flagFor, formatDate, formatMoney } from '../../../lib/format';
import {
  addLaborCategoryAction,
  createPricingModelAction,
  removeLaborCategoryAction,
  updateLaborCategoryAction,
  updatePricingModelAction,
} from '../actions';

export const dynamic = 'force-dynamic';

const STRATEGY_LABEL: Record<string, string> = {
  labor_hours: 'Labor hours',
  firm_fixed_price: 'Firm fixed price',
  cost_plus: 'Cost plus',
  time_materials: 'Time & materials',
};

export default async function PricerDetailPage({
  params,
}: {
  params: Promise<{ pursuitId: string }>;
}) {
  const { pursuitId } = await params;
  const { company } = await requireCompany();
  const detail = await getPricerByPursuitId(company.id, pursuitId);
  if (!detail) notFound();

  const { pricingModel, laborCategories, opportunity } = detail;

  if (!pricingModel) {
    return (
      <div className="mx-auto max-w-3xl px-8 py-10">
        <Breadcrumbs title={opportunity.title} />
        <div className="rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-6">
          <h2 className="text-lg font-semibold">Start a pricing model</h2>
          <p className="mt-2 text-sm text-[color:var(--color-muted-foreground)]">
            Create a blank pricing model for this pursuit. You&rsquo;ll add labor categories,
            set indirect rates, and the target value auto-calculates.
          </p>
          <form action={createPricingModelAction} className="mt-4 space-y-3">
            <input type="hidden" name="pursuitId" value={pursuitId} />
            <label className="block">
              <span className="text-sm font-medium">Pricing strategy</span>
              <select
                name="pricingStrategy"
                defaultValue="labor_hours"
                className="mt-1 w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
              >
                {Object.entries(STRATEGY_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="submit"
              className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-4 py-2 text-sm font-medium text-[color:var(--color-background)]"
            >
              Create pricing model
            </button>
          </form>
        </div>
      </div>
    );
  }

  const summary = summarize(pricingModel, laborCategories);
  const currency = pricingModel.currency ?? 'USD';

  return (
    <div className="mx-auto max-w-6xl px-8 py-10">
      <Breadcrumbs title={opportunity.title} />

      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-sm text-[color:var(--color-muted-foreground)]">
            <span className="text-lg">{flagFor(opportunity.jurisdictionCountry)}</span>
            <span>
              {opportunity.jurisdictionName}
              {opportunity.agencyName && <> · {opportunity.agencyName}</>}
            </span>
          </div>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">{opportunity.title}</h1>
        </div>
        <Link href={`/capture/pursuits/${pursuitId}`} className="text-sm underline">
          Pursuit details →
        </Link>
      </header>

      <section className="mb-8 grid gap-4 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-6 md:grid-cols-5">
        <Fact
          label="Target value"
          value={formatMoney(summary.totalValue, currency) ?? '—'}
          sub={summary.totalValueUsd && currency !== 'USD' ? `≈ ${formatMoney(summary.totalValueUsd, 'USD')}` : undefined}
        />
        <Fact label="Labor cost" value={formatMoney(summary.totalLaborCost, currency) ?? '—'} />
        <Fact label="Target fee" value={formatMoney(summary.targetFee, currency) ?? '—'} />
        <Fact label="Wrap rate" value={`${summary.wrapRate.toFixed(4)}x`} />
        <Fact
          label="Period"
          value={`${summary.periodYears} year${summary.periodYears === 1 ? '' : 's'}`}
          sub={opportunity.deadlineAt ? `Bid by ${formatDate(opportunity.deadlineAt)}` : undefined}
        />
      </section>

      <section className="mb-10">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
          Contract settings
        </h2>
        <form
          action={updatePricingModelAction}
          className="grid gap-4 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-5 md:grid-cols-3"
        >
          <input type="hidden" name="pursuitId" value={pursuitId} />
          <NumField label="Base period (months)" name="basePeriodMonths" value={pricingModel.basePeriodMonths ?? 12} />
          <NumField label="Option years" name="optionYears" value={pricingModel.optionYears ?? 0} />
          <NumField label="Escalation %/yr" name="escalationRate" value={pricingModel.escalationRate ?? '0'} step="0.1" />
          <div>
            <label className="block text-xs text-[color:var(--color-muted-foreground)]">
              Strategy
            </label>
            <select
              name="pricingStrategy"
              defaultValue={pricingModel.pricingStrategy}
              className="mt-1 w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
            >
              {Object.entries(STRATEGY_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </div>
          <NumField label="Hours / FTE" name="hoursPerFte" value={pricingModel.hoursPerFte ?? 2080} />
          <NumField
            label="Target fee %"
            name="targetFeePct"
            value={pricingModel.targetFeePct ?? '0'}
            step="0.1"
          />
          <NumField
            label="Government estimate"
            name="governmentEstimate"
            value={pricingModel.governmentEstimate ?? ''}
            step="0.01"
          />
          <NumField
            label="Ceiling value"
            name="ceilingValue"
            value={pricingModel.ceilingValue ?? ''}
            step="0.01"
          />
          <div>
            <label className="block text-xs text-[color:var(--color-muted-foreground)]">Currency</label>
            <input
              name="currency"
              defaultValue={pricingModel.currency ?? 'USD'}
              maxLength={3}
              className="mt-1 w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
            />
          </div>
          <NumField
            label="FX to USD"
            name="fxRateToUsd"
            value={pricingModel.fxRateToUsd ?? ''}
            step="0.0001"
          />

          <div className="md:col-span-3">
            <h3 className="mt-4 mb-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
              Indirect rates
            </h3>
            <div className="grid gap-4 md:grid-cols-3">
              <NumField label="Fringe %" name="fringeRate" value={pricingModel.fringeRate ?? '0'} step="0.1" />
              <NumField label="Overhead %" name="overheadRate" value={pricingModel.overheadRate ?? '0'} step="0.1" />
              <NumField label="G&A %" name="gaRate" value={pricingModel.gaRate ?? '0'} step="0.1" />
            </div>
          </div>

          <div className="md:col-span-3">
            <label className="block text-xs text-[color:var(--color-muted-foreground)]">Notes</label>
            <textarea
              name="notes"
              rows={2}
              defaultValue={pricingModel.notes ?? ''}
              className="mt-1 w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1.5 text-sm"
            />
          </div>

          <div className="md:col-span-3">
            <button
              type="submit"
              className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-4 py-2 text-sm font-medium text-[color:var(--color-background)]"
            >
              Save settings
            </button>
          </div>
        </form>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
          Labor categories ({summary.laborCategories.length})
        </h2>

        {summary.laborCategories.length > 0 && (
          <div className="mb-4 overflow-hidden rounded-[var(--radius-lg)] border border-[color:var(--color-border)]">
            <table className="w-full text-left text-sm">
              <thead className="bg-[color:var(--color-muted)]/40 text-xs uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
                <tr>
                  <th className="px-3 py-2">Title</th>
                  <th className="px-3 py-2">Type</th>
                  <th className="px-3 py-2 text-right">Direct rate</th>
                  <th className="px-3 py-2 text-right">Loaded rate</th>
                  <th className="px-3 py-2 text-right">Hours/yr</th>
                  <th className="px-3 py-2 text-right">Total ({summary.periodYears}y)</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {summary.laborCategories.map((calc) => {
                  const lc = laborCategories.find((l) => l.id === calc.id);
                  if (!lc) return null;
                  return (
                    <tr
                      key={lc.id}
                      className="border-t border-[color:var(--color-border)]"
                    >
                      <td className="px-3 py-2">
                        <form action={updateLaborCategoryAction} className="flex gap-2">
                          <input type="hidden" name="pursuitId" value={pursuitId} />
                          <input type="hidden" name="laborCategoryId" value={lc.id} />
                          <input
                            name="title"
                            defaultValue={lc.title}
                            className="w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-transparent px-2 py-1 text-sm font-medium"
                          />
                          <input
                            type="hidden"
                            name="directRate"
                            value={lc.directRate ?? '0'}
                          />
                          <input
                            type="hidden"
                            name="hoursPerYear"
                            value={lc.hoursPerYear ?? 2080}
                          />
                          <input
                            type="hidden"
                            name="type"
                            value={lc.type ?? ''}
                          />
                          <button type="submit" className="text-xs underline text-[color:var(--color-muted-foreground)]">
                            Save
                          </button>
                        </form>
                      </td>
                      <td className="px-3 py-2">
                        <form action={updateLaborCategoryAction}>
                          <input type="hidden" name="pursuitId" value={pursuitId} />
                          <input type="hidden" name="laborCategoryId" value={lc.id} />
                          <input type="hidden" name="title" value={lc.title} />
                          <input type="hidden" name="directRate" value={lc.directRate ?? '0'} />
                          <input type="hidden" name="hoursPerYear" value={lc.hoursPerYear ?? 2080} />
                          <select
                            name="type"
                            defaultValue={lc.type ?? ''}
                            className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-1 py-0.5 text-xs"
                            onChange={(e) => e.currentTarget.form?.requestSubmit()}
                          >
                            <option value="">—</option>
                            <option value="key_personnel">Key personnel</option>
                            <option value="standard">Standard</option>
                          </select>
                        </form>
                      </td>
                      <td className="px-3 py-2 text-right">
                        <form action={updateLaborCategoryAction} className="flex justify-end gap-1">
                          <input type="hidden" name="pursuitId" value={pursuitId} />
                          <input type="hidden" name="laborCategoryId" value={lc.id} />
                          <input type="hidden" name="title" value={lc.title} />
                          <input type="hidden" name="hoursPerYear" value={lc.hoursPerYear ?? 2080} />
                          <input type="hidden" name="type" value={lc.type ?? ''} />
                          <input
                            name="directRate"
                            type="number"
                            step="0.01"
                            defaultValue={lc.directRate ?? '0'}
                            className="w-24 rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-transparent px-2 py-1 text-right text-sm"
                          />
                          <button type="submit" className="text-xs underline text-[color:var(--color-muted-foreground)]">
                            Save
                          </button>
                        </form>
                      </td>
                      <td className="px-3 py-2 text-right font-medium">
                        {formatMoney(calc.loadedRate, currency) ?? '—'}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <form action={updateLaborCategoryAction} className="flex justify-end gap-1">
                          <input type="hidden" name="pursuitId" value={pursuitId} />
                          <input type="hidden" name="laborCategoryId" value={lc.id} />
                          <input type="hidden" name="title" value={lc.title} />
                          <input type="hidden" name="directRate" value={lc.directRate ?? '0'} />
                          <input type="hidden" name="type" value={lc.type ?? ''} />
                          <input
                            name="hoursPerYear"
                            type="number"
                            defaultValue={lc.hoursPerYear ?? 2080}
                            className="w-20 rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-transparent px-2 py-1 text-right text-sm"
                          />
                          <button type="submit" className="text-xs underline text-[color:var(--color-muted-foreground)]">
                            Save
                          </button>
                        </form>
                      </td>
                      <td className="px-3 py-2 text-right font-semibold">
                        {formatMoney(calc.totalCost, currency) ?? '—'}
                      </td>
                      <td className="px-3 py-2">
                        <form action={removeLaborCategoryAction}>
                          <input type="hidden" name="pursuitId" value={pursuitId} />
                          <input type="hidden" name="laborCategoryId" value={lc.id} />
                          <button type="submit" className="text-xs text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-brand)]">
                            ×
                          </button>
                        </form>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <form
          action={addLaborCategoryAction}
          className="flex flex-wrap items-end gap-3 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4"
        >
          <input type="hidden" name="pursuitId" value={pursuitId} />
          <label className="flex flex-1 flex-col gap-1 text-sm">
            <span className="text-xs text-[color:var(--color-muted-foreground)]">
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
            <span className="text-xs text-[color:var(--color-muted-foreground)]">Direct rate</span>
            <input
              name="directRate"
              type="number"
              step="0.01"
              placeholder="0.00"
              className="w-28 rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-[color:var(--color-muted-foreground)]">Hours/yr</span>
            <input
              name="hoursPerYear"
              type="number"
              defaultValue={pricingModel.hoursPerFte ?? 2080}
              className="w-20 rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-[color:var(--color-muted-foreground)]">Type</span>
            <select
              name="type"
              className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-sm"
            >
              <option value="">—</option>
              <option value="key_personnel">Key personnel</option>
              <option value="standard">Standard</option>
            </select>
          </label>
          <button
            type="submit"
            className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-3 py-1.5 text-sm font-medium text-[color:var(--color-background)]"
          >
            Add
          </button>
        </form>
      </section>
    </div>
  );
}

function NumField({
  label,
  name,
  value,
  step = '1',
}: {
  label: string;
  name: string;
  value: string | number | null | undefined;
  step?: string;
}) {
  return (
    <label className="block">
      <span className="text-xs text-[color:var(--color-muted-foreground)]">{label}</span>
      <input
        name={name}
        type="number"
        step={step}
        defaultValue={value ?? ''}
        className="mt-1 w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
      />
    </label>
  );
}

function Breadcrumbs({ title }: { title: string }) {
  return (
    <nav className="mb-6 text-sm text-[color:var(--color-muted-foreground)]">
      <Link href="/pricer" className="hover:underline">
        Pricer
      </Link>
      <span> / </span>
      <span className="text-[color:var(--color-foreground)]">{title}</span>
    </nav>
  );
}

function Fact({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
        {label}
      </p>
      <p className="mt-1 text-base font-semibold">{value}</p>
      {sub && <p className="text-xs text-[color:var(--color-muted-foreground)]">{sub}</p>}
    </div>
  );
}
