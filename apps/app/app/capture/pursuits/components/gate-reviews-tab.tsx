import {
  GATE_STAGE_LABEL,
  GATE_STAGES,
  type GateReviewRow,
  type GateStage,
} from '../../../../lib/gate-review-queries';
import type { GateReviewCriterion, GateReviewDecision } from '@procur/db';
import { formatDate } from '../../../../lib/format';
import { chipClass, type ChipTone } from '../../../../lib/chips';
import {
  createGateReviewAction,
  deleteGateReviewAction,
  toggleGateCriterionAction,
  updateGateReviewAction,
} from '../../actions';

const DECISION_LABEL: Record<GateReviewDecision, string> = {
  pending: 'Pending',
  pass: 'Pass',
  conditional: 'Conditional',
  fail: 'Fail',
};

const DECISION_TONE: Record<GateReviewDecision, ChipTone> = {
  pending: 'neutral',
  pass: 'success',
  conditional: 'warning',
  fail: 'danger',
};

const STATUS_LABEL: Record<GateReviewCriterion['status'], string> = {
  not_assessed: '—',
  met: 'Met',
  partially_met: 'Partial',
  not_met: 'Not met',
  na: 'N/A',
};

const STATUS_TONE: Record<GateReviewCriterion['status'], ChipTone> = {
  not_assessed: 'neutral',
  met: 'success',
  partially_met: 'warning',
  not_met: 'danger',
  na: 'neutral',
};

/**
 * Gate Reviews tab. Lists every gate review on this pursuit, newest
 * first. Each review is a collapsible card showing the per-criterion
 * checklist + a decision dropdown + free-form summary. Reviewers
 * toggle criteria via a select per row (no separate modal).
 *
 * The "+ New review" bar at the top creates a fresh review for the
 * chosen gate stage, pre-seeded with the default criteria for that
 * stage (see DEFAULT_GATE_CRITERIA in lib/gate-review-queries.ts).
 */
