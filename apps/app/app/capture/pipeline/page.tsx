import { requireCompany } from '@procur/auth';
import {
  listPursuitsByStage,
  STAGE_LABEL,
  STAGE_ORDER,
  type PursuitCard as PursuitCardData,
  type PursuitStageKey,
} from '../../../lib/capture-queries';
import { formatMoney } from '../../../lib/format';
import { PursuitCard } from '../components/pursuit-card';
import { CaptureViewSwitcher } from '../components/view-switcher';
import { moveStageAction } from '../actions';

export const dynamic = 'force-dynamic';

type SearchParams = {
  mine?: string;
  sort?: string;
};

type SortKey = 'updated' | 'deadline' | 'value' | 'pwin';

const SORT_LABEL: Record<SortKey, string> = {
  updated: 'Recently updated',
  deadline: 'Deadline (soonest)',
  value: 'Value (high → low)',
  pwin: 'P(Win) (high → low)',
};

export default async function PipelinePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const sort: SortKey = isSortKey(sp.sort) ? sp.sort : 'updated';
  const mineOnly = sp.mine === '1';

  const { user, company } = await requireCompany();
  const byStage = await listPursuitsByStage(company.id);

  // Apply filter + sort across each column.
  const filteredByStage = new Map<PursuitStageKey, PursuitCardData[]>();
  for (const stage of STAGE_ORDER) {
    const cards = (byStage.get(stage) ?? []).filter((c) =>
      mineOnly ? c.assignedUserId === user.id : true,
    );
    cards.sort(comparator(sort));
    filteredByStage.set(stage, cards);
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-start justify-between border-b border-[color:var(--color-border)] bg-[color:var(--color-background)] px-6 py-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Pipeline</h1>
          <div className="mt-2">
            <CaptureViewSwitcher active="pipeline" />
          </div>
        </div>
        <p className="mt-1 max-w-xs text-right text-[11px] text-[color:var(--color-muted-foreground)]">
          Hover a card to advance its stage.
        </p>
      </header>

      {/* Filter / sort toolbar */}
      <form
        method="get"
        className="flex items-center gap-2 border-b border-[color:var(--color-border)] px-6 py-2 text-xs"
      >
        <label className="flex items-center gap-1">
          <span className="text-[color:var(--color-muted-foreground)]">Sort:</span>
          <select
            name="sort"
            defaultValue={sort}
            className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-xs"
          >
            {(Object.keys(SORT_LABEL) as SortKey[]).map((k) => (
              <option key={k} value={k}>
                {SORT_LABEL[k]}
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
          <span>My pursuits only</span>
        </label>
        <button
          type="submit"
          className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1"
        >
          Apply
        </button>
        {(mineOnly || sort !== 'updated') && (
          <a href="/capture/pipeline" className="text-[color:var(--color-muted-foreground)] hover:underline">
            Clear
          </a>
        )}
      </form>

      <div className="flex-1 overflow-auto">
        <div className="flex min-w-max gap-3 px-6 py-4">
          {STAGE_ORDER.map((stage) => {
            const cards = filteredByStage.get(stage) ?? [];
            const tcv = sumValueUsd(cards);
            const prevStage = STAGE_ORDER[STAGE_ORDER.indexOf(stage) - 1];
            const nextStage = STAGE_ORDER[STAGE_ORDER.indexOf(stage) + 1];
            return (
              <section
                key={stage}
                className="flex w-[280px] shrink-0 flex-col rounded-[var(--radius-md)] bg-[color:var(--color-muted)]/30"
              >
                <header className="border-b border-[color:var(--color-border)] px-3 py-2.5">
                  <div className="flex items-baseline justify-between">
                    <h2 className="text-[13px] font-semibold">{STAGE_LABEL[stage]}</h2>
                    <span className="text-[11px] text-[color:var(--color-muted-foreground)]">
                      {cards.length}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[11px] text-[color:var(--color-muted-foreground)]">
                    {tcv != null ? `${formatMoney(tcv, 'USD')} TCV` : '—'}
                  </p>
                </header>

                <div className="flex flex-col gap-2 p-2">
                  {cards.map((card) => (
                    <div key={card.id} className="group relative">
                      <PursuitCard card={card} />
                      <div className="pointer-events-none absolute right-1.5 top-1.5 flex gap-1 opacity-0 transition group-hover:pointer-events-auto group-hover:opacity-100">
                        {prevStage && (
                          <form action={moveStageAction}>
                            <input type="hidden" name="pursuitId" value={card.id} />
                            <input type="hidden" name="stage" value={prevStage} />
                            <button
                              type="submit"
                              title={`Move back to ${STAGE_LABEL[prevStage]}`}
                              className="rounded border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-1.5 py-0.5 text-[10px] hover:border-[color:var(--color-foreground)]"
                            >
                              ←
                            </button>
                          </form>
                        )}
                        {nextStage && (
                          <form action={moveStageAction}>
                            <input type="hidden" name="pursuitId" value={card.id} />
                            <input type="hidden" name="stage" value={nextStage} />
                            <button
                              type="submit"
                              title={`Advance to ${STAGE_LABEL[nextStage]}`}
                              className="rounded border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-1.5 py-0.5 text-[10px] hover:border-[color:var(--color-foreground)]"
                            >
                              →
                            </button>
                          </form>
                        )}
                      </div>
                    </div>
                  ))}
                  {cards.length === 0 && (
                    <p className="rounded-[var(--radius-md)] border border-dashed border-[color:var(--color-border)] p-3 text-center text-[11px] text-[color:var(--color-muted-foreground)]">
                      No pursuits
                    </p>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function isSortKey(v: string | undefined): v is SortKey {
  return v === 'updated' || v === 'deadline' || v === 'value' || v === 'pwin';
}

function comparator(sort: SortKey) {
  return (a: PursuitCardData, b: PursuitCardData) => {
    switch (sort) {
      case 'deadline': {
        const at = a.opportunity.deadlineAt?.getTime() ?? Number.POSITIVE_INFINITY;
        const bt = b.opportunity.deadlineAt?.getTime() ?? Number.POSITIVE_INFINITY;
        return at - bt;
      }
      case 'value': {
        const av = parseValueUsd(a.opportunity.valueEstimateUsd) ?? 0;
        const bv = parseValueUsd(b.opportunity.valueEstimateUsd) ?? 0;
        return bv - av;
      }
      case 'pwin': {
        const ap = a.pWin ?? -1;
        const bp = b.pWin ?? -1;
        return bp - ap;
      }
      case 'updated':
      default:
        return b.updatedAt.getTime() - a.updatedAt.getTime();
    }
  };
}

function parseValueUsd(s: string | null): number | null {
  if (!s) return null;
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function sumValueUsd(cards: PursuitCardData[]): number | null {
  let total = 0;
  let any = false;
  for (const c of cards) {
    const v = parseValueUsd(c.opportunity.valueEstimateUsd);
    if (v != null) {
      total += v;
      any = true;
    }
  }
  return any ? total : null;
}
