'use client';

/**
 * Inline renderer for `compose_deal_economics` tool results.
 *
 * The tool returns the resolved FuelDealInputs alongside the calculator
 * output, which lets us re-run the calculator client-side as the user
 * adjusts the sliders below — no extra round-trip to the assistant.
 *
 * The calculator is a pure function (no I/O, no server-only imports)
 * so it's safe to import into a client component via the package's
 * `./calculator` subpath.
 */
import { useMemo, useState } from 'react';
import {
  calculateFuelDeal,
  type FuelDealInputs,
  type FuelDealResults,
  type DealRecommendation,
  type DealWarningSeverity,
} from '@procur/pricing/calculator';

type Benchmark = {
  slug: string;
  asOf: string;
  pricePerUsg: number;
  pricePerBbl: number;
  usedAsProductCost: boolean;
};

export type DealEconomicsOutput = {
  kind: 'deal_economics';
  inputs: FuelDealInputs;
  results: FuelDealResults;
  benchmark: Benchmark | null;
};

export function isDealEconomicsOutput(
  output: unknown,
): output is DealEconomicsOutput {
  if (!output || typeof output !== 'object') return false;
  const o = output as Record<string, unknown>;
  return (
    o.kind === 'deal_economics' &&
    typeof o.inputs === 'object' &&
    o.inputs !== null &&
    typeof o.results === 'object' &&
    o.results !== null
  );
}

/**
 * Sliders allow the user to overlay assumption changes on top of the
 * server-computed baseline. Stored as multiplicative deltas so a 0%
 * adjustment is the unmistakable "show me the baseline" anchor.
 */
type Adjustments = {
  sellPriceDeltaPct: number; // ±50%
  freightDeltaPct: number; // ±100%
  demurrageDaysOverride: number | null; // null = use baseline
};

const ZERO_ADJUSTMENTS: Adjustments = {
  sellPriceDeltaPct: 0,
  freightDeltaPct: 0,
  demurrageDaysOverride: null,
};

export function DealEconomicsCard({ output }: { output: DealEconomicsOutput }) {
  const [adj, setAdj] = useState<Adjustments>(ZERO_ADJUSTMENTS);

  const adjustedInputs = useMemo(
    () => applyAdjustments(output.inputs, adj),
    [output.inputs, adj],
  );
  const results = useMemo(
    () => calculateFuelDeal(adjustedInputs),
    [adjustedInputs],
  );

  const baselineRecommendation = output.results.scorecard.recommendation;
  const adjusted = !isZero(adj);

  return (
    <div className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)]">
      <Header
        inputs={adjustedInputs}
        results={results}
        baselineRecommendation={baselineRecommendation}
        adjusted={adjusted}
        onReset={() => setAdj(ZERO_ADJUSTMENTS)}
      />
      <Headline inputs={adjustedInputs} results={results} benchmark={output.benchmark} />
      <Sliders
        baseline={output.inputs}
        adj={adj}
        setAdj={setAdj}
      />
      <Footer inputs={adjustedInputs} results={results} />
    </div>
  );
}

