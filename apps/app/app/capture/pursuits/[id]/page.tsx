import { notFound } from 'next/navigation';
import Link from 'next/link';
import { requireCompany } from '@procur/auth';
import {
  getPursuitById,
  getPursuitRaw,
  listPursuitTasks,
  STAGE_LABEL,
  STAGE_ORDER,
  TERMINAL_STAGES,
} from '../../../../lib/capture-queries';
import { flagFor, formatDate, formatMoney, timeUntil } from '../../../../lib/format';
import {
  addTaskAction,
  moveStageAction,
  saveCaptureAnswersAction,
  toggleTaskAction,
  updatePursuitAction,
} from '../../actions';

export const dynamic = 'force-dynamic';

type Params = { id: string };

const CAPTURE_QUESTION_BLANK = {
  winThemes: [],
  customerBudget: null,
  customerPainPoints: [],
  incumbents: [],
  competitors: [],
  differentiators: [],
  risksAndMitigations: [],
  teamPartners: [],
  customerRelationships: [],
};

export default async function PursuitDetailPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { id } = await params;
  const { company } = await requireCompany();
  const card = await getPursuitById(company.id, id);
  if (!card) notFound();

  const [raw, tasks] = await Promise.all([
    getPursuitRaw(company.id, id),
    listPursuitTasks(id),
  ]);
  const captureAnswers = (raw?.captureAnswers as Record<string, unknown> | null) ?? CAPTURE_QUESTION_BLANK;
  const canAdvanceToProposal = hasCoreCaptureAnswers(captureAnswers);

  const op = card.opportunity;
  const countdown = timeUntil(op.deadlineAt);
  const value = formatMoney(op.valueEstimate, op.currency);

  const openTasks = tasks.filter((t) => !t.completedAt);
  const doneTasks = tasks.filter((t) => t.completedAt);

  return (
    <div className="mx-auto max-w-5xl px-8 py-10">
      <nav className="mb-4 text-sm text-[color:var(--color-muted-foreground)]">
        <Link href="/capture" className="hover:underline">
          Capture
        </Link>
        <span> / </span>
        <Link href="/capture/pursuits" className="hover:underline">
          Pursuits
        </Link>
      </nav>

      <header className="mb-8 flex items-start gap-4">
        <span aria-label={op.jurisdictionName} className="text-3xl leading-none">
          {flagFor(op.jurisdictionCountry)}
        </span>
        <div className="flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">{op.title}</h1>
          <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">
            {op.jurisdictionName}
            {op.agencyName && <> · {op.agencyName}</>}
            {op.referenceNumber && <> · {op.referenceNumber}</>}
          </p>
        </div>
        {op.slug && (
          <a
            href={`${process.env.NEXT_PUBLIC_DISCOVER_URL ?? 'https://discover.procur.app'}/opportunities/${op.slug}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm underline"
          >
            View on Discover ↗
          </a>
        )}
      </header>

      <section className="mb-8 grid gap-4 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-6 md:grid-cols-4">
        <Fact label="Stage" value={STAGE_LABEL[card.stage]} />
        <Fact
          label="Closes"
          value={op.deadlineAt ? formatDate(op.deadlineAt) : '—'}
          sub={countdown && countdown !== 'closed' ? `in ${countdown}` : undefined}
        />
        <Fact label="Value" value={value ?? '—'} />
        <Fact
          label="P(Win)"
          value={card.pWin != null ? `${Math.round(card.pWin * 100)}%` : '—'}
        />
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
          Stage
        </h2>
        <div className="flex flex-wrap gap-2">
          {STAGE_ORDER.map((stage) => {
            const isCurrent = card.stage === stage;
            const blocked =
              stage === 'proposal_development' &&
              !canAdvanceToProposal &&
              card.stage !== 'proposal_development';
            return (
              <form key={stage} action={moveStageAction}>
                <input type="hidden" name="pursuitId" value={card.id} />
                <input type="hidden" name="stage" value={stage} />
                <button
                  type="submit"
                  disabled={isCurrent || blocked}
                  title={blocked ? 'Answer capture questions first' : undefined}
                  className={`rounded-full border px-3 py-1 text-xs transition ${
                    isCurrent
                      ? 'border-[color:var(--color-foreground)] bg-[color:var(--color-foreground)] text-[color:var(--color-background)]'
                      : blocked
                        ? 'cursor-not-allowed border-[color:var(--color-border)] opacity-50'
                        : 'border-[color:var(--color-border)] hover:border-[color:var(--color-foreground)]'
                  }`}
                >
                  {STAGE_LABEL[stage]}
                </button>
              </form>
            );
          })}
        </div>
        {TERMINAL_STAGES.includes(card.stage) && (
          <p className="mt-2 text-xs text-[color:var(--color-muted-foreground)]">
            This pursuit is closed. Move it back to a prior stage to continue work.
          </p>
        )}
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
          Quick edit
        </h2>
        <form
          action={updatePursuitAction}
          className="grid gap-3 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4 md:grid-cols-3"
        >
          <input type="hidden" name="pursuitId" value={card.id} />
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-[color:var(--color-muted-foreground)]">
              P(Win) — 0.00 to 1.00
            </span>
            <input
              name="pWin"
              type="number"
              step="0.05"
              min="0"
              max="1"
              defaultValue={card.pWin ?? ''}
              className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm md:col-span-2">
            <span className="text-xs text-[color:var(--color-muted-foreground)]">Notes</span>
            <input
              name="notes"
              type="text"
              defaultValue={card.notes ?? ''}
              placeholder="Internal notes"
              className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1"
            />
          </label>
          <div className="md:col-span-3">
            <button
              type="submit"
              className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-3 py-1.5 text-sm text-[color:var(--color-background)]"
            >
              Save
            </button>
          </div>
        </form>
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
          Capture questions
          {!canAdvanceToProposal && (
            <span className="ml-2 rounded-full bg-[color:var(--color-brand)]/10 px-2 py-0.5 text-xs font-normal text-[color:var(--color-brand)]">
              Required before Proposal Development
            </span>
          )}
        </h2>
        <form
          action={saveCaptureAnswersAction}
          className="rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4"
        >
          <input type="hidden" name="pursuitId" value={card.id} />
          <label className="block text-xs text-[color:var(--color-muted-foreground)]">
            Answer the 7 capture questions as JSON. A UI form lands next week — this is the
            temporary editor.
          </label>
          <textarea
            name="answers"
            defaultValue={JSON.stringify(captureAnswers, null, 2)}
            className="mt-2 h-64 w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-2 font-mono text-xs"
          />
          <div className="mt-3 flex items-center justify-between">
            <p className="text-xs text-[color:var(--color-muted-foreground)]">
              Expected keys: winThemes, customerBudget, customerPainPoints, incumbents,
              competitors, differentiators, risksAndMitigations, teamPartners,
              customerRelationships.
            </p>
            <button
              type="submit"
              className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-3 py-1.5 text-sm text-[color:var(--color-background)]"
            >
              Save answers
            </button>
          </div>
        </form>
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
          Tasks ({openTasks.length} open)
        </h2>

        <form
          action={addTaskAction}
          className="mb-4 flex flex-wrap items-end gap-2 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4"
        >
          <input type="hidden" name="pursuitId" value={card.id} />
          <label className="flex flex-1 flex-col gap-1 text-sm">
            <span className="text-xs text-[color:var(--color-muted-foreground)]">
              New task
            </span>
            <input
              name="title"
              required
              placeholder="Meet with customer / Research incumbent / Draft past performance"
              className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-[color:var(--color-muted-foreground)]">Due</span>
            <input
              name="dueDate"
              type="date"
              className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-[color:var(--color-muted-foreground)]">Category</span>
            <select
              name="category"
              className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1"
            >
              <option value="">—</option>
              <option value="research">Research</option>
              <option value="outreach">Outreach</option>
              <option value="drafting">Drafting</option>
              <option value="review">Review</option>
              <option value="submission">Submission</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-[color:var(--color-muted-foreground)]">Priority</span>
            <select
              name="priority"
              defaultValue="medium"
              className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1"
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>
          </label>
          <button
            type="submit"
            className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-3 py-1.5 text-sm text-[color:var(--color-background)]"
          >
            Add
          </button>
        </form>

        <ul className="space-y-2">
          {openTasks.map((t) => (
            <li
              key={t.id}
              className="flex items-start justify-between rounded-[var(--radius-md)] border border-[color:var(--color-border)] p-3"
            >
              <div className="flex items-start gap-3">
                <form action={toggleTaskAction} className="mt-0.5">
                  <input type="hidden" name="taskId" value={t.id} />
                  <input type="hidden" name="pursuitId" value={card.id} />
                  <button
                    type="submit"
                    className="h-4 w-4 rounded border border-[color:var(--color-border)] bg-[color:var(--color-background)] hover:border-[color:var(--color-foreground)]"
                    aria-label="Mark complete"
                  />
                </form>
                <div>
                  <p className="text-sm font-medium">{t.title}</p>
                  <p className="mt-0.5 text-xs text-[color:var(--color-muted-foreground)]">
                    {t.dueDate && <>Due {t.dueDate} · </>}
                    {t.category && <>{t.category} · </>}
                    {t.priority}
                  </p>
                </div>
              </div>
            </li>
          ))}
          {doneTasks.length > 0 && (
            <>
              <li className="pt-3 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
                Completed ({doneTasks.length})
              </li>
              {doneTasks.map((t) => (
                <li
                  key={t.id}
                  className="flex items-start justify-between rounded-[var(--radius-md)] border border-[color:var(--color-border)] p-3 opacity-60"
                >
                  <div className="flex items-start gap-3">
                    <form action={toggleTaskAction} className="mt-0.5">
                      <input type="hidden" name="taskId" value={t.id} />
                      <input type="hidden" name="pursuitId" value={card.id} />
                      <button
                        type="submit"
                        className="h-4 w-4 rounded border border-[color:var(--color-foreground)] bg-[color:var(--color-foreground)] text-[color:var(--color-background)]"
                        aria-label="Mark incomplete"
                      >
                        ✓
                      </button>
                    </form>
                    <p className="text-sm line-through">{t.title}</p>
                  </div>
                </li>
              ))}
            </>
          )}
          {tasks.length === 0 && (
            <li className="rounded-[var(--radius-md)] border border-dashed border-[color:var(--color-border)] p-6 text-center text-sm text-[color:var(--color-muted-foreground)]">
              No tasks yet — add the first one above.
            </li>
          )}
        </ul>
      </section>
    </div>
  );
}

function Fact({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
        {label}
      </p>
      <p className="mt-1 text-base font-semibold">{value}</p>
      {sub && <p className="text-xs text-[color:var(--color-muted-foreground)]">{sub}</p>}
    </div>
  );
}

function hasCoreCaptureAnswers(a: Record<string, unknown>): boolean {
  const winThemes = Array.isArray(a.winThemes) ? a.winThemes : [];
  const differentiators = Array.isArray(a.differentiators) ? a.differentiators : [];
  const bid = a.bidDecision;
  return (
    winThemes.length > 0 &&
    differentiators.length > 0 &&
    (bid === 'bid' || bid === 'no_bid' || bid === undefined || bid === null)
  );
}
