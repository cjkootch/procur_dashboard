/**
 * Server-rendered HTML/CSS heatmap. Rows × columns, cells are
 * background-tinted by value relative to the max. No client deps.
 *
 * Used for the top-supplier × top-buyer-country award-count matrix.
 */
import { type ReactNode } from 'react';

export type HeatmapInput = {
  rows: Array<{ id: string; label: string; sublabel?: string }>;
  cols: Array<{ id: string; label: string }>;
  /** cells[row.id][col.id] = value; missing = 0. */
  cells: Map<string, Map<string, number>>;
};

export function Heatmap({
  rows,
  cols,
  cells,
  emptyMessage = 'No data in this window.',
}: HeatmapInput & { emptyMessage?: string }): ReactNode {
  if (rows.length === 0 || cols.length === 0) {
    return (
      <div className="rounded-[var(--radius-lg)] border border-dashed border-[color:var(--color-border)] p-6 text-center text-sm text-[color:var(--color-muted-foreground)]">
        {emptyMessage}
      </div>
    );
  }
  // Find global max for tint scaling.
  let max = 0;
  for (const colMap of cells.values()) {
    for (const v of colMap.values()) {
      if (v > max) max = v;
    }
  }
  if (max === 0) max = 1;

  return (
    <div className="overflow-x-auto rounded-[var(--radius-lg)] border border-[color:var(--color-border)]">
      <table className="w-full text-left text-xs">
        <thead>
          <tr className="border-b border-[color:var(--color-border)] bg-[color:var(--color-muted)]/30">
            <th className="px-2 py-2 text-[10px] font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
              {/* corner */}
            </th>
            {cols.map((c) => (
              <th
                key={c.id}
                className="px-2 py-2 text-[10px] font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)] tabular-nums"
                title={c.label}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b border-[color:var(--color-border)] last:border-b-0">
              <td className="max-w-[200px] truncate px-2 py-1.5" title={r.label}>
                {r.label}
                {r.sublabel && (
                  <span className="ml-1 text-[10px] text-[color:var(--color-muted-foreground)]">
                    {r.sublabel}
                  </span>
                )}
              </td>
              {cols.map((c) => {
                const v = cells.get(r.id)?.get(c.id) ?? 0;
                const intensity = v / max;
                // Use foreground color with variable alpha so the
                // theme handles light/dark cleanly.
                const bg =
                  v > 0
                    ? `rgba(80,140,200,${Math.max(0.08, intensity * 0.6).toFixed(2)})`
                    : 'transparent';
                return (
                  <td
                    key={c.id}
                    className="px-2 py-1.5 text-center tabular-nums"
                    style={{ backgroundColor: bg }}
                    title={`${r.label} × ${c.label}: ${v}`}
                  >
                    {v > 0 ? v : ''}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
