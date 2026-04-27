import Link from 'next/link';
import type { PursuitCard } from '../../../../lib/capture-queries';
import { STAGE_LABEL } from '../../../../lib/capture-queries';
import { flagFor, formatDate, formatMoney } from '../../../../lib/format';

/**
 * Horizontal Gantt chart. One row per pursuit, bar from start to
 * deadline across a monthly timeline. Pure HTML/CSS/SVG — no chart
 * library. Server-rendered; zoom is a URL search param controlling
 * per-month pixel width.
 *
 * Mirrors Govdash screenshots2/Screenshot 1.21.48 PM.
 */

export type GanttRow = {
  id: string;
  title: string;
  /** Null for private uploaded opportunities (no jurisdiction). */
  jurisdictionCountry: string | null;
  stage: PursuitCard['stage'];
  startDate: Date;
  endDate: Date | null;
  valueEstimateUsd: string | null;
  pWin: number | null;
  agencyName: string | null;
};

const STAGE_BAR_COLOR: Record<PursuitCard['stage'], string> = {
  identification: 'bg-[color:var(--color-muted-foreground)]/40',
  qualification: 'bg-blue-400',
  capture_planning: 'bg-violet-400',
  proposal_development: 'bg-amber-400',
  submitted: 'bg-blue-500',
  awarded: 'bg-emerald-500',
  lost: 'bg-red-400',
};

