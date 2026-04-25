'use client';

import { useMemo, useState } from 'react';
import type { PricingModel } from '@procur/db';
import { buildIndirectBuildup } from '../../../lib/pricer-math';
import { updatePricingModelAction } from '../actions';

/**
 * Indirect Rates tab — interactive client component.
 *
 * Three sliders (Fringe / Overhead / G&A) on the LEFT update the Total
 * Cost Buildup preview on the RIGHT in real time. Both Multiplicative
 * and Additive modes are computed and the user can flip between them
 * with the segmented toggle. Hitting "Save Rates" persists via the
 * existing updatePricingModelAction (which we already wired).
 *
 * directLabor is passed in from the server so the buildup math is
 * accurate against the current labor categories without re-fetching.
 *
 * Mirrors GovDash's Indirect Rate Modeling tab in
 * Screenshots…1.26.45 / 1.26.49 / 1.26.54 / 1.26.58 PM.
 */
export function IndirectTab({
  pursuitId,
  pricingModel,
  directLabor,
  currency,
}: {
  pursuitId: string;
  pricingModel: PricingModel;
  directLabor: number;
  currency: string;
}) {
  const initial = {
    fringe: Number.parseFloat(pricingModel.fringeRate ?? '0') || 0,
    overhead: Number.parseFloat(pricingModel.overheadRate ?? '0') || 0,
    ga: Number.parseFloat(pricingModel.gaRate ?? '0') || 0,
  };
  const [fringe, setFringe] = useState(initial.fringe);
  const [overhead, setOverhead] = useState(initial.overhead);
  const [ga, setGa] = useState(initial.ga);
  // Mode is persisted on the pricing model row (column added in
  // migration 0017). Initial state mirrors the saved value, so flipping
  // the toggle marks the form dirty and the saved column reflects what
  // the user last clicked Save with.
  const [mode, setMode] = useState<'multiplicative' | 'additive'>(
    pricingModel.indirectRateMode,
  );

  const buildup = useMemo(
    () =>
      buildIndirectBuildup({
        directLabor,
        fringePct: fringe,
        overheadPct: overhead,
        gaPct: ga,
        mode,
      }),
    [directLabor, fringe, overhead, ga, mode],
  );

  const altBuildup = useMemo(
    () =>
      buildIndirectBuildup({
        directLabor,
        fringePct: fringe,
        overheadPct: overhead,
        gaPct: ga,
        mode: mode === 'multiplicative' ? 'additive' : 'multiplicative',
      }),
    [directLabor, fringe, overhead, ga, mode],
  );

  const wrap = directLabor > 0 ? buildup.totalLoaded / directLabor : 1;
  const dirty =
    fringe !== initial.fringe ||
    overhead !== initial.overhead ||
    ga !== initial.ga ||
    mode !== pricingModel.indirectRateMode;

  return (
    <div className="grid gap-4 md:grid-cols-[3fr_2fr]">
      {/* Sliders */}
      <section className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-5">
        <header className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold">Indirect Rate Modeling</h2>
            <p className="mt-0.5 text-xs text-[color:var(--color-muted-foreground)]">
              Drag a slider to model pricing scenarios. The buildup recomputes instantly.
            </p>
          </div>
          <ModeToggle mode={mode} onChange={setMode} />
        </header>

        <RateSlider
          label="Fringe Benefits"
          appliedTo={mode === 'multiplicative' ? 'Direct Labor' : 'Direct Labor'}
          value={fringe}
          onChange={setFringe}
          typical="Typical: 25% – 40%"
        />
        <RateSlider
          label="Overhead"
          appliedTo={mode === 'multiplicative' ? 'Direct Labor + Fringe' : 'Direct Labor'}
          value={overhead}
          onChange={setOverhead}
          typical="Typical: 30% – 70%"
        />
        <RateSlider
          label="G&A"
          appliedTo={mode === 'multiplicative' ? 'Total burdened' : 'Direct Labor'}
          value={ga}
          onChange={setGa}
          typical="Typical: 5% – 15%"
        />

        {/* Save form — server action consumes the slider values via hidden inputs */}
        <form action={updatePricingModelAction} className="mt-5 flex items-center justify-between gap-3">
          <input type="hidden" name="pursuitId" value={pursuitId} />
          <input type="hidden" name="fringeRate" value={fringe} />
          <input type="hidden" name="overheadRate" value={overhead} />
          <input type="hidden" name="gaRate" value={ga} />
          <input type="hidden" name="indirectRateMode" value={mode} />
          {/* Preserve other fields the action expects so we don't blank them */}
          <input type="hidden" name="basePeriodMonths" value={pricingModel.basePeriodMonths ?? 12} />
          <input type="hidden" name="optionYears" value={pricingModel.optionYears ?? 0} />
          <input type="hidden" name="escalationRate" value={pricingModel.escalationRate ?? '0'} />
          <input type="hidden" name="pricingStrategy" value={pricingModel.pricingStrategy} />
          <input type="hidden" name="hoursPerFte" value={pricingModel.hoursPerFte ?? 2080} />
          <input type="hidden" name="targetFeePct" value={pricingModel.targetFeePct ?? '0'} />
          <input type="hidden" name="governmentEstimate" value={pricingModel.governmentEstimate ?? ''} />
          <input type="hidden" name="ceilingValue" value={pricingModel.ceilingValue ?? ''} />
          <input type="hidden" name="currency" value={pricingModel.currency ?? 'USD'} />
          <input type="hidden" name="fxRateToUsd" value={pricingModel.fxRateToUsd ?? ''} />
          <input type="hidden" name="notes" value={pricingModel.notes ?? ''} />

          <p className="text-xs text-[color:var(--color-muted-foreground)]">
            Wrap rate:{' '}
            <span className="font-semibold text-[color:var(--color-foreground)]">
              {wrap.toFixed(4)}x
            </span>
            {dirty && <span className="ml-2 text-amber-600">(unsaved)</span>}
          </p>
          <button
            type="submit"
            disabled={!dirty}
            className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-4 py-2 text-sm font-medium text-[color:var(--color-background)] disabled:opacity-40"
          >
            Save Rates
          </button>
        </form>
      </section>

      {/* Live Total Cost Buildup */}
      <section className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-5">
        <h2 className="mb-3 text-sm font-semibold">Total Cost Buildup</h2>
        <ul className="space-y-1.5 text-sm">
          {buildup.layers.map((layer, i) => (
            <li
              key={i}
              className={`flex items-baseline justify-between border-b border-[color:var(--color-border)]/50 py-1.5 ${
                i === 0 ? 'font-medium' : ''
              }`}
            >
              <div>
                <p className={i === 0 ? 'font-medium' : ''}>{layer.label}</p>
                {i > 0 && (
                  <p className="text-[10px] text-[color:var(--color-muted-foreground)]">
                    {layer.ratePct.toFixed(1)}% of {layer.appliedTo}
                  </p>
                )}
              </div>
              <p className="font-mono text-sm">{fmt(layer.amount, currency)}</p>
            </li>
          ))}
          <li className="flex items-baseline justify-between border-t-2 border-[color:var(--color-foreground)] py-2 text-sm font-semibold">
            <p>Total Loaded Cost</p>
            <p className="font-mono">{fmt(buildup.totalLoaded, currency)}</p>
          </li>
        </ul>
        <p className="mt-3 text-[11px] text-[color:var(--color-muted-foreground)]">
          {mode === 'multiplicative'
            ? 'Multiplicative: each rate compounds on the previous total. Realistic for stacked indirect cost pools (most US-federal contracts).'
            : 'Additive: each rate applied to direct labor independently. Useful for quick approximations and for contracts that prescribe additive treatment.'}
        </p>
        <p className="mt-3 rounded-[var(--radius-sm)] bg-[color:var(--color-muted)]/40 p-2 text-[11px] text-[color:var(--color-muted-foreground)]">
          {mode === 'multiplicative' ? 'Additive' : 'Multiplicative'} would yield{' '}
          <span className="font-medium">{fmt(altBuildup.totalLoaded, currency)}</span> · diff{' '}
          <span
            className={`font-medium ${altBuildup.totalLoaded > buildup.totalLoaded ? 'text-red-600' : 'text-emerald-600'}`}
          >
            {fmtSigned(altBuildup.totalLoaded - buildup.totalLoaded, currency)}
          </span>
        </p>
      </section>
    </div>
  );
}

