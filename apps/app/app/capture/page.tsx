import Link from 'next/link';
import { requireCompany } from '@procur/auth';
import {
  getCaptureDashboardData,
  getCompanyStageCounts,
  STAGE_LABEL,
  STAGE_ORDER,
  type PursuitStageKey,
} from '../../lib/capture-queries';
import {
  ActiveOpportunitiesWidget,
  CaptureQuestionsWidget,
  PipelineByValueWidget,
  TasksWidget,
} from './components/widgets';
import { CaptureViewSwitcher } from './components/view-switcher';

export const dynamic = 'force-dynamic';

export default async function CaptureDashboardPage() {
  const { user, company } = await requireCompany();
  const [counts, dashboard] = await Promise.all([
    getCompanyStageCounts(company.id),
    getCaptureDashboardData(company.id, user.id),
  ]);

  const onFreeTier = company.planTier === 'free';
  const FREE_CAP = 5;
  const approaching = onFreeTier && dashboard.activeOpportunities.activePursuits >= FREE_CAP - 1;

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Capture</h1>
          <div className="mt-2">
            <CaptureViewSwitcher active="dashboard" />
          </div>
        </div>
        <Link
          href="/capture/new"
          className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-3 py-1.5 text-xs font-medium text-[color:var(--color-background)]"
        >
          + New pursuit
        </Link>
      </header>

      {approaching && (
        <div className="mb-4 rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-muted)]/40 p-3 text-sm">
          You&rsquo;re at {dashboard.activeOpportunities.activePursuits}/{FREE_CAP} pursuits on the
          free plan.{' '}
          <Link className="underline" href="/billing">
            Upgrade to Pro
          </Link>{' '}
          for unlimited pursuits.
        </div>
      )}

      {/* 4-up widget grid mirroring GovDash's Capture Dashboard. Each widget
          is server-rendered from getCaptureDashboardData, no client JS. */}
      <div className="grid gap-4 md:grid-cols-2">
        <TasksWidget data={dashboard.tasks} />
        <CaptureQuestionsWidget data={dashboard.captureQuestions} />
        <PipelineByValueWidget data={dashboard.pipelineByValueUsd} />
        <ActiveOpportunitiesWidget data={dashboard.activeOpportunities} />
      </div>

      {/* Stage counts strip — kept for at-a-glance navigation by stage. */}
      <section className="mt-8">
        <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
          By stage
        </h2>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-7">
          {STAGE_ORDER.map((stage) => (
            <StageCount key={stage} stage={stage} count={counts.get(stage) ?? 0} />
          ))}
        </div>
      </section>
    </div>
  );
}

function StageCount({ stage, count }: { stage: PursuitStageKey; count: number }) {
  return (
    <Link
      href={`/capture/pursuits?stage=${stage}`}
      className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] p-3 text-center transition hover:border-[color:var(--color-foreground)]"
    >
      <p className="text-lg font-semibold">{count}</p>
      <p className="text-[11px] text-[color:var(--color-muted-foreground)]">{STAGE_LABEL[stage]}</p>
    </Link>
  );
}
