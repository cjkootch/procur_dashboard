/**
 * Server-rendered SVG line chart with optional zero baseline. Used
 * for "average delta vs benchmark over time" — values can swing
 * either side of zero so a fixed Y range with zero centered makes
 * sense.
 */
import { type ReactNode } from 'react';

export type LinePoint = { label: string; value: number | null };

export function LineChart({
  points,
  height = 180,
  yLabel,
  /** Format Y-axis values; default rounds + adds prefix. */
  formatY = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}`,
  emptyMessage = 'No data in this window.',
  /** Clamp y-axis domain to ≥0 when all values are non-negative.
      Default true — most dashboard metrics (counts, $USD) are
      non-negative and the 10% padding shouldn't push them below zero. */
  clampPositive = true,
}: {
  points: LinePoint[];
  height?: number;
  yLabel?: string;
  formatY?: (n: number) => string;
  emptyMessage?: string;
  clampPositive?: boolean;
}): ReactNode {
  const valid = points.filter(
    (p): p is { label: string; value: number } => p.value != null,
  );
  if (valid.length < 2) {
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
  const padT = 10;
  const padB = 24;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const min = Math.min(...valid.map((p) => p.value));
  const max = Math.max(...valid.map((p) => p.value));
  // Pad domain by 10% so the line doesn't touch the edges.
  const range = max - min || 1;
  let yMin = min - range * 0.1;
  const yMax = max + range * 0.1;
  if (clampPositive && min >= 0 && yMin < 0) yMin = 0;

  const xFor = (i: number) => padL + (i / (points.length - 1)) * innerW;
  const yFor = (v: number) => padT + innerH - ((v - yMin) / (yMax - yMin)) * innerH;

  // Build path from valid points only (skip nulls); use M/L commands.
  const segments: string[] = [];
  let prevValid = false;
  for (let i = 0; i < points.length; i += 1) {
    const p = points[i]!;
    if (p.value == null) {
      prevValid = false;
      continue;
    }
    const cmd = prevValid ? 'L' : 'M';
    segments.push(`${cmd}${xFor(i).toFixed(2)},${yFor(p.value).toFixed(2)}`);
    prevValid = true;
  }

  // Zero baseline — only if it falls inside the visible range.
  const zeroInRange = yMin < 0 && yMax > 0;
  const zeroY = zeroInRange ? yFor(0) : null;

  // Y-axis ticks: min, midpoint, max. Round-friendly.
  const ticks = [yMin, (yMin + yMax) / 2, yMax];

  return (
    <div className="rounded-[var(--radius-lg)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-4 shadow-sm">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="none">
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
        {zeroY != null && (
          <line
            x1={padL}
            x2={W - padR}
            y1={zeroY}
            y2={zeroY}
            stroke="currentColor"
            strokeOpacity={0.4}
            strokeWidth={1}
            strokeDasharray="3,3"
          />
        )}
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
        <path
          d={segments.join(' ')}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          className="text-[color:var(--color-foreground)]"
        />
        {/* Dots on each valid point with a tooltip. */}
        {points.map((p, i) =>
          p.value == null ? null : (
            <circle
              key={`${p.label}-${i}`}
              cx={xFor(i)}
              cy={yFor(p.value)}
              r={3}
              className="fill-[color:var(--color-foreground)]"
            >
              <title>
                {p.label}: {formatY(p.value)}
              </title>
            </circle>
          ),
        )}
        {/* X labels at the start, mid, end. */}
        {[0, Math.floor(points.length / 2), points.length - 1].map((i) => (
          <text
            key={i}
            x={xFor(i)}
            y={H - 6}
            fontSize={10}
            fill="currentColor"
            fillOpacity={0.55}
            textAnchor={i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'}
          >
            {points[i]!.label}
          </text>
        ))}
      </svg>
    </div>
  );
}
