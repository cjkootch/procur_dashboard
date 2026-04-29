import Link from 'next/link';
import type { CompetitorOverviewRow } from '@procur/catalog';

/**
 * Compact tile for one competitor on the /suppliers/competitors
 * dashboard. Click-through to the unified entity profile page.
 *
 * Renders sensibly across two states:
 *   - Public-tender footprint linked via fuzzy-name match → real
 *     volume + velocity numbers.
 *   - No public match (typical for major trading houses) → tile
 *     focuses on tags / categories / news; "—" on the volume cells.
 */
export function CompetitorCard({ row }: { row: CompetitorOverviewRow }) {
  const hasActivity = row.matchedSupplierId != null;
  const velocity = row.velocityChangePct;

  const tierBadge = row.tags.includes('top-tier')
    ? { label: 'Top tier', cls: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700' }
    : row.tags.includes('state-affiliated')
      ? { label: 'State-affiliated', cls: 'border-amber-500/40 bg-amber-500/10 text-amber-800' }
      : row.tags.includes('mid-tier')
        ? { label: 'Mid tier', cls: 'border-[color:var(--color-border)] bg-[color:var(--color-muted)]/40 text-[color:var(--color-muted-foreground)]' }
        : null;

  return (
    <Link
      href={`/entities/${row.slug}`}
      className="group/tile flex flex-col gap-2 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-4 shadow-sm hover:border-[color:var(--color-foreground)]"
    >
      <header className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold leading-tight">{row.name}</h3>
          <p className="text-[11px] text-[color:var(--color-muted-foreground)]">
            {row.headquarters ?? row.country} · {row.role}
          </p>
        </div>
        {tierBadge && (
          <span
            className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${tierBadge.cls}`}
          >
            {tierBadge.label}
          </span>
        )}
      </header>

      <div className="flex flex-wrap gap-1">
        {row.categories.slice(0, 5).map((c) => (
          <span
            key={c}
            className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-muted)]/30 px-1.5 py-0.5 text-[10px] text-[color:var(--color-muted-foreground)]"
          >
            {c}
          </span>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-2 border-t border-[color:var(--color-border)] pt-2 text-[11px] tabular-nums">
        <Metric
          label="Awards"
          value={hasActivity ? row.totalAwards.toLocaleString() : '—'}
          sub={hasActivity ? fmtUsd(row.totalValueUsd) : 'no public-tender footprint'}
        />
        <Metric
          label="90d activity"
          value={hasActivity ? row.awardsLast90d.toString() : '—'}
          sub={
            velocity != null
              ? `${velocity >= 0 ? '+' : ''}${(velocity * 100).toFixed(0)}% vs prior`
              : hasActivity
                ? 'first window'
                : ''
          }
          accent={velocity != null && velocity <= -0.5 ? 'down' : velocity != null && velocity >= 0.5 ? 'up' : undefined}
        />
        <Metric
          label="News (90d)"
          value={row.newsEventsLast90d > 0 ? row.newsEventsLast90d.toString() : '—'}
          sub={
            row.mostRecentNewsDate
              ? `latest ${row.mostRecentNewsDate}`
              : 'no recent events'
          }
        />
      </div>

      {row.mostRecentNewsTitle && (
        <p className="line-clamp-2 border-t border-[color:var(--color-border)] pt-2 text-[11px] italic text-[color:var(--color-muted-foreground)]">
          “{row.mostRecentNewsTitle}”
        </p>
      )}

      {row.notes && !row.mostRecentNewsTitle && (
        <p className="line-clamp-2 border-t border-[color:var(--color-border)] pt-2 text-[11px] text-[color:var(--color-muted-foreground)]">
          {row.notes}
        </p>
      )}
    </Link>
  );
}

function Metric({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: 'up' | 'down';
}) {
  const accentCls =
    accent === 'down'
      ? 'text-red-700'
      : accent === 'up'
        ? 'text-emerald-700'
        : '';
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
        {label}
      </div>
      <div className={`font-semibold ${accentCls}`}>{value}</div>
      {sub && (
        <div className="text-[10px] text-[color:var(--color-muted-foreground)]">
          {sub}
        </div>
      )}
    </div>
  );
}

function fmtUsd(n: number | null): string {
  if (n == null) return '—';
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}k`;
  return `$${n.toFixed(0)}`;
}
