/**
 * Server-rendered SVG multi-series line chart. Each series is a label
 * + ordered list of (x-label, value) pairs. All series must share the
 * same x-axis (i.e. same length and same labels at the same indices).
 *
 * Used for the year-over-year seasonality overlay — one line per year,
 * x-axis = month-of-year (Jan…Dec).
 */
import { type ReactNode } from 'react';

export type MultiLineSeries = {
  label: string;
  values: Array<number | null>;
  /** Optional override; otherwise palette[i % palette.length] is used. */
  color?: string;
  /** Bold-ish styling for the most-recent / "current" series. */
  emphasized?: boolean;
};

const PALETTE = [
  'rgba(120,120,120,0.6)',
  'rgba(80,80,80,0.85)',
  'rgba(20,20,20,1)',
  'rgba(80,140,200,0.85)',
  'rgba(220,140,80,0.85)',
];

export function MultiLineChart({
  xLabels,
  series,
  height = 220,
  yLabel,
  formatY = (n) => `${n.toFixed(0)}`,
  emptyMessage = 'No data in this window.',
}: {
  xLabels: string[];
  series: MultiLineSeries[];
  height?: number;
  yLabel?: string;
  formatY?: (n: number) => string;
  emptyMessage?: string;
}): ReactNode {
  // Need at least one series with at least 2 valid points.
  const hasData = series.some(
    (s) => s.values.filter((v) => v != null).length >= 2,
  );
  if (!hasData) {
    return (
      <div
        className="rounded-[var(--radius-lg)] border border-dashed border-[color:var(--color-border)] p-6 text-center text-sm text-[color:var(--color-muted-foreground)]"
        style={{ minHeight: height }}
      >
        {emptyMessage}
      </div>
    );
  }

  const W = 1000;
  const H = height;
  const padL = 48;
  const padR = 12;
  const padT = 28; // room for legend
  const padB = 28;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const allValues = series.flatMap((s) =>
    s.values.filter((v): v is number => v != null),
  );
  const min = Math.min(...allValues, 0);
  const max = Math.max(...allValues, 1);
  const range = max - min || 1;
  const yMin = min - range * 0.05;
  const yMax = max + range * 0.1;

  const xFor = (i: number) =>
    xLabels.length > 1 ? padL + (i / (xLabels.length - 1)) * innerW : padL + innerW / 2;
  const yFor = (v: number) =>
    padT + innerH - ((v - yMin) / (yMax - yMin)) * innerH;

  const ticks = [yMin, (yMin + yMax) / 2, yMax];

  return (
    <div className="rounded-[var(--radius-lg)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-4 shadow-sm">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="none">
        {/* Legend */}
        {series.map((s, i) => {
          const color = s.color ?? PALETTE[i % PALETTE.length]!;
          const x = padL + i * 110;
          return (
            <g key={s.label}>
              <line
                x1={x}
                x2={x + 14}
                y1={12}
                y2={12}
                stroke={color}
                strokeWidth={s.emphasized ? 3 : 2}
              />
              <text
                x={x + 18}
                y={15}
                fontSize={11}
                fill="currentColor"
                fillOpacity={0.7}
              >
                {s.label}
              </text>
            </g>
          );
        })}
        {/* Y ticks + grid */}
        {ticks.map((t, i) => {
          const y = yFor(t);
          return (
            <g key={i}>
              <line
                x1={padL}
                x2={W - padR}
                y1={y}
                y2={y}
                stroke="currentColor"
                strokeOpacity={0.1}
                strokeWidth={1}
              />
              <text
                x={padL - 6}
                y={y + 4}
                fontSize={10}
                fill="currentColor"
                fillOpacity={0.55}
                textAnchor="end"
              >
                {formatY(t)}
              </text>
            </g>
          );
        })}
        {yLabel && (
          <text
            x={4}
            y={padT - 12}
            fontSize={10}
            fill="currentColor"
            fillOpacity={0.55}
          >
            {yLabel}
          </text>
        )}
        {/* Lines */}
        {series.map((s, i) => {
          const color = s.color ?? PALETTE[i % PALETTE.length]!;
          const segments: string[] = [];
          let prevValid = false;
          for (let idx = 0; idx < s.values.length; idx += 1) {
            const v = s.values[idx];
            if (v == null) {
              prevValid = false;
              continue;
            }
            const cmd = prevValid ? 'L' : 'M';
            segments.push(`${cmd}${xFor(idx).toFixed(2)},${yFor(v).toFixed(2)}`);
            prevValid = true;
          }
          return (
            <g key={s.label}>
              <path
                d={segments.join(' ')}
                fill="none"
                stroke={color}
                strokeWidth={s.emphasized ? 2.5 : 1.5}
              />
            </g>
          );
        })}
        {/* X labels at start, mid, end */}
        {[0, Math.floor(xLabels.length / 2), xLabels.length - 1].map((i) =>
          xLabels[i] == null ? null : (
            <text
              key={i}
              x={xFor(i)}
              y={H - 6}
              fontSize={10}
              fill="currentColor"
              fillOpacity={0.55}
              textAnchor={i === 0 ? 'start' : i === xLabels.length - 1 ? 'end' : 'middle'}
            >
              {xLabels[i]}
            </text>
          ),
        )}
      </svg>
    </div>
  );
}