export function GateReviewsTab({
  pursuitId,
  reviews,
}: {
  pursuitId: string;
  reviews: GateReviewRow[];
}) {
  // Suggest the next stage whose existing reviews are all in terminal
  // states. Helps a capture manager pick the right next gate without
  // having to know the sequence.
  const suggestedStage = nextSuggestedStage(reviews);

  return (
    <div className="space-y-4">
      {/* New review bar */}
      <section className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-4">
        <h2 className="mb-1 text-sm font-semibold">Start a gate review</h2>
        <p className="mb-3 text-xs text-[color:var(--color-muted-foreground)]">
          Each gate seeds with a default checklist you can edit, tick off,
          and sign off with a decision. Stages are free-form — use one of
          the suggestions or type your own.
        </p>
        <form action={createGateReviewAction} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="pursuitId" value={pursuitId} />
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[11px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
              Gate
            </span>
            <select
              name="stage"
              defaultValue={suggestedStage}
              className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-sm"
            >
              {GATE_STAGES.map((s) => (
                <option key={s} value={s}>
                  {GATE_STAGE_LABEL[s]}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-3 py-1.5 text-sm font-medium text-[color:var(--color-background)]"
          >
            + Start review
          </button>
        </form>
      </section>

      {reviews.length === 0 ? (
        <section className="rounded-[var(--radius-md)] border border-dashed border-[color:var(--color-border)] p-8 text-center text-sm text-[color:var(--color-muted-foreground)]">
          No gate reviews yet. Start one above to track stage-gate sign-off.
        </section>
      ) : (
        <div className="space-y-3">
          {reviews.map((r) => (
            <GateReviewCard key={r.id} review={r} />
          ))}
        </div>
      )}
    </div>
  );
}

function GateReviewCard({ review }: { review: GateReviewRow }) {
  const decisionTone = DECISION_TONE[review.decision];
  const stageLabel =
    GATE_STAGE_LABEL[review.stage as GateStage] ??
    review.stage.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

  const criteria = (review.criteria ?? []).slice().sort((a, b) => a.sortOrder - b.sortOrder);
  const metCount = criteria.filter((c) => c.status === 'met').length;
  const assessedCount = criteria.filter((c) => c.status !== 'not_assessed').length;

  // Default the card open when decision is still pending (active work)
  // and collapsed once signed off so the list stays scannable.
  const defaultOpen = review.decision === 'pending';

  return (
    <details
      open={defaultOpen}
      className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)]"
    >
      <summary className="flex cursor-pointer items-center justify-between gap-3 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <span className="text-sm font-semibold">{stageLabel}</span>
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${chipClass(decisionTone)}`}
          >
            {DECISION_LABEL[review.decision]}
          </span>
          <span className="text-[11px] text-[color:var(--color-muted-foreground)]">
            {metCount}/{criteria.length} met · {assessedCount}/{criteria.length} assessed
          </span>
        </div>
        <div className="shrink-0 text-[11px] text-[color:var(--color-muted-foreground)]">
          {review.reviewerName && <>by {review.reviewerName} · </>}
          {review.completedAt
            ? `completed ${formatDate(review.completedAt)}`
            : `opened ${formatDate(review.createdAt)}`}
        </div>
      </summary>

      <div className="border-t border-[color:var(--color-border)] p-4">
        {/* Criteria list */}
        <ul className="space-y-2">
          {criteria.map((c) => (
            <li
              key={c.id}
              className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)]/60 p-2"
            >
              <form action={toggleGateCriterionAction} className="flex flex-wrap items-start gap-2">
                <input type="hidden" name="gateReviewId" value={review.id} />
                <input type="hidden" name="criterionId" value={c.id} />
                <div className="flex-1 min-w-[180px]">
                  <p className="text-xs font-medium">{c.label}</p>
                  {c.comment && (
                    <p className="mt-0.5 text-[11px] text-[color:var(--color-muted-foreground)]">
                      {c.comment}
                    </p>
                  )}
                </div>
                <select
                  name="status"
                  defaultValue={c.status}
                  className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${chipClass(STATUS_TONE[c.status])}`}
                >
                  {(Object.keys(STATUS_LABEL) as Array<GateReviewCriterion['status']>).map((s) => (
                    <option key={s} value={s}>
                      {STATUS_LABEL[s]}
                    </option>
                  ))}
                </select>
                <input
                  name="comment"
                  defaultValue={c.comment ?? ''}
                  placeholder="Note (optional)"
                  className="w-56 rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-0.5 text-[11px]"
                />
                <button
                  type="submit"
                  className="text-[10px] underline text-[color:var(--color-muted-foreground)]"
                >
                  Save
                </button>
              </form>
            </li>
          ))}
        </ul>

        {/* Decision + summary */}
        <form
          action={updateGateReviewAction}
          className="mt-4 grid gap-3 rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-muted)]/30 p-3 md:grid-cols-[1fr_auto]"
        >
          <input type="hidden" name="gateReviewId" value={review.id} />
          <label className="block">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
              Summary
            </span>
            <textarea
              name="summary"
              rows={2}
              defaultValue={review.summary ?? ''}
              placeholder="Reviewer notes — what's the decision based on?"
              className="mt-1 w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-xs"
            />
          </label>
          <div className="flex flex-col justify-end gap-2">
            <label className="block">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
                Decision
              </span>
              <select
                name="decision"
                defaultValue={review.decision}
                className="mt-1 w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
              >
                <option value="pending">Pending</option>
                <option value="pass">Pass</option>
                <option value="conditional">Conditional</option>
                <option value="fail">Fail</option>
              </select>
            </label>
            <button
              type="submit"
              className="rounded-[var(--radius-sm)] bg-[color:var(--color-foreground)] px-3 py-1.5 text-xs font-medium text-[color:var(--color-background)]"
            >
              Save decision
            </button>
          </div>
        </form>

        {/* Delete */}
        <form action={deleteGateReviewAction} className="mt-3 text-right">
          <input type="hidden" name="gateReviewId" value={review.id} />
          <button
            type="submit"
            className="text-[10px] text-[color:var(--color-muted-foreground)] hover:text-red-600"
          >
            Delete review
          </button>
        </form>
      </div>
    </details>
  );
}

/**
 * Pick a reasonable default gate to pre-select in the "Start a review"
 * dropdown. Prefers the earliest gate stage that either has no review
 * yet or only has non-pass reviews, so the form suggests "the next one
 * to do" rather than making the user pick every time.
 */
function nextSuggestedStage(reviews: GateReviewRow[]): GateStage {
  for (const stage of GATE_STAGES) {
    const here = reviews.filter((r) => r.stage === stage);
    if (here.length === 0) return stage;
    const passed = here.some((r) => r.decision === 'pass');
    if (!passed) return stage;
  }
  return 'qualification';
}