export function Gantt({
  rows,
  pxPerMonth,
  nameColWidthPx,
}: {
  rows: GanttRow[];
  pxPerMonth: number;
  nameColWidthPx: number;
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-[var(--radius-md)] border border-dashed border-[color:var(--color-border)] p-10 text-center text-sm text-[color:var(--color-muted-foreground)]">
        No pursuits match these filters.
      </div>
    );
  }

  // Compute the month range that spans all rows, padded by 1 month on each side.
  const { months, firstMonthStart } = computeMonthRange(rows);
  const timelineWidthPx = months.length * pxPerMonth;
  const now = new Date();
  const nowOffsetPx = Math.max(0, msToPx(now.getTime() - firstMonthStart.getTime(), pxPerMonth));

  return (
    <div className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)]">
      {/* Scroll container so wide timelines pan horizontally */}
      <div className="overflow-x-auto">
        <div className="relative" style={{ minWidth: `${nameColWidthPx + timelineWidthPx}px` }}>
          {/* Month header row */}
          <div
            className="sticky top-0 z-10 flex border-b border-[color:var(--color-border)] bg-[color:var(--color-background)]"
            style={{ paddingLeft: `${nameColWidthPx}px` }}
          >
            {months.map((m, i) => (
              <div
                key={m.key}
                className={`flex shrink-0 items-baseline justify-start border-l border-[color:var(--color-border)] px-2 py-1.5 text-[10px] uppercase tracking-wider text-[color:var(--color-muted-foreground)] ${
                  i === 0 ? 'border-l-0' : ''
                } ${m.isYearStart ? 'font-semibold text-[color:var(--color-foreground)]' : ''}`}
                style={{ width: `${pxPerMonth}px` }}
              >
                {m.isYearStart || i === 0 ? m.label : m.shortLabel}
              </div>
            ))}
          </div>

          {/* Rows */}
          <div className="relative">
            {/* "Now" vertical line — spans all rows. Hidden when out of range. */}
            {nowOffsetPx > 0 && nowOffsetPx < timelineWidthPx && (
              <div
                aria-hidden
                className="pointer-events-none absolute top-0 bottom-0 w-px bg-red-500/70"
                style={{ left: `${nameColWidthPx + nowOffsetPx}px` }}
              >
                <span className="absolute -top-0.5 left-1 text-[9px] font-medium text-red-500">
                  now
                </span>
              </div>
            )}

            {rows.map((r) => (
              <Row
                key={r.id}
                row={r}
                firstMonthStart={firstMonthStart}
                timelineWidthPx={timelineWidthPx}
                pxPerMonth={pxPerMonth}
                nameColWidthPx={nameColWidthPx}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({
  row,
  firstMonthStart,
  timelineWidthPx,
  pxPerMonth,
  nameColWidthPx,
}: {
  row: GanttRow;
  firstMonthStart: Date;
  timelineWidthPx: number;
  pxPerMonth: number;
  nameColWidthPx: number;
}) {
  const startPx = msToPx(row.startDate.getTime() - firstMonthStart.getTime(), pxPerMonth);
  // No end date = open-ended; render a dotted bar from start to the right edge.
  const endMs = (row.endDate ?? new Date(firstMonthStart.getTime() + timelineWidthPx * MS_PER_MONTH_APPROX / pxPerMonth)).getTime();
  const endPx = Math.min(timelineWidthPx, msToPx(endMs - firstMonthStart.getTime(), pxPerMonth));
  const barWidth = Math.max(4, endPx - startPx);

  const barColor = STAGE_BAR_COLOR[row.stage];
  const isOpenEnded = row.endDate === null;

  return (
    <div className="group flex h-11 items-center border-b border-[color:var(--color-border)]/50 text-xs hover:bg-[color:var(--color-muted)]/20">
      {/* Sticky name column */}
      <div
        className="sticky left-0 z-[5] flex items-center gap-2 border-r border-[color:var(--color-border)] bg-[color:var(--color-background)] px-3"
        style={{ width: `${nameColWidthPx}px`, minWidth: `${nameColWidthPx}px` }}
      >
        <span className="text-sm leading-none">{flagFor(row.jurisdictionCountry)}</span>
        <div className="min-w-0 flex-1">
          <Link
            href={`/capture/pursuits/${row.id}`}
            className="block truncate text-xs font-medium hover:underline"
            title={row.title}
          >
            {row.title}
          </Link>
          <p className="truncate text-[10px] text-[color:var(--color-muted-foreground)]">
            {row.agencyName ?? '—'}
          </p>
        </div>
      </div>

      {/* Timeline */}
      <div className="relative shrink-0" style={{ width: `${timelineWidthPx}px`, height: '100%' }}>
        <Link
          href={`/capture/pursuits/${row.id}`}
          className="absolute top-1/2 block -translate-y-1/2 rounded-[var(--radius-sm)]"
          style={{
            left: `${startPx}px`,
            width: `${barWidth}px`,
            height: '18px',
          }}
          title={barTitle(row)}
        >
          <div
            className={`flex h-full items-center overflow-hidden rounded-[var(--radius-sm)] px-1.5 text-[10px] text-white/95 ${barColor} ${
              isOpenEnded ? 'border-r-2 border-dashed border-white/60' : ''
            }`}
          >
            <span className="truncate">
              {STAGE_LABEL[row.stage]}
              {row.pWin != null && <> · {Math.round(row.pWin * 100)}%</>}
            </span>
          </div>
        </Link>
      </div>
    </div>
  );
}

// -- Legend -----------------------------------------------------------------

export function GanttLegend() {
  const STAGES: PursuitCard['stage'][] = [
    'identification',
    'qualification',
    'capture_planning',
    'proposal_development',
    'submitted',
    'awarded',
    'lost',
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-[color:var(--color-muted-foreground)]">
      {STAGES.map((s) => (
        <div key={s} className="flex items-center gap-1.5">
          <span
            aria-hidden
            className={`inline-block h-2.5 w-2.5 rounded-sm ${STAGE_BAR_COLOR[s]}`}
          />
          <span>{STAGE_LABEL[s]}</span>
        </div>
      ))}
      <div className="ml-2 flex items-center gap-1.5">
        <span className="inline-block h-3 w-px bg-red-500/70" />
        <span>Today</span>
      </div>
    </div>
  );
}

// -- helpers ----------------------------------------------------------------

type MonthBucket = { key: string; label: string; shortLabel: string; isYearStart: boolean };

const MS_PER_MONTH_APPROX = 30.436875 * 24 * 60 * 60 * 1000;

function computeMonthRange(rows: GanttRow[]): {
  months: MonthBucket[];
  firstMonthStart: Date;
} {
  let earliest = Number.POSITIVE_INFINITY;
  let latest = Number.NEGATIVE_INFINITY;
  for (const r of rows) {
    earliest = Math.min(earliest, r.startDate.getTime());
    if (r.endDate) latest = Math.max(latest, r.endDate.getTime());
    else latest = Math.max(latest, r.startDate.getTime() + 60 * 24 * 60 * 60 * 1000);
  }
  // Fallback if rows were empty-ish
  if (!Number.isFinite(earliest) || !Number.isFinite(latest)) {
    const now = Date.now();
    earliest = now;
    latest = now + 90 * 24 * 60 * 60 * 1000;
  }

  const first = new Date(earliest);
  const firstMonthStart = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() - 1, 1));
  const last = new Date(latest);
  const lastMonthStart = new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth() + 1, 1));

  const months: MonthBucket[] = [];
  const cursor = new Date(firstMonthStart);
  while (cursor <= lastMonthStart) {
    const month = cursor.getUTCMonth();
    const year = cursor.getUTCFullYear();
    months.push({
      key: `${year}-${month}`,
      label: cursor.toLocaleString('en-US', { month: 'short', year: 'numeric' }),
      shortLabel: cursor.toLocaleString('en-US', { month: 'short' }),
      isYearStart: month === 0,
    });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }

  return { months, firstMonthStart };
}

function msToPx(ms: number, pxPerMonth: number): number {
  return (ms / MS_PER_MONTH_APPROX) * pxPerMonth;
}

function barTitle(r: GanttRow): string {
  const parts: string[] = [r.title];
  parts.push(`Start: ${formatDate(r.startDate)}`);
  if (r.endDate) parts.push(`End: ${formatDate(r.endDate)}`);
  else parts.push('No deadline set');
  parts.push(`Stage: ${STAGE_LABEL[r.stage]}`);
  if (r.pWin != null) parts.push(`P(Win): ${Math.round(r.pWin * 100)}%`);
  if (r.valueEstimateUsd) {
    const value = formatMoney(r.valueEstimateUsd, 'USD');
    if (value) parts.push(`Value: ${value}`);
  }
  return parts.join('\n');
}

