import Link from 'next/link';
import { requireCompany } from '@procur/auth';
import {
  buildContractReport,
  isMeasure,
  isSliceBy,
  MEASURE_LABEL,
  MEASURES,
  SLICE_BY_LABEL,
  SLICE_BYS,
  type Measure,
  type ReportCell,
  type ReportResult,
  type SliceBy,
} from '../../../lib/contract-reports';

export const dynamic = 'force-dynamic';

type SearchParams = {
  measure?: string;
  sliceBy?: string;
  segmentBy?: string;
};

export default async function ContractReportsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const measure: Measure = isMeasure(sp.measure) ? sp.measure : 'total_value';
  const sliceBy: SliceBy = isSliceBy(sp.sliceBy) ? sp.sliceBy : 'jurisdiction';
  const segmentBy: SliceBy | null =
    sp.segmentBy && sp.segmentBy !== '' && isSliceBy(sp.segmentBy) ? sp.segmentBy : null;

  const { company } = await requireCompany();
  const report = await buildContractReport(company.id, measure, sliceBy, segmentBy);

  return (
    <div className="mx-auto max-w-7xl px-6 py-6">
      <nav className="mb-3 text-xs text-[color:var(--color-muted-foreground)]">
        <Link href="/contract" className="hover:underline">
          Contract
        </Link>
        <span> / </span>
        <span className="text-[color:var(--color-foreground)]">Reports</span>
      </nav>

      <header className="mb-5">
        <h1 className="text-xl font-semibold">Contract reports</h1>
        <p className="mt-0.5 text-xs text-[color:var(--color-muted-foreground)]">
          Slice the inventory across jurisdiction, agency, status, tier, award year,
          value bucket, or currency. Pick a measure (count, total USD, average USD)
          and an optional segment to break each bar down further.
        </p>
      </header>

      {/* Controls */}
      <Controls measure={measure} sliceBy={sliceBy} segmentBy={segmentBy} />

      {/* Summary */}
      <SummaryStrip report={report} />

      {/* Chart + table */}
      <div className="mt-5 grid gap-5 lg:grid-cols-[1fr_24rem]">
        <BarChart report={report} />
        <BreakdownTable report={report} />
      </div>
    </div>
  );
}

