import Link from 'next/link';
import { requireCompany } from '@procur/auth';
import {
  listCompanyPursuits,
  STAGE_ORDER,
  TERMINAL_STAGES,
  type PursuitCard,
  type PursuitStageKey,
} from '../../../lib/capture-queries';
import { CaptureViewSwitcher } from '../components/view-switcher';
import { Gantt, GanttLegend, type GanttRow } from './components/gantt';

export const dynamic = 'force-dynamic';

type SearchParams = {
  mine?: string;
  zoom?: string;
  show?: string;
  stage?: string;
};

type Zoom = 'sm' | 'md' | 'lg';
const ZOOM_PX: Record<Zoom, number> = { sm: 64, md: 96, lg: 144 };

function isZoom(v: string | undefined): v is Zoom {
  return v === 'sm' || v === 'md' || v === 'lg';
}

export default async function LifecyclePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const zoom: Zoom = isZoom(sp.zoom) ? sp.zoom : 'md';
  const mineOnly = sp.mine === '1';
  const showClosed = sp.show === 'all';
  const stageFilter = isStage(sp.stage) ? sp.stage : null;

  const { user, company } = await requireCompany();
  const all = await listCompanyPursuits(company.id);

  const rows = all
    .filter((p) => (mineOnly ? p.assignedUserId === user.id : true))
    .filter((p) => (showClosed ? true : !TERMINAL_STAGES.includes(p.stage)))
    .filter((p) => (stageFilter ? p.stage === stageFilter : true))
    .sort((a, b) => {
      // Sort by deadline asc (closest first), no-deadline rows at the bottom.
      const at = a.opportunity.deadlineAt?.getTime() ?? Number.POSITIVE_INFINITY;
      const bt = b.opportunity.deadlineAt?.getTime() ?? Number.POSITIVE_INFINITY;
      return at - bt;
    });

  const ganttRows: GanttRow[] = rows.map(toGanttRow);

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-[color:var(--color-border)] bg-[color:var(--color-background)] px-6 py-4">
        <div className="mb-3 flex items-start justify-between">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Lifecycle</h1>
            <p className="mt-0.5 text-xs text-[color:var(--color-muted-foreground)]">
              Timeline of every pursuit from start through submission deadline.
              {rows.length !== all.length && (
                <>
                  {' · '}
                  Showing {rows.length} of {all.length}
                </>
              )}
            </p>
          </div>
          <CaptureViewSwitcher active="lifecycle" />
        </div>

        {/* Filter / zoom toolbar */}
        <form method="get" className="flex flex-wrap items-center gap-2 text-xs">
          <label className="flex items-center gap-1">
            <span className="text-[color:var(--color-muted-foreground)]">Stage:</span>
            <select
              name="stage"
              defaultValue={sp.stage ?? 'all'}
              className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-xs"
            >
              <option value="all">All stages</option>
              {STAGE_ORDER.map((s) => (
                <option key={s} value={s}>
                  {s.replace(/_/g, ' ')}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              name="mine"
              value="1"
              defaultChecked={mineOnly}
              className="h-3 w-3"
            />
            <span>Mine only</span>
          </label>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              name="show"
              value="all"
              defaultChecked={showClosed}
              className="h-3 w-3"
            />
            <span>Include won / lost</span>
          </label>

          <div className="ml-auto inline-flex items-center gap-2">
            <span className="text-[color:var(--color-muted-foreground)]">Zoom:</span>
            <div className="inline-flex rounded-[var(--radius-sm)] border border-[color:var(--color-border)] p-0.5">
              {(['sm', 'md', 'lg'] as Zoom[]).map((z) => (
                <button
                  key={z}
                  type="submit"
                  name="zoom"
                  value={z}
                  className={`rounded-[var(--radius-sm)] px-2 py-0.5 text-[11px] ${
                    zoom === z
                      ? 'bg-[color:var(--color-foreground)] text-[color:var(--color-background)]'
                      : 'text-[color:var(--color-muted-foreground)]'
                  }`}
                >
                  {z.toUpperCase()}
                </button>
              ))}
            </div>
            {/* Preserve the other filters when clicking a zoom button */}
            {stageFilter && <input type="hidden" name="stage" value={stageFilter} />}
            {mineOnly && <input type="hidden" name="mine" value="1" />}
            {showClosed && <input type="hidden" name="show" value="all" />}
          </div>

          <button
            type="submit"
            className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1"
          >
            Apply
          </button>
          {(mineOnly || showClosed || stageFilter || zoom !== 'md') && (
            <Link
              href="/capture/lifecycle"
              className="text-[color:var(--color-muted-foreground)] hover:underline"
            >
              Reset
            </Link>
          )}
        </form>
      </header>

      <div className="border-b border-[color:var(--color-border)] bg-[color:var(--color-muted)]/30 px-6 py-2">
        <GanttLegend />
      </div>

      <div className="flex-1 overflow-auto px-6 py-4">
        <Gantt rows={ganttRows} pxPerMonth={ZOOM_PX[zoom]} nameColWidthPx={256} />
      </div>
    </div>
  );
}

function isStage(v: string | undefined): v is PursuitStageKey {
  if (!v || v === 'all') return false;
  return (STAGE_ORDER as string[]).includes(v);
}

function toGanttRow(p: PursuitCard): GanttRow {
  // Start = pursuit.createdAt; end = opportunity.deadlineAt.
  // If a pursuit has a terminal stage, clamp the bar end to the terminal
  // timestamp when available (not plumbed through the PursuitCard type yet
  // — follow-up) so awarded/lost bars don't extend past the deadline.
  return {
    id: p.id,
    title: p.opportunity.title,
    jurisdictionCountry: p.opportunity.jurisdictionCountry,
    stage: p.stage,
    startDate: p.createdAt,
    endDate: p.opportunity.deadlineAt,
    valueEstimateUsd: p.opportunity.valueEstimateUsd,
    pWin: p.pWin,
    agencyName: p.opportunity.agencyName ?? p.opportunity.jurisdictionName,
  };
}
