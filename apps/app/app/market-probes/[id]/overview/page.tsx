import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireCompany } from '@procur/auth';
import {
  computeProbeScorecard,
  getProbe,
  listHypothesesForProbe,
  listTargetsForProbe,
} from '@procur/catalog';
import { CopyMarkdownToolbar } from '../../../_components/CopyMarkdownToolbar';
import { formatOverviewMarkdown } from '../../_lib/markdown';
import {
  approveFallbackPlanAction,
  autopilotSendBatchAction,
  generatePlanAction,
} from '../../actions';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ id: string }>;
}

/**
 * Probe overview. Status-aware:
 *
 * - planning: review-and-start surface. Operator scans the
 *   auto-assembled plan + hypothesis + top targets + drafter steering,
 *   then hits "Approve & start probe" which promotes status to active
 *   and kicks off the first autopilot batch (which JIT-enriches Apollo
 *   contacts for targets missing them).
 * - active: scorecard + next-batch CTA. Operator sees what's been
 *   sent and triggers the next batch when ready.
 *
 * Plan tab, Targets tab, etc. still own the deep-dive surfaces; this
 * page is the operator's launch + ongoing-control hub.
 */
export default async function ProbeOverviewPage({ params }: PageProps) {
  await requireCompany();
  const { id } = await params;
  const probe = await getProbe(id);
  if (!probe) notFound();
  const [scorecard, targets, hypotheses] = await Promise.all([
    computeProbeScorecard(id),
    listTargetsForProbe(id),
    listHypothesesForProbe(id),
  ]);

  const plan = probe.planJson ?? {};
  const markdown = formatOverviewMarkdown(probe, {
    scorecard,
    planGenerationStatus: plan.generationStatus,
    planGenerationError: plan.generationError,
  });

  const isPlanning = probe.status === 'planning';
  const isFallbackPlan =
    plan.generationStatus && plan.generationStatus !== 'ok';
  const topTargets = targets.slice(0, 8);
  const fitCounts = {
    A: targets.filter((t) => t.fitTier === 'A').length,
    B: targets.filter((t) => t.fitTier === 'B').length,
    C: targets.filter((t) => t.fitTier === 'C').length,
    D: targets.filter((t) => t.fitTier === 'D').length,
  };
  const topHypothesis = hypotheses[0];

  return (
    <>
      <CopyMarkdownToolbar
        markdown={markdown}
        slug={`probe-${probe.id}-overview`}
      />
      {isFallbackPlan && (
        <FallbackPlanBanner
          probeId={probe.id}
          generationStatus={plan.generationStatus}
          generationError={plan.generationError}
        />
      )}

      {isPlanning && !isFallbackPlan && (
        <ApprovalHero
          probe={probe}
          targetCount={targets.length}
          fitCounts={fitCounts}
          topTargets={topTargets}
          topHypothesis={topHypothesis}
        />
      )}

      {!isPlanning && (
        <ActiveProbeHero probe={probe} targetCount={targets.length} />
      )}

      {scorecard && (
        <section className="mb-6 grid grid-cols-2 gap-3 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4 md:grid-cols-5">
          <ScoreCell label="Reply rate" value={`${Math.round(scorecard.replyRate * 100)}%`} sub={`${scorecard.repliedCount} / ${scorecard.sentCount}`} />
          <ScoreCell
            label="Routing rate"
            value={`${Math.round(scorecard.routingRate * 100)}%`}
            sub="positive + routing replies"
          />
          <ScoreCell
            label="Bounce rate"
            value={`${Math.round(scorecard.bounceRate * 100)}%`}
            sub={`${scorecard.bouncedCount} bounced`}
            warn={scorecard.bounceRate > 0.08}
          />
          <ScoreCell
            label="Atlas facts"
            value={String(scorecard.atlasFactsCount)}
            sub={`${scorecard.atlasNegativeRulesCount} negative rules`}
          />
          <ScoreCell
            label="Overall learning"
            value={String(scorecard.scores.overallLearning)}
            sub="composite (0-100)"
          />
        </section>
      )}
    </>
  );
}