function Header({
  inputs,
  results,
  baselineRecommendation,
  adjusted,
  onReset,
}: {
  inputs: FuelDealInputs;
  results: FuelDealResults;
  baselineRecommendation: DealRecommendation;
  adjusted: boolean;
  onReset: () => void;
}) {
  const rec = results.scorecard.recommendation;
  return (
    <div className="flex items-start justify-between gap-2 border-b border-[color:var(--color-border)] px-3 py-2">
      <div>
        <div className="text-xs font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
          Deal economics
        </div>
        <div className="text-sm">
          {productLabel(inputs.product)} · {fmtVolume(inputs.volumeUsg)} ·{' '}
          {inputs.incoterm.toUpperCase()}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <RecommendationChip rec={rec} />
        {adjusted && (
          <>
            <span
              className="text-[10px] text-[color:var(--color-muted-foreground)]"
              title={`Baseline: ${baselineRecommendation}`}
            >
              adjusted
            </span>
            <button
              type="button"
              onClick={onReset}
              className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-0.5 text-[10px] hover:border-[color:var(--color-foreground)]"
            >
              Reset
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function Headline({
  inputs,
  results,
  benchmark,
}: {
  inputs: FuelDealInputs;
  results: FuelDealResults;
  benchmark: Benchmark | null;
}) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-1 px-3 py-2 text-sm tabular-nums">
      <Metric
        label="Net margin"
        value={`$${results.perUsg.netMargin.toFixed(3)}/USG`}
        sub={`Gross ${(results.totals.grossMarginPct * 100).toFixed(1)}%`}
      />
      <Metric
        label="EBITDA"
        value={fmtMoney(results.totals.ebitdaUsd)}
        sub={`${(results.totals.ebitdaMarginPct * 100).toFixed(1)}% of revenue`}
      />
      <Metric
        label="Revenue"
        value={fmtMoney(results.totals.revenueUsd)}
        sub={`${fmtVolume(inputs.volumeUsg)} × $${inputs.sellPricePerUsg.toFixed(3)}`}
      />
      <Metric
        label="Peak cash"
        value={fmtMoney(results.cashflow.peakExposureUsd)}
        sub={
          results.cashflow.daysToBreakEven > 0
            ? `${results.cashflow.daysToBreakEven}d to break-even`
            : undefined
        }
      />
      {benchmark && (
        <div className="col-span-2 mt-1 border-t border-[color:var(--color-border)] pt-1 text-[11px] text-[color:var(--color-muted-foreground)]">
          {benchmark.slug} spot ${benchmark.pricePerUsg.toFixed(3)}/USG · ${benchmark.pricePerBbl.toFixed(2)}/bbl ({benchmark.asOf})
          {benchmark.usedAsProductCost && ' · used as product cost'}
        </div>
      )}
    </div>
  );
}

function Sliders({
  baseline,
  adj,
  setAdj,
}: {
  baseline: FuelDealInputs;
  adj: Adjustments;
  setAdj: React.Dispatch<React.SetStateAction<Adjustments>>;
}) {
  const sellPrice = baseline.sellPricePerUsg * (1 + adj.sellPriceDeltaPct / 100);
  const freight = baseline.freightPerUsg * (1 + adj.freightDeltaPct / 100);
  const demurrageDays =
    adj.demurrageDaysOverride ?? baseline.vessel?.demurrageEstimatedDays ?? 0;
  const hasVessel = baseline.vessel != null;
  return (
    <div className="border-t border-[color:var(--color-border)] px-3 py-2">
      <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
        Adjust assumptions
      </div>
      <Slider
        label="Sell price"
        value={`$${sellPrice.toFixed(3)}/USG`}
        delta={adj.sellPriceDeltaPct}
        min={-30}
        max={30}
        step={0.5}
        onChange={(v) => setAdj((a) => ({ ...a, sellPriceDeltaPct: v }))}
      />
      <Slider
        label="Freight"
        value={`$${freight.toFixed(3)}/USG`}
        delta={adj.freightDeltaPct}
        min={-50}
        max={100}
        step={1}
        onChange={(v) => setAdj((a) => ({ ...a, freightDeltaPct: v }))}
        disabled={baseline.freightPerUsg <= 0}
        disabledReason="No baseline freight to scale"
      />
      <SliderRaw
        label="Demurrage days"
        value={`${demurrageDays.toFixed(1)} d`}
        raw={demurrageDays}
        min={0}
        max={14}
        step={0.5}
        onChange={(v) =>
          setAdj((a) => ({
            ...a,
            demurrageDaysOverride: v,
          }))
        }
        disabled={!hasVessel}
        disabledReason="No vessel/demurrage in baseline"
      />
    </div>
  );
}

function Slider({
  label,
  value,
  delta,
  min,
  max,
  step,
  onChange,
  disabled,
  disabledReason,
}: {
  label: string;
  value: string;
  delta: number;
  min: number;
  max: number;
  step: number;
  onChange: (deltaPct: number) => void;
  disabled?: boolean;
  disabledReason?: string;
}) {
  return (
    <div className="grid grid-cols-[80px_1fr_72px] items-center gap-2 py-0.5 text-[11px] tabular-nums">
      <label className="text-[color:var(--color-muted-foreground)]" title={disabled ? disabledReason : undefined}>
        {label}
      </label>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={delta}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-[color:var(--color-foreground)] disabled:opacity-30"
      />
      <div className="text-right">
        {value}{' '}
        {!disabled && delta !== 0 && (
          <span className="text-[10px] text-[color:var(--color-muted-foreground)]">
            ({delta > 0 ? '+' : ''}{delta.toFixed(0)}%)
          </span>
        )}
      </div>
    </div>
  );
}

function SliderRaw({
  label,
  value,
  raw,
  min,
  max,
  step,
  onChange,
  disabled,
  disabledReason,
}: {
  label: string;
  value: string;
  raw: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  disabled?: boolean;
  disabledReason?: string;
}) {
  return (
    <div className="grid grid-cols-[80px_1fr_72px] items-center gap-2 py-0.5 text-[11px] tabular-nums">
      <label
        className="text-[color:var(--color-muted-foreground)]"
        title={disabled ? disabledReason : undefined}
      >
        {label}
      </label>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={raw}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-[color:var(--color-foreground)] disabled:opacity-30"
      />
      <div className="text-right">{value}</div>
    </div>
  );
}

function Footer({
  inputs,
  results,
}: {
  inputs: FuelDealInputs;
  results: FuelDealResults;
}) {
  const warnings = results.warnings;
  const breakeven = results.breakeven;
  return (
    <div className="border-t border-[color:var(--color-border)] px-3 py-2">
      {warnings.length > 0 && (
        <div className="mb-2 flex flex-col gap-1">
          {warnings.slice(0, 4).map((w) => (
            <div
              key={`${w.code}-${w.affectedField}`}
              className={`flex items-start gap-1.5 rounded-[var(--radius-sm)] border px-2 py-1 text-[11px] ${severityClass(w.severity)}`}
            >
              <span aria-hidden>{severityIcon(w.severity)}</span>
              <div className="flex-1">
                <div className="font-medium">{w.code.replaceAll('.', ' · ')}</div>
                <div className="text-[10px] opacity-80">{w.message}</div>
              </div>
            </div>
          ))}
          {warnings.length > 4 && (
            <div className="text-[10px] text-[color:var(--color-muted-foreground)]">
              +{warnings.length - 4} more warnings
            </div>
          )}
        </div>
      )}
      <details className="text-[11px]">
        <summary className="cursor-pointer text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)] [&::-webkit-details-marker]:hidden">
          Breakevens & cost stack ▾
        </summary>
        <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 tabular-nums">
          <Row k="Min sell price" v={`$${breakeven.sellPricePerUsg.toFixed(3)}/USG`} />
          <Row k="Max product cost" v={`$${breakeven.productCostMaximum.toFixed(3)}/USG`} />
          {breakeven.freightPerUsgMaximum > 0 && (
            <Row k="Max freight" v={`$${breakeven.freightPerUsgMaximum.toFixed(3)}/USG`} />
          )}
          <div className="col-span-2 mt-1 border-t border-[color:var(--color-border)] pt-1" />
          <Row k="Sell" v={`$${inputs.sellPricePerUsg.toFixed(3)}`} />
          <Row k="Total cost" v={`$${results.perUsg.totalVariableCost.toFixed(3)}`} />
          <Row k="Product" v={`$${inputs.productCostPerUsg.toFixed(3)}`} />
          <Row k="Freight" v={`$${results.perUsg.freight.toFixed(3)}`} />
          <Row k="Insurance" v={`$${results.perUsg.insurance.toFixed(4)}`} />
          {results.perUsg.dischargeHandling > 0 && (
            <Row k="Discharge" v={`$${results.perUsg.dischargeHandling.toFixed(3)}`} />
          )}
          {results.perUsg.tradeFinance > 0 && (
            <Row k="Finance" v={`$${results.perUsg.tradeFinance.toFixed(3)}`} />
          )}
        </div>
      </details>
    </div>
  );
}

function Metric({
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
      <div className="text-[10px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
        {label}
      </div>
      <div className="font-semibold">{value}</div>
      {sub && <div className="text-[10px] text-[color:var(--color-muted-foreground)]">{sub}</div>}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <>
      <span className="text-[color:var(--color-muted-foreground)]">{k}</span>
      <span className="text-right">{v}</span>
    </>
  );
}

function RecommendationChip({ rec }: { rec: DealRecommendation }) {
  const map: Record<DealRecommendation, { label: string; cls: string }> = {
    strong: {
      label: 'strong',
      cls: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-700',
    },
    acceptable: {
      label: 'acceptable',
      cls: 'border-emerald-500/40 bg-emerald-500/5 text-emerald-700',
    },
    marginal: {
      label: 'marginal',
      cls: 'border-amber-500/50 bg-amber-500/10 text-amber-800',
    },
    do_not_proceed: {
      label: 'do not proceed',
      cls: 'border-red-500/50 bg-red-500/10 text-red-700',
    },
  };
  const m = map[rec];
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${m.cls}`}
    >
      {m.label}
    </span>
  );
}

function severityClass(s: DealWarningSeverity): string {
  switch (s) {
    case 'critical':
      return 'border-red-500/40 bg-red-500/10 text-red-700';
    case 'caution':
      return 'border-amber-500/40 bg-amber-500/10 text-amber-800';
    default:
      return 'border-[color:var(--color-border)] bg-[color:var(--color-muted)]/30 text-[color:var(--color-muted-foreground)]';
  }
}

function severityIcon(s: DealWarningSeverity): string {
  switch (s) {
    case 'critical':
      return '■';
    case 'caution':
      return '▲';
    default:
      return '·';
  }
}

function applyAdjustments(base: FuelDealInputs, adj: Adjustments): FuelDealInputs {
  const next: FuelDealInputs = {
    ...base,
    sellPricePerUsg: base.sellPricePerUsg * (1 + adj.sellPriceDeltaPct / 100),
    freightPerUsg: base.freightPerUsg * (1 + adj.freightDeltaPct / 100),
  };
  if (adj.demurrageDaysOverride != null && base.vessel) {
    next.vessel = {
      ...base.vessel,
      demurrageEstimatedDays: adj.demurrageDaysOverride,
    };
  }
  return next;
}

function isZero(adj: Adjustments): boolean {
  return (
    adj.sellPriceDeltaPct === 0 &&
    adj.freightDeltaPct === 0 &&
    adj.demurrageDaysOverride === null
  );
}

function fmtMoney(n: number): string {
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}k`;
  return `${sign}$${abs.toFixed(0)}`;
}

function fmtVolume(usg: number): string {
  if (usg >= 1_000_000) return `${(usg / 1_000_000).toFixed(2)}M USG`;
  if (usg >= 1_000) return `${(usg / 1_000).toFixed(0)}k USG`;
  return `${usg.toFixed(0)} USG`;
}

function productLabel(p: FuelDealInputs['product']): string {
  return p.replace(/_/g, ' ').toUpperCase();
}
