import { requireCompany } from '@procur/auth';
import {
  listPursuitsByStage,
  STAGE_LABEL,
  STAGE_ORDER,
} from '../../../lib/capture-queries';
import { PursuitCard } from '../components/pursuit-card';
import { moveStageAction } from '../actions';

export const dynamic = 'force-dynamic';

export default async function PipelinePage() {
  const { company } = await requireCompany();
  const byStage = await listPursuitsByStage(company.id);

  return (
    <div className="p-6">
      <header className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Pipeline</h1>
          <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">
            Drag a card… well, click the arrow to advance the stage. Drag-and-drop coming
            soon.
          </p>
        </div>
      </header>

      <div className="flex gap-4 overflow-x-auto pb-4">
        {STAGE_ORDER.map((stage) => {
          const cards = byStage.get(stage) ?? [];
          const prevStage = STAGE_ORDER[STAGE_ORDER.indexOf(stage) - 1];
          const nextStage = STAGE_ORDER[STAGE_ORDER.indexOf(stage) + 1];
          return (
            <section
              key={stage}
              className="flex w-72 shrink-0 flex-col gap-3 rounded-[var(--radius-lg)] bg-[color:var(--color-muted)]/40 p-3"
            >
              <header className="flex items-baseline justify-between px-1">
                <h2 className="text-sm font-semibold">{STAGE_LABEL[stage]}</h2>
                <span className="text-xs text-[color:var(--color-muted-foreground)]">
                  {cards.length}
                </span>
              </header>

              <div className="flex flex-col gap-2">
                {cards.map((card) => (
                  <div key={card.id} className="group relative">
                    <PursuitCard card={card} />
                    <div className="pointer-events-none absolute right-2 top-2 flex gap-1 opacity-0 transition group-hover:pointer-events-auto group-hover:opacity-100">
                      {prevStage && (
                        <form action={moveStageAction}>
                          <input type="hidden" name="pursuitId" value={card.id} />
                          <input type="hidden" name="stage" value={prevStage} />
                          <button
                            type="submit"
                            title={`Move back to ${STAGE_LABEL[prevStage]}`}
                            className="rounded border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-1.5 py-0.5 text-xs hover:border-[color:var(--color-foreground)]"
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
                            className="rounded border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-1.5 py-0.5 text-xs hover:border-[color:var(--color-foreground)]"
                          >
                            →
                          </button>
                        </form>
                      )}
                    </div>
                  </div>
                ))}
                {cards.length === 0 && (
                  <p className="rounded-[var(--radius-md)] border border-dashed border-[color:var(--color-border)] p-3 text-center text-xs text-[color:var(--color-muted-foreground)]">
                    No pursuits
                  </p>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