function ModeToggle({
  mode,
  onChange,
}: {
  mode: 'multiplicative' | 'additive';
  onChange: (m: 'multiplicative' | 'additive') => void;
}) {
  return (
    <div className="inline-flex rounded-[var(--radius-sm)] border border-[color:var(--color-border)] p-0.5 text-xs">
      <button
        type="button"
        onClick={() => onChange('multiplicative')}
        className={`rounded-[var(--radius-sm)] px-2.5 py-1 ${
          mode === 'multiplicative'
            ? 'bg-[color:var(--color-foreground)] text-[color:var(--color-background)]'
            : 'text-[color:var(--color-muted-foreground)]'
        }`}
      >
        Multiplicative
      </button>
      <button
        type="button"
        onClick={() => onChange('additive')}
        className={`rounded-[var(--radius-sm)] px-2.5 py-1 ${
          mode === 'additive'
            ? 'bg-[color:var(--color-foreground)] text-[color:var(--color-background)]'
            : 'text-[color:var(--color-muted-foreground)]'
        }`}
      >
        Additive
      </button>
    </div>
  );
}

function RateSlider({
  label,
  appliedTo,
  value,
  onChange,
  typical,
}: {
  label: string;
  appliedTo: string;
  value: number;
  onChange: (v: number) => void;
  typical?: string;
}) {
  return (
    <div className="mb-4">
      <div className="mb-1 flex items-baseline justify-between">
        <div>
          <p className="text-sm font-medium">{label}</p>
          <p className="text-[10px] text-[color:var(--color-muted-foreground)]">
            Applied to: {appliedTo}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="number"
            value={value}
            min={0}
            max={200}
            step={0.5}
            onChange={(e) => onChange(Math.max(0, Math.min(200, Number(e.target.value) || 0)))}
            className="w-20 rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-right text-sm"
          />
          <span className="text-sm text-[color:var(--color-muted-foreground)]">%</span>
        </div>
      </div>
      <input
        type="range"
        min={0}
        max={200}
        step={0.5}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1.5 w-full appearance-none rounded-full bg-[color:var(--color-muted)]/60 accent-[color:var(--color-foreground)]"
      />
      {typical && (
        <p className="mt-1 text-[10px] text-[color:var(--color-muted-foreground)]">{typical}</p>
      )}
    </div>
  );
}

function fmt(amount: number, currency: string): string {
  // Locale undefined → browser picks; currency comes from the pricing
  // model. This was 'en-US' previously, which forced 1,234.56 grouping
  // even for users in pt-BR / es-CO / etc. tenants.
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(amount);
}

function fmtSigned(amount: number, currency: string): string {
  const sign = amount >= 0 ? '+' : '−';
  return `${sign}${fmt(Math.abs(amount), currency)}`;
}