function ApprovalHero({
  probe,
  targetCount,
  fitCounts,
  topTargets,
  topHypothesis,
}: {
  probe: NonNullable<Awaited<ReturnType<typeof getProbe>>>;
  targetCount: number;
  fitCounts: { A: number; B: number; C: number; D: number };
  topTargets: Awaited<ReturnType<typeof listTargetsForProbe>>;
  topHypothesis:
    | Awaited<ReturnType<typeof listHypothesesForProbe>>[number]
    | undefined;
}) {
  const plan = probe.planJson ?? {};
  const hasPlan = Boolean(plan.hypothesis);
  const canStart = hasPlan && targetCount > 0;
  return (
    <section className="mb-6 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] bg-[color:var(--color-muted)]/30 p-5">
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <h2 className="text-lg font-semibold">Review and start</h2>
        <span className="text-[11px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
          Status: planning
        </span>
      </div>
      <p className="mb-4 max-w-3xl text-sm text-[color:var(--color-muted-foreground)]">
        The probe auto-assembled a plan + targets when you created it.
        Skim the summary below and approve to start outreach. Apollo
        contact discovery runs automatically on the first batch — you
        don&apos;t need to find contacts manually.
      </p>

      <div className="grid gap-4 md:grid-cols-2">
        <SummaryCard title="Plan" linkHref={`/market-probes/${probe.id}/plan`} linkLabel="Edit plan">
          {!hasPlan && (
            <p className="text-xs text-amber-700">
              Plan not yet generated. Run plan generation to populate.
            </p>
          )}
          {hasPlan && (
            <>
              <Stat label="Hypothesis">{plan.hypothesis}</Stat>
              {plan.outreachAngle && (
                <Stat label="Outreach angle">{plan.outreachAngle}</Stat>
              )}
              {plan.segments && plan.segments.length > 0 && (
                <Stat label="Segments">{plan.segments.join(', ')}</Stat>
              )}
            </>
          )}
        </SummaryCard>

        <SummaryCard title="Drafter steering" linkHref={`/market-probes/${probe.id}/settings`} linkLabel="Override">
          <Stat label="Language">
            {probe.outreachLanguage ?? 'auto-detect per contact country'}
          </Stat>
          <Stat label="Formality">
            {probe.formalityLevel ?? 'professional (default)'}
          </Stat>
          {probe.domainHint && (
            <Stat label="Framing">{probe.domainHint}</Stat>
          )}
        </SummaryCard>

        <SummaryCard
          title={`Top targets (${targetCount})`}
          linkHref={`/market-probes/${probe.id}/targets`}
          linkLabel="View all"
        >
          <p className="mb-2 text-[11px] text-[color:var(--color-muted-foreground)]">
            Tier A {fitCounts.A} • Tier B {fitCounts.B} • Tier C{' '}
            {fitCounts.C} • Tier D {fitCounts.D}
          </p>
          {topTargets.length === 0 ? (
            <p className="text-xs text-amber-700">
              No targets yet. Discovery may have returned zero candidates
              — refine country/segments and retry from the Targets tab.
            </p>
          ) : (
            <ul className="grid gap-1 text-xs">
              {topTargets.map((t) => {
                const evidence = (t.evidenceJson ?? {}) as {
                  entityName?: string;
                };
                return (
                  <li
                    key={t.id}
                    className="flex items-baseline justify-between gap-2"
                  >
                    <span className="truncate">
                      {evidence.entityName ?? t.entitySlug}
                    </span>
                    <span className="font-mono text-[10px] text-[color:var(--color-muted-foreground)]">
                      {t.fitTier} ·{' '}
                      {Math.round(
                        Number(t.confidence ?? 0) * 100,
                      )}
                      %
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </SummaryCard>

        <SummaryCard
          title="Hypothesis to test"
          linkHref={`/market-probes/${probe.id}/plan`}
          linkLabel="Manage hypotheses"
        >
          {topHypothesis ? (
            <>
              <Stat label="Statement">{topHypothesis.statement}</Stat>
              {topHypothesis.testMethod && (
                <Stat label="Test method">{topHypothesis.testMethod}</Stat>
              )}
            </>
          ) : (
            <p className="text-xs text-amber-700">
              No hypotheses yet. Add one from the Plan tab.
            </p>
          )}
        </SummaryCard>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <form action={autopilotSendBatchAction}>
          <input type="hidden" name="probeId" value={probe.id} />
          <button
            type="submit"
            disabled={!canStart}
            title={
              canStart
                ? 'Promote probe planning → active and dispatch the first autopilot batch. Apollo enrichment runs for any target missing contacts.'
                : 'Plan and at least one target are required to start.'
            }
            className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-4 py-2 text-sm font-medium text-[color:var(--color-background)] disabled:opacity-40"
          >
            Approve &amp; start probe
          </button>
        </form>
        <span className="text-[11px] text-[color:var(--color-muted-foreground)]">
          First batch caps at {probe.dailySendLimit}/day,{' '}
          {probe.totalSendLimit} total.
        </span>
      </div>
    </section>
  );
}

function ActiveProbeHero({
  probe,
  targetCount,
}: {
  probe: NonNullable<Awaited<ReturnType<typeof getProbe>>>;
  targetCount: number;
}) {
  return (
    <section className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4">
      <div>
        <div className="text-sm font-medium">
          Probe is {probe.status}. {targetCount} target
          {targetCount === 1 ? '' : 's'} loaded.
        </div>
        <div className="text-xs text-[color:var(--color-muted-foreground)]">
          Daily cap {probe.dailySendLimit}, total cap{' '}
          {probe.totalSendLimit}.
        </div>
      </div>
      <form action={autopilotSendBatchAction}>
        <input type="hidden" name="probeId" value={probe.id} />
        <button
          type="submit"
          disabled={probe.status !== 'active' || probe.mode !== 'experiment'}
          title="Dispatch the next autopilot batch within caps. Apollo enrichment runs for any target missing contacts."
          className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-3 py-1.5 text-sm font-medium text-[color:var(--color-background)] disabled:opacity-40"
        >
          Run next batch
        </button>
      </form>
    </section>
  );
}

function FallbackPlanBanner({
  probeId,
  generationStatus,
  generationError,
}: {
  probeId: string;
  generationStatus: string | undefined;
  generationError?: string;
}) {
  return (
    <section className="mb-6 rounded-[var(--radius-lg)] border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
      <div className="mb-2 font-semibold">
        Plan generation fell back to a deterministic skeleton.
      </div>
      <div className="mb-3">
        {generationStatus === 'fallback_no_api_key'
          ? 'ANTHROPIC_API_KEY is not set in this environment — the Sonnet pass was skipped.'
          : 'Sonnet returned malformed JSON and the parser fell through.'}{' '}
        The probe is held at <code>planning</code> until the plan is
        regenerated or you explicitly approve the hollow plan.
      </div>
      {generationError && (
        <div className="mb-3 max-h-24 overflow-auto rounded-[var(--radius-sm)] bg-white/60 px-2 py-1.5 font-mono text-[11px] text-amber-900/80">
          {generationError}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <form action={generatePlanAction}>
          <input type="hidden" name="probeId" value={probeId} />
          <button
            type="submit"
            className="rounded-[var(--radius-md)] bg-amber-900 px-3 py-1.5 text-xs font-medium text-amber-50"
          >
            Retry plan generation
          </button>
        </form>
        <form action={approveFallbackPlanAction}>
          <input type="hidden" name="probeId" value={probeId} />
          <button
            type="submit"
            className="rounded-[var(--radius-md)] border border-amber-700 px-3 py-1.5 text-xs font-medium text-amber-900 hover:bg-amber-100"
          >
            Approve hollow plan anyway
          </button>
        </form>
      </div>
    </section>
  );
}

function SummaryCard({
  title,
  children,
  linkHref,
  linkLabel,
}: {
  title: string;
  children: React.ReactNode;
  linkHref?: string;
  linkLabel?: string;
}) {
  return (
    <div className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-3">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider">
          {title}
        </h3>
        {linkHref && (
          <Link
            href={linkHref}
            className="text-[10px] text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)] hover:underline"
          >
            {linkLabel ?? 'View'} →
          </Link>
        )}
      </div>
      <div className="grid gap-1.5">{children}</div>
    </div>
  );
}

function Stat({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="text-xs">
      <span className="mr-1 text-[10px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
        {label}:
      </span>
      <span>{children}</span>
    </div>
  );
}

function ScoreCell({
  label,
  value,
  sub,
  warn,
}: {
  label: string;
  value: string;
  sub?: string;
  warn?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
        {label}
      </span>
      <span
        className={`text-xl font-semibold ${warn ? 'text-red-700' : ''}`}
      >
        {value}
      </span>
      {sub && (
        <span className="text-[10px] text-[color:var(--color-muted-foreground)]">
          {sub}
        </span>
      )}
    </div>
  );
}
