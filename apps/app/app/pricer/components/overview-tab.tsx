import type { PricingModel } from '@procur/db';
import { formatMoney } from '../../../lib/format';
import type { PricingSummary } from '../../../lib/pricer-queries';
import { updatePricingModelAction } from '../actions';

const STRATEGY_LABEL: Record<string, string> = {
  labor_hours: 'Labor hours',
  firm_fixed_price: 'Firm fixed price',
  cost_plus: 'Cost plus',
  time_materials: 'Time & materials',
};

/**
 * Overview tab: two-column form mirroring GovDash's Pricer Overview.
 * LEFT  = Contract Information (strategy, periods, escalation, hours/FTE)
 * RIGHT = Value Summary (govt estimate, ceiling, target, fee, weighted)
 *
 * Both columns submit to the same updatePricingModelAction so saving from
 * either side persists everything in one round-trip.
 */
export function OverviewTab({
  pricingModel,
  summary,
  pursuitId,
}: {
  pricingModel: PricingModel;
  summary: PricingSummary;
  pursuitId: string;
}) {
  const currency = pricingModel.currency ?? 'USD';
  return (
    <form
      action={updatePricingModelAction}
      className="grid gap-4 md:grid-cols-2"
    >
      <input type="hidden" name="pursuitId" value={pursuitId} />

      <Panel title="Contract Information">
        <Grid>
          <Field label="Pricing strategy">
            <select
              name="pricingStrategy"
              defaultValue={pricingModel.pricingStrategy}
              className="w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
            >
              {Object.entries(STRATEGY_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <NumField
            label="Base period (months)"
            name="basePeriodMonths"
            value={pricingModel.basePeriodMonths ?? 12}
          />
          <NumField label="Option years" name="optionYears" value={pricingModel.optionYears ?? 0} />
          <Field label="Total period">
            <p className="text-sm font-medium">
              {summary.periodYears} year{summary.periodYears === 1 ? '' : 's'}
            </p>
          </Field>
          <NumField
            label="Escalation %/yr"
            name="escalationRate"
            value={pricingModel.escalationRate ?? '0'}
            step="0.1"
          />
          <NumField
            label="Hours / FTE"
            name="hoursPerFte"
            value={pricingModel.hoursPerFte ?? 2080}
          />
          <Field label="Currency">
            <input
              name="currency"
              defaultValue={currency}
              maxLength={3}
              className="w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm uppercase"
            />
          </Field>
          <NumField
            label="FX to USD"
            name="fxRateToUsd"
            value={pricingModel.fxRateToUsd ?? ''}
            step="0.0001"
          />
        </Grid>
      </Panel>

      <Panel title="Value Summary">
        <Grid>
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
          <Field label={`Target value (${currency})`}>
            <p className="text-sm font-semibold">
              {formatMoney(summary.totalValue, currency) ?? '—'}
            </p>
          </Field>
          <NumField
            label="Target fee %"
            name="targetFeePct"
            value={pricingModel.targetFeePct ?? '0'}
            step="0.1"
          />
          <Field label="Wrap rate">
            <p className="text-sm font-semibold">{summary.wrapRate.toFixed(4)}x</p>
          </Field>
          <Field label="Weighted value">
            <p className="text-sm font-semibold">
              {summary.totalValueUsd && currency !== 'USD'
                ? `${formatMoney(summary.totalValueUsd, 'USD')}`
                : `${formatMoney(summary.totalValue, currency) ?? '—'}`}
            </p>
          </Field>
        </Grid>
      </Panel>

      <div className="md:col-span-2">
        <Panel title="Notes">
          <textarea
            name="notes"
            rows={3}
            defaultValue={pricingModel.notes ?? ''}
            className="w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1.5 text-sm"
            placeholder="Pricing strategy notes, assumptions, exclusions…"
          />
        </Panel>
      </div>

      <div className="md:col-span-2 flex justify-end">
        <button
          type="submit"
          className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-4 py-2 text-sm font-medium text-[color:var(--color-background)]"
        >
          Save Overview
        </button>
      </div>
    </form>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-5">
      <h2 className="mb-3 text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-3 sm:grid-cols-2">{children}</div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1 text-[11px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
        {label}
      </p>
      {children}
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
    <Field label={label}>
      <input
        name={name}
        type="number"
        step={step}
        defaultValue={value ?? ''}
        className="w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
      />
    </Field>
  );
}
