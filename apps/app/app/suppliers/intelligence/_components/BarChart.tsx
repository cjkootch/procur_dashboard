/**
 * Server-rendered SVG bar chart. No client deps. Pass an array of
 * { label, value, hint? } and it renders bars with axis labels.
 *
 * Used for monthly awards volume + price-delta histogram. Kept
 * deliberately minimal — adding a real chart library is an option
 * once the dashboard outgrows this footprint.
 */
import { type ReactNode } from 'react';

export type BarDatum = {
  label: string;
  value: number;
  /** Optional second-line tooltip text (rendered as <title>). */
  hint?: string;
  /** Optional override fill for "highlight bars" like today's bar. */
  highlight?: boolean;
};

export function BarChart({
  data,
  height = 160,
  yLabel,
  emptyMessage = 'No data in this window.',
}: {
  data: BarDatum[];
  height?: number;
  yLabel?: string;
  emptyMessage?: string;
}): ReactNode {
  const max = data.reduce((m, d) => Math.max(m, d.value), 0);
  if (data.length === 0 || max === 0) {
    return (
      <div
        className="rounded-[var(--radius-lg)] border border-dashed border-[color:var(--color-border)] p-6 text-center text-sm text-[color:var(--color-muted-foreground)]"
        style={{ minHeight: height }}
      >
        {emptyMessage}
      </div>
    );
  }

  // SVG layout: viewBox is fixed-width (1000) so it scales fluidly.
  const W = 1000;
  const H = height;
  const padL = 36;
  const padR = 8;
  const padT = 10;
  const padB = 24;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const barGap = 4;
  const barW = (innerW - barGap * (data.length - 1)) / data.length;

  // Y-axis ticks at 0 / 50% / 100% of max.
  const ticks = [0, max / 2, max];

  return (
    <div className="rounded-[var(--radius-lg)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-4 shadow-sm">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="none">
        {/* Y-axis grid lines */}
        {ticks.map((t, i) => {
          const y = padT + innerH - (t / max) * innerH;
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
                {Math.round(t).toLocaleString()}
              </text>
            </g>
          );
        })}
        {/* Y-axis label */}
        {yLabel && (
          <text
            x={4}
            y={padT - 2}
            fontSize={10}
            fill="currentColor"
            fillOpacity={0.55}
          >
            {yLabel}
          </text>
        )}
        {/* Bars */}
        {data.map((d, i) => {
          const x = padL + i * (barW + barGap);
          const h = (d.value / max) * innerH;
          const y = padT + innerH - h;
          return (
            <g key={`${d.label}-${i}`}>
              <rect
                x={x}
                y={y}
                width={barW}
                height={Math.max(h, 1)}
                rx={2}
                className={
                  d.highlight
                    ? 'fill-[color:var(--color-foreground)]'
                    : 'fill-[color:var(--color-foreground)]/70'
                }
              >
                <title>
                  {d.label}: {d.value.toLocaleString()}
                  {d.hint ? ` — ${d.hint}` : ''}
                </title>
              </rect>
              {/* X-axis label every Nth bar — keep it readable on
                  long series. */}
              {(i % Math.max(1, Math.floor(data.length / 12)) === 0 ||
                i === data.length - 1) && (
                <text
                  x={x + barW / 2}
                  y={H - 6}
                  fontSize={10}
                  fill="currentColor"
                  fillOpacity={0.55}
                  textAnchor="middle"
                >
                  {d.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
