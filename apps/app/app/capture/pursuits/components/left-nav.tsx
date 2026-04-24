import Link from 'next/link';

export type TabKey =
  | 'overview'
  | 'activity'
  | 'capture-questions'
  | 'tasks'
  | 'gate-reviews'
  | 'teaming'
  | 'documents';

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'overview', label: 'Overview' },
  { key: 'activity', label: 'Activity' },
  { key: 'capture-questions', label: 'Capture Questions' },
  { key: 'tasks', label: 'Tasks' },
  { key: 'gate-reviews', label: 'Gate Reviews' },
  { key: 'teaming', label: 'Teaming' },
  { key: 'documents', label: 'Documents' },
];

export function isTabKey(v: string | undefined): v is TabKey {
  return (
    v === 'overview' ||
    v === 'activity' ||
    v === 'capture-questions' ||
    v === 'tasks' ||
    v === 'gate-reviews' ||
    v === 'teaming' ||
    v === 'documents'
  );
}

/**
 * Left mini-nav for the pursuit detail page. Two groups:
 *   "Opportunity" — tabbed content sections
 *   "Capture Plan" — clickable stage indicators (active stage highlighted)
 *
 * Mirrors the left-rail pattern from GovDash Screenshot 1.22.07 PM while
 * keeping our existing stage vocabulary (identification → lost) and our
 * existing moveStageAction server action.
 */
import type { PursuitStageKey } from '../../../../lib/capture-queries';
import { STAGE_LABEL, STAGE_ORDER } from '../../../../lib/capture-queries';
import { moveStageAction } from '../../actions';

export function PursuitLeftNav({
  pursuitId,
  activeTab,
  activeStage,
  canAdvanceToProposal,
  captureAnswersCount,
  totalCaptureQuestions,
  openTaskCount,
}: {
  pursuitId: string;
  activeTab: TabKey;
  activeStage: PursuitStageKey;
  canAdvanceToProposal: boolean;
  captureAnswersCount: number;
  totalCaptureQuestions: number;
  openTaskCount: number;
}) {
  const captureRemaining = Math.max(0, totalCaptureQuestions - captureAnswersCount);

  return (
    <aside className="w-full shrink-0 space-y-5 md:w-52">
      <div>
        <p className="mb-1.5 px-2 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
          Opportunity
        </p>
        <nav className="flex flex-col gap-0.5 text-sm">
          {TABS.map((t) => {
            const isActive = t.key === activeTab;
            const badge =
              t.key === 'capture-questions' && captureRemaining > 0
                ? captureRemaining.toString()
                : t.key === 'tasks' && openTaskCount > 0
                  ? openTaskCount.toString()
                  : null;
            return (
              <Link
                key={t.key}
                href={`/capture/pursuits/${pursuitId}?tab=${t.key}`}
                className={`flex items-center justify-between rounded-[var(--radius-sm)] px-2 py-1 text-sm transition ${
                  isActive
                    ? 'bg-[color:var(--color-foreground)] text-[color:var(--color-background)]'
                    : 'text-[color:var(--color-foreground)]/85 hover:bg-[color:var(--color-muted)]/40'
                }`}
              >
                <span>{t.label}</span>
                {badge && (
                  <span
                    className={`rounded-full px-1.5 py-0.5 text-[10px] ${
                      isActive
                        ? 'bg-[color:var(--color-background)]/20 text-[color:var(--color-background)]'
                        : 'bg-[color:var(--color-muted)]/60 text-[color:var(--color-muted-foreground)]'
                    }`}
                  >
                    {badge}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>
      </div>

      <div>
        <p className="mb-1.5 px-2 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
          Capture plan
        </p>
        <div className="flex flex-col gap-0.5 text-sm">
          {STAGE_ORDER.map((stage, i) => {
            const activeIndex = STAGE_ORDER.indexOf(activeStage);
            const thisIndex = i;
            const isActive = stage === activeStage;
            const isPast = thisIndex < activeIndex;
            const blocked =
              stage === 'proposal_development' &&
              !canAdvanceToProposal &&
              activeStage !== 'proposal_development';
            return (
              <form key={stage} action={moveStageAction}>
                <input type="hidden" name="pursuitId" value={pursuitId} />
                <input type="hidden" name="stage" value={stage} />
                <button
                  type="submit"
                  disabled={isActive || blocked}
                  title={blocked ? 'Answer capture questions first' : `Move to ${STAGE_LABEL[stage]}`}
                  className={`flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1 text-left text-xs transition ${
                    isActive
                      ? 'bg-[color:var(--color-muted)]/60 font-medium text-[color:var(--color-foreground)]'
                      : isPast
                        ? 'text-[color:var(--color-muted-foreground)] hover:bg-[color:var(--color-muted)]/40'
                        : blocked
                          ? 'cursor-not-allowed text-[color:var(--color-muted-foreground)]/60'
                          : 'text-[color:var(--color-foreground)]/85 hover:bg-[color:var(--color-muted)]/40'
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      isActive
                        ? 'bg-[color:var(--color-foreground)]'
                        : isPast
                          ? 'bg-emerald-500'
                          : 'bg-[color:var(--color-border)]'
                    }`}
                  />
                  <span>{STAGE_LABEL[stage]}</span>
                </button>
              </form>
            );
          })}
        </div>
      </div>
    </aside>
  );
}
