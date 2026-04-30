/**
 * Inline sparkline — fixed pixel size, no axis labels. Used by the
 * commodity ticker (brief + market intelligence) so each price has
 * a 30-day shape next to it.
 *
 * Lifted to apps/app/components from the intelligence page _components
 * folder so the brief can reuse it without a deep import path. Behavior
 * is identical to the original.
 */
import { type ReactNode } from 'react';

export function Sparkline({
  values,
  width = 64,
  height = 18,
}: {
  values: number[];
  width?: number;
  height?: number;
}): ReactNode {
  if (values.length < 2) {
    return <span className="text-[10px] text-[color:var(--color-muted-foreground)]">·</span>;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const stepX = width / (values.length - 1);
  const points = values
    .map((v, i) => {
      const x = i * stepX;
      const y = height - ((v - min) / range) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  // Color the line by net trend over the window.
  const trendUp = values[values.length - 1]! >= values[0]!;
  const stroke = trendUp ? 'rgb(34,139,84)' : 'rgb(190,60,60)';

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{ display: 'inline-block', verticalAlign: 'middle' }}
      aria-hidden
    >
      <polyline
        fill="none"
        stroke={stroke}
        strokeWidth={1.25}
        strokeLinejoin="round"
        strokeLinecap="round"
        points={points}
      />
    </svg>
  );
}
