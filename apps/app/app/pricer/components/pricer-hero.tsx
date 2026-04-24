import type { LaborCategory, PricingModel } from '@procur/db';
import { formatMoney } from '../../../lib/format';
import type { PricingSummary } from '../../../lib/pricer-queries';

const STRATEGY_LABEL: Record<string, string> = {
  labor_hours: 'LABOR HOURS',
  firm_fixed_price: 'FIRM FIXED PRICE',
  cost_plus: 'COST PLUS',
  time_materials: 'TIME & MATERIALS',
};

/**
 * Top hero: 5 fact pills mirroring GovDash's Pricer header.
 *   Estimated Value · Period of Performance · Labor Categories ·
 *   Contract Type · Target Fee
 *
 * Mirrors the proportions in screenshots3/Screenshot…1.26.08 PM.png.
 */
export function PricerHero({
  pricingModel,
  laborCategories,
  summary,
}: {
  pricingModel: PricingModel;
  laborCategories: LaborCategory[];
  summary: PricingSummary;
}) {
  const currency = pricingModel.currency ?? 'USD';
  const baseYears = Math.max(1, Math.ceil((pricingModel.basePeriodMonths ?? 12) / 12));
  const optionYears = pricingModel.optionYears ?? 0;
  const escalation = Number.parseFloat(pricingModel.escalationRate ?? '0') || 0;

  const keyPersonnel = laborCategories.filter((l) => l.type === 'key_personnel').length;
  const standard = laborCategories.length - keyPersonnel;

  const targetFeePct = Number.parseFloat(pricingModel.targetFeePct ?? '0') || 0;

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
      <Pill
        icon="$"
        label="Estimated Value"
        value={formatMoney(summary.totalValue, currency) ?? '—'}
        sub={
          summary.totalValueUsd && currency !== 'USD'
            ? `Weighted ≈ ${formatMoney(summary.totalValueUsd, 'USD')}`
            : `Weighted · ${formatMoney(summary.totalValue * 0.55, currency) ?? '—'} P(Win)`
        }
      />
      <Pill
        icon="📅"
        label="Period of Performance"
        value={`${summary.periodYears} Years`}
        sub={`${baseYears} base + ${optionYears} option${escalation > 0 ? ` · ${escalation.toFixed(1)}% esc.` : ''}`}
      />
      <Pill
        icon="👥"
        label="Labor Categories"
        value={laborCategories.length.toString()}
        sub={`${keyPersonnel} Key Personnel · ${standard} Standard`}
      />
      <Pill
        icon="📄"
        label="Contract Type"
        value={STRATEGY_LABEL[pricingModel.pricingStrategy] ?? pricingModel.pricingStrategy.toUpperCase()}
        sub="Pricing strategy"
      />
      <Pill
        icon="%"
        label="Target Fee"
        value={`${targetFeePct.toFixed(1)}%`}
        sub="Fee/profit on cost"
      />
    </div>
  );
}

function Pill({
  icon,
  label,
  value,
  sub,
}: {
  icon: string;
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-3">
      <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
        <span aria-hidden>{icon}</span>
        {label}
      </p>
      <p className="mt-1 text-lg font-semibold leading-tight">{value}</p>
      {sub && (
        <p className="mt-0.5 text-[11px] text-[color:var(--color-muted-foreground)]">{sub}</p>
      )}
    </div>
  );
}