function Controls({
  measure,
  sliceBy,
  segmentBy,
}: {
  measure: Measure;
  sliceBy: SliceBy;
  segmentBy: SliceBy | null;
}) {
  return (
    <form
      method="GET"
      className="grid gap-3 rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-4 sm:grid-cols-[1fr_1fr_1fr_auto]"
    >
      <Field label="Measure">
        <select
          name="measure"
          defaultValue={measure}
          className="w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
        >
          {MEASURES.map((m) => (
            <option key={m} value={m}>
              {MEASURE_LABEL[m]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Slice by">
        <select
          name="sliceBy"
          defaultValue={sliceBy}
          className="w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
        >
          {SLICE_BYS.map((s) => (
            <option key={s} value={s}>
              {SLICE_BY_LABEL[s]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Segment by (optional)">
        <select
          name="segmentBy"
          defaultValue={segmentBy ?? ''}
          className="w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
        >
          <option value="">— None —</option>
          {SLICE_BYS.map((s) => (
            <option key={s} value={s} disabled={s === sliceBy}>
              {SLICE_BY_LABEL[s]}
            </option>
          ))}
        </select>
      </Field>
      <div className="flex items-end">
        <button
          type="submit"
          className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-4 py-1.5 text-sm font-medium text-[color:var(--color-background)]"
        >
          Apply
        </button>
      </div>
    </form>
  );
}

function SummaryStrip({ report }: { report: ReportResult }) {
  const isCount = report.measure === 'count';
  return (
    <section className="mt-3 grid gap-3 rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-4 sm:grid-cols-3">
      <Stat label={MEASURE_LABEL[report.measure]} value={fmtMeasure(report.total, isCount)} />
      <Stat label="Slice" value={SLICE_BY_LABEL[report.sliceBy]} />
      <Stat
        label="Segment"
        value={report.segmentBy ? SLICE_BY_LABEL[report.segmentBy] : '—'}
      />
    </section>
  );
}

function BarChart({ report }: { report: ReportResult }) {
  const isCount = report.measure === 'count';

  if (report.cells.length === 0) {
    return (
      <section className="rounded-[var(--radius-md)] border border-dashed border-[color:var(--color-border)] p-10 text-center text-sm text-[color:var(--color-muted-foreground)]">
        No contracts to chart yet.
      </section>
    );
  }

  // Cap to top 12 bars for legibility; the full breakdown still appears in the table.
  const visible = report.cells.slice(0, 12);
  const maxValue = Math.max(...visible.map((c) => c.measure), 1);

  // Generate one stable hue per segment label so adjacent bars match across rows.
  const SEGMENT_HUES = ['#000734', '#1d4ed8', '#9333ea', '#15803d', '#b45309', '#be123c', '#0f766e', '#7c3aed'];
  const segmentColor = (label: string): string => {
    const idx = report.segmentLabels.indexOf(label);
    return SEGMENT_HUES[idx % SEGMENT_HUES.length] ?? '#000734';
  };

  return (
    <section className="overflow-hidden rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-4">
      <h2 className="mb-3 text-sm font-semibold">
        {MEASURE_LABEL[report.measure]} by {SLICE_BY_LABEL[report.sliceBy]}
        {report.segmentBy ? <span className="text-[color:var(--color-muted-foreground)]"> · segmented by {SLICE_BY_LABEL[report.segmentBy]}</span> : null}
      </h2>

      <div className="space-y-2">
        {visible.map((cell) => (
          <BarRow
            key={cell.label}
            cell={cell}
            maxValue={maxValue}
            segmentBy={report.segmentBy}
            segmentColor={segmentColor}
            isCount={isCount}
          />
        ))}
      </div>

      {report.segmentBy && report.segmentLabels.length > 0 && (
        <ul className="mt-4 flex flex-wrap gap-3 border-t border-[color:var(--color-border)] pt-3 text-[11px]">
          {report.segmentLabels.map((s) => (
            <li key={s} className="flex items-center gap-1.5">
              <span
                aria-hidden
                className="h-2.5 w-2.5 rounded-sm"
                style={{ background: segmentColor(s) }}
              />
              <span className="text-[color:var(--color-muted-foreground)]">{s}</span>
            </li>
          ))}
        </ul>
      )}

      {report.cells.length > 12 && (
        <p className="mt-3 text-[11px] text-[color:var(--color-muted-foreground)]">
          Showing top 12 of {report.cells.length} buckets. Full list in the table →
        </p>
      )}
    </section>
  );
}

function BarRow({
  cell,
  maxValue,
  segmentBy,
  segmentColor,
  isCount,
}: {
  cell: ReportCell;
  maxValue: number;
  segmentBy: SliceBy | null;
  segmentColor: (label: string) => string;
  isCount: boolean;
}) {
  const widthPct = (cell.measure / maxValue) * 100;
  const segmentEntries = Object.entries(cell.segments ?? {}).sort((a, b) => b[1] - a[1]);
  const segmentTotal = segmentEntries.reduce((acc, [, v]) => acc + v, 0) || 1;

  return (
    <div className="grid items-center gap-3 grid-cols-[10rem_1fr_5.5rem]">
      <span className="truncate text-xs" title={cell.label}>
        {cell.label}
      </span>
      <div className="relative h-5 rounded-sm bg-[color:var(--color-muted)]/40">
        <div
          className="absolute inset-y-0 left-0 flex overflow-hidden rounded-sm"
          style={{ width: `${widthPct}%` }}
        >
          {segmentBy && segmentEntries.length > 0 ? (
            segmentEntries.map(([label, v]) => (
              <div
                key={label}
                title={`${label}: ${isCount ? v.toString() : fmtUsd(v)}`}
                style={{
                  width: `${(v / segmentTotal) * 100}%`,
                  background: segmentColor(label),
                }}
              />
            ))
          ) : (
            <div className="w-full bg-[#000734]" />
          )}
        </div>
      </div>
      <span className="text-right font-mono text-xs">
        {fmtMeasure(cell.measure, isCount)}
      </span>
    </div>
  );
}

function BreakdownTable({ report }: { report: ReportResult }) {
  const isCount = report.measure === 'count';
  return (
    <section className="overflow-x-auto rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)]">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-[color:var(--color-border)] text-[11px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
          <tr>
            <th className="px-3 py-2 font-medium">{SLICE_BY_LABEL[report.sliceBy]}</th>
            <th className="px-3 py-2 text-right font-medium">{MEASURE_LABEL[report.measure]}</th>
            {report.segmentBy && (
              <th className="px-3 py-2 font-medium">Top {SLICE_BY_LABEL[report.segmentBy]}</th>
            )}
          </tr>
        </thead>
        <tbody>
          {report.cells.map((c) => {
            const topSegment = c.segments
              ? Object.entries(c.segments).sort((a, b) => b[1] - a[1])[0]
              : null;
            return (
              <tr key={c.label} className="border-t border-[color:var(--color-border)]/60">
                <td className="px-3 py-2 text-xs">{c.label}</td>
                <td className="px-3 py-2 text-right font-mono text-xs">
                  {fmtMeasure(c.measure, isCount)}
                </td>
                {report.segmentBy && (
                  <td className="px-3 py-2 text-[11px] text-[color:var(--color-muted-foreground)]">
                    {topSegment ? `${topSegment[0]} (${fmtMeasure(topSegment[1], isCount)})` : '—'}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

function fmtMeasure(n: number, isCount: boolean): string {
  if (isCount) return n.toString();
  return fmtUsd(n);
}

function fmtUsd(n: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(n);
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
        {label}
      </span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
        {label}
      </p>
      <p className="mt-0.5 text-sm font-semibold text-[color:var(--color-foreground)]">{value}</p>
    </div>
  );
}
