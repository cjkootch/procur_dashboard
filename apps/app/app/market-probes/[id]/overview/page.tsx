import { notFound } from 'next/navigation';
import { requireCompany } from '@procur/auth';
import { computeProbeScorecard, getProbe } from '@procur/catalog';
import { CopyMarkdownToolbar } from '../../../_components/CopyMarkdownToolbar';
import { formatOverviewMarkdown } from '../../_lib/markdown';
import {
  approveFallbackPlanAction,
  generatePlanAction,
} from '../../actions';

export const dynamic = 'force-dynamic';

// STATUS_TONE moved to layout.tsx; FIT_TONE moved to /targets;
// TASK_STATUS_TONE moved to /plan.

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function ProbeOverviewPage({ params }: PageProps) {
  await requireCompany();
  const { id } = await params;
  const probe = await getProbe(id);
  if (!probe) notFound();
  const scorecard = await computeProbeScorecard(id);

  const plan = probe.planJson ?? {};
  const markdown = formatOverviewMarkdown(probe, {
    scorecard,
    planGenerationStatus: plan.generationStatus,
    planGenerationError: plan.generationError,
  });

  return (
    <>
      <CopyMarkdownToolbar
        markdown={markdown}
        slug={`probe-${probe.id}-overview`}
      />
      {/* Scorecard — composite metrics. Computed on every page load
          (cheap; reads + a refreshSegmentCounts pass). */}
      {plan.generationStatus && plan.generationStatus !== 'ok' && (
        <section className="mb-6 rounded-[var(--radius-lg)] border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <div className="mb-2 font-semibold">
            Plan generation fell back to a deterministic skeleton.
          </div>
          <div className="mb-3">
            {plan.generationStatus === 'fallback_no_api_key'
              ? 'ANTHROPIC_API_KEY is not set in this environment — the Sonnet pass was skipped.'
              : 'Sonnet returned malformed JSON and the parser fell through.'}{' '}
            The probe is held at <code>planning</code> and autopilot is
            blocked until the plan is regenerated or you explicitly
            approve the hollow plan.
          </div>
          {plan.generationError && (
            <div className="mb-3 max-h-24 overflow-auto rounded-[var(--radius-sm)] bg-white/60 px-2 py-1.5 font-mono text-[11px] text-amber-900/80">
              {plan.generationError}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <form action={generatePlanAction}>
              <input type="hidden" name="probeId" value={probe.id} />
              <button
                type="submit"
                className="rounded-[var(--radius-md)] bg-amber-900 px-3 py-1.5 text-xs font-medium text-amber-50"
              >
                Retry plan generation
              </button>
            </form>
            <form action={approveFallbackPlanAction}>
              <input type="hidden" name="probeId" value={probe.id} />
              <button
                type="submit"
                className="rounded-[var(--radius-md)] border border-amber-700 px-3 py-1.5 text-xs font-medium text-amber-900 hover:bg-amber-100"
              >
                Approve hollow plan anyway
              </button>
            </form>
          </div>
        </section>
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
