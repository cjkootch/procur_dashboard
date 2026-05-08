import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireCompany } from '@procur/auth';
import {
  computeProbeScorecard,
  computeVariantPerformance,
  countTargetsByJustification,
  getLatestLearningReport,
  getProbe,
  listAtlasFactsForProbe,
  listHypothesesForProbe,
  listSegments,
  listStrategyProposals,
  listTargetsForProbe,
  listVariants,
  ATLAS_FACT_TYPES,
  HYPOTHESIS_TYPES,
  HYPOTHESIS_STATUSES,
  LADDER_STAGES,
  PROBE_FEEDBACK_LABELS,
  PROBE_SIGNAL_KINDS,
  type LearningReportPayload,
} from '@procur/catalog';
import { SignalFlagsForm } from '../_components/SignalFlagsForm';
import {
  addApolloLookalikesAction,
  addAtlasFactAction,
  addHypothesisAction,
  addThesisOrgsAction,
  advanceLadderAction,
  approveFallbackPlanAction,
  approveStrategyProposalAction,
  discoverTargetsAction,
  findDecisionMakersAction,
  autopilotSendBatchAction,
  createVariantAction,
  generateLearningReportAction,
  generatePlanAction,
  generateVariantProposalsAction,
  generateStrategyProposalsAction,
  setProbeDrafterSteeringAction,
  setProbeIdentityAction,
  setProbeKillCriteriaAction,
  setProbeModeAction,
  setProbeTierAction,
  setVariantStatusAction,
  markTargetResearchOnlyAction,
  recordTargetFeedbackAction,
  rejectStrategyProposalAction,
  resolveHypothesisAction,
  savePlaybookFromProbeAction,
  setProbeStatusAction,
  setTargetJustificationAction,
  setTaskSkippedAction,
  upsertSegmentAction,
} from '../actions';

export const dynamic = 'force-dynamic';

const STATUS_TONE: Record<string, string> = {
  planning: 'bg-[color:var(--color-muted)]/60',
  active: 'bg-green-100 text-green-900',
  paused: 'bg-yellow-100 text-yellow-900',
  completed: 'bg-blue-100 text-blue-900',
  abandoned: 'bg-red-100 text-red-900',
};

const FIT_TONE: Record<string, string> = {
  A: 'bg-green-100 text-green-900',
  B: 'bg-blue-100 text-blue-900',
  C: 'bg-[color:var(--color-muted)]/60',
  D: 'bg-red-100 text-red-900',
};

const TASK_STATUS_TONE: Record<string, string> = {
  pending: 'text-[color:var(--color-muted-foreground)]',
  in_progress: 'text-[color:var(--color-foreground)]',
  done: 'line-through text-[color:var(--color-muted-foreground)]',
  skipped: 'line-through text-[color:var(--color-muted-foreground)] italic',
};

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function MarketProbeDetailPage({ params }: PageProps) {
  await requireCompany();
  const { id } = await params;
  const probe = await getProbe(id);
  if (!probe) notFound();
  const [
    targets,
    atlasFacts,
    pendingProposals,
    reviewedProposals,
    hypotheses,
    justificationCounts,
    segments,
    scorecard,
    variants,
    variantPerformance,
  ] = await Promise.all([
    listTargetsForProbe(id),
    listAtlasFactsForProbe(id),
    listStrategyProposals(id, { status: 'proposed' }),
    Promise.all([
      listStrategyProposals(id, { status: 'approved' }),
      listStrategyProposals(id, { status: 'rejected' }),
    ]).then(([a, r]) => [...a, ...r].sort((x, y) =>
      (y.reviewedAt?.getTime() ?? 0) - (x.reviewedAt?.getTime() ?? 0),
    )),
    listHypothesesForProbe(id),
    countTargetsByJustification(id),
    listSegments(id),
    computeProbeScorecard(id),
    listVariants(id),
    computeVariantPerformance(id),
  ]);
  const latestReport = await getLatestLearningReport(id);

  const ladderIdx = LADDER_STAGES.indexOf(
    probe.ladderStage as (typeof LADDER_STAGES)[number],
  );
  const ladderNext = ladderIdx >= 0 ? LADDER_STAGES[ladderIdx + 1] : undefined;

  const plan = probe.planJson ?? {};
  const tasks = plan.tasks ?? [];
  const hasPlan = Boolean(plan.hypothesis);

  return (
    <div className="mx-auto max-w-5xl px-8 py-10">
      <Link
        href="/market-probes"
        className="text-sm text-[color:var(--color-muted-foreground)] hover:underline"
      >
        ← Market Probes
      </Link>
      <header className="mt-4 mb-6">
        <div className="flex flex-wrap items-baseline gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">
            {probe.marketName}
          </h1>
          {probe.country && (
            <span className="rounded-full bg-[color:var(--color-muted)]/60 px-2 py-0.5 text-xs font-mono">
              {probe.country.toUpperCase()}
            </span>
          )}
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_TONE[probe.status] ?? ''}`}
          >
            {probe.status}
          </span>
          <span className="rounded-full border border-[color:var(--color-border)] px-2 py-0.5 text-xs">
            Tier {probe.tier}
          </span>
          <span
            className="rounded-full border border-[color:var(--color-border)] px-2 py-0.5 text-xs font-mono"
            title="Probe ladder stage. Sequential: market_structure → routing → pain_discovery → commercial_qualification → deal_room_conversion. Hard discipline: agent cannot skip ahead."
          >
            stage: {probe.ladderStage}
          </span>
          {ladderNext && (
            <>
              <form action={advanceLadderAction}>
                <input type="hidden" name="probeId" value={probe.id} />
                <button
                  type="submit"
                  className="rounded-full border border-[color:var(--color-border)] px-2 py-0.5 text-xs hover:bg-[color:var(--color-muted)]/40"
                  title={`Advance to ${ladderNext}. Gated on evidence from current stage.`}
                >
                  advance →
                </button>
              </form>
              {/* Operator force-advance escape hatch — bypasses the
                  evidence gate. Use sparingly: skipping ahead defeats
                  the point of ladder discipline. */}
              <form action={advanceLadderAction}>
                <input type="hidden" name="probeId" value={probe.id} />
                <input type="hidden" name="force" value="true" />
                <button
                  type="submit"
                  className="text-[10px] text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)] hover:underline"
                  title={`Force-advance to ${ladderNext} regardless of evidence. Operator-only override.`}
                >
                  force
                </button>
              </form>
            </>
          )}
          <span className="text-xs text-[color:var(--color-muted-foreground)]">
            cap {probe.dailySendLimit}/day, {probe.totalSendLimit} total
          </span>
        </div>
        <p className="mt-2 max-w-3xl text-sm">{probe.productThesis}</p>
        {probe.objective && (
          <p className="mt-2 max-w-3xl text-xs text-[color:var(--color-muted-foreground)]">
            Objective: {probe.objective}
          </p>
        )}
      </header>

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

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Plan + checklist */}
        <section className="lg:col-span-2 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-5">
          <div className="mb-4 flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
              Plan
            </h2>
            {!hasPlan && (
              <form action={generatePlanAction}>
                <input type="hidden" name="probeId" value={probe.id} />
                <button
                  type="submit"
                  className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-3 py-1.5 text-xs font-medium text-[color:var(--color-background)]"
                >
                  Generate plan
                </button>
              </form>
            )}
            {hasPlan && (
              <form action={generatePlanAction}>
                <input type="hidden" name="probeId" value={probe.id} />
                <button
                  type="submit"
                  className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-3 py-1.5 text-xs font-medium hover:bg-[color:var(--color-muted)]/40"
                >
                  Regenerate
                </button>
              </form>
            )}
          </div>

          {!hasPlan ? (
            <p className="text-sm text-[color:var(--color-muted-foreground)]">
              No plan yet. Click <strong>Generate plan</strong> — Sonnet
              produces a hypothesis, segments, outreach angle, and a
              checklist of tasks the agent will work through.
            </p>
          ) : (
            <div className="space-y-4 text-sm">
              {plan.hypothesis && (
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
                    Hypothesis
                  </div>
                  <p className="mt-1">{plan.hypothesis}</p>
                </div>
              )}
              {plan.segments && plan.segments.length > 0 && (
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
                    Segments
                  </div>
                  <ul className="mt-1 flex flex-wrap gap-1.5">
                    {plan.segments.map((s, i) => (
                      <li
                        key={i}
                        className="rounded-full bg-[color:var(--color-muted)]/60 px-2 py-0.5 text-xs"
                      >
                        {s}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {plan.outreachAngle && (
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
                    Outreach angle
                  </div>
                  <p className="mt-1">{plan.outreachAngle}</p>
                </div>
              )}
              {plan.successCriteria && plan.successCriteria.length > 0 && (
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
                    Success criteria
                  </div>
                  <ul className="mt-1 list-disc pl-5 space-y-0.5">
                    {plan.successCriteria.map((c, i) => (
                      <li key={i}>{c}</li>
                    ))}
                  </ul>
                </div>
              )}

              {tasks.length > 0 && (
                <div>
                  <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
                    Tasks ({tasks.filter((t) => t.status === 'done').length} of{' '}
                    {tasks.length} complete)
                  </div>
                  <ul className="space-y-1.5">
                    {tasks.map((t) => (
                      <li
                        key={t.id}
                        className="flex items-start gap-2 rounded-[var(--radius-sm)] p-1.5"
                      >
                        <span className="mt-0.5">
                          {t.status === 'done' ? '☑' : t.status === 'skipped' ? '⊘' : '☐'}
                        </span>
                        <div className="flex-1 min-w-0">
                          <span className={TASK_STATUS_TONE[t.status] ?? ''}>
                            {t.label}
                          </span>
                          {t.result && (
                            <p className="text-[11px] text-[color:var(--color-muted-foreground)]">
                              {t.result}
                            </p>
                          )}
                        </div>
                        {t.status === 'pending' && (
                          <form action={setTaskSkippedAction}>
                            <input type="hidden" name="probeId" value={probe.id} />
                            <input type="hidden" name="taskId" value={t.id} />
                            <button
                              type="submit"
                              className="text-[11px] text-[color:var(--color-muted-foreground)] hover:underline"
                              title="Skip this task"
                            >
                              skip
                            </button>
                          </form>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </section>

        {/* Controls */}
        <aside className="rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-5">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Controls
          </h2>
          <div className="space-y-3">
            <form action={discoverTargetsAction}>
              <input type="hidden" name="probeId" value={probe.id} />
              <button
                type="submit"
                disabled={!probe.country}
                className="w-full rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-3 py-2 text-sm font-medium text-[color:var(--color-background)] disabled:opacity-40"
              >
                Discover targets
              </button>
              <p className="mt-1 text-[11px] text-[color:var(--color-muted-foreground)]">
                {probe.country
                  ? 'Graph similarity + customs + web + Apollo presence + recency. Country-fenced.'
                  : 'Set country (ISO-2) to enable discovery.'}
              </p>
            </form>

            <form
              action={addApolloLookalikesAction}
              className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] p-2"
            >
              <input type="hidden" name="probeId" value={probe.id} />
              <label className="block text-[11px] font-medium uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
                Apollo lookalikes
              </label>
              <input
                type="text"
                name="seedSlug"
                placeholder="seed entity slug (e.g. caribbean-importers:wibisco)"
                required
                className="mt-1 w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-xs focus:border-[color:var(--color-foreground)] focus:outline-none"
              />
              <button
                type="submit"
                className="mt-2 w-full rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-3 py-1.5 text-xs font-medium hover:bg-[color:var(--color-muted)]/40"
              >
                Find lookalikes
              </button>
              <p className="mt-1 text-[10px] text-[color:var(--color-muted-foreground)]">
                Seed must be in the rolodex (Apollo enrichment auto-runs
                if missing). Pulls 25 attribute-similar orgs (industry /
                size / country), creates rolodex stubs for those not yet
                on file.
              </p>
            </form>

            <form
              action={addThesisOrgsAction}
              className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] p-2"
            >
              <input type="hidden" name="probeId" value={probe.id} />
              <label className="block text-[11px] font-medium uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
                Apollo thesis search
              </label>
              <input
                type="text"
                name="keywords"
                placeholder="keywords (comma-separated)"
                required
                className="mt-1 w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-xs focus:border-[color:var(--color-foreground)] focus:outline-none"
              />
              <button
                type="submit"
                disabled={!probe.country}
                className="mt-2 w-full rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-3 py-1.5 text-xs font-medium hover:bg-[color:var(--color-muted)]/40 disabled:opacity-40"
              >
                Search by thesis
              </button>
              <p className="mt-1 text-[10px] text-[color:var(--color-muted-foreground)]">
                Seed-free. Country-fenced. Useful before you have a
                seed entity. Results land at fit-tier C (weaker than
                lookalikes — keyword guess vs measured similarity).
              </p>
            </form>

            {probe.status === 'active' && (
              <form action={setProbeStatusAction}>
                <input type="hidden" name="probeId" value={probe.id} />
                <input type="hidden" name="status" value="paused" />
                <button
                  type="submit"
                  className="w-full rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-3 py-2 text-sm hover:bg-[color:var(--color-muted)]/40"
                >
                  Pause probe
                </button>
              </form>
            )}
            {probe.status === 'paused' && (
              <form action={setProbeStatusAction}>
                <input type="hidden" name="probeId" value={probe.id} />
                <input type="hidden" name="status" value="active" />
                <button
                  type="submit"
                  className="w-full rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-3 py-2 text-sm hover:bg-[color:var(--color-muted)]/40"
                >
                  Resume probe
                </button>
              </form>
            )}
            {(probe.status === 'active' || probe.status === 'paused') && (
              <form action={setProbeStatusAction}>
                <input type="hidden" name="probeId" value={probe.id} />
                <input type="hidden" name="status" value="completed" />
                <button
                  type="submit"
                  className="w-full rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-3 py-2 text-sm hover:bg-[color:var(--color-muted)]/40"
                >
                  Mark completed
                </button>
              </form>
            )}
          </div>

          <div className="mt-5 space-y-3 text-xs text-[color:var(--color-muted-foreground)]">
            <div>
              <span className="text-[10px] font-semibold uppercase tracking-wider">
                Mode
              </span>
              <form action={setProbeModeAction} className="mt-1 flex gap-1">
                <input type="hidden" name="probeId" value={probe.id} />
                <select
                  name="mode"
                  defaultValue={probe.mode}
                  className="flex-1 rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-xs"
                >
                  <option value="experiment">experiment (autopilot eligible)</option>
                  <option value="relationship">relationship (manual only)</option>
                </select>
                <button
                  type="submit"
                  className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 text-xs hover:bg-[color:var(--color-muted)]/40"
                >
                  Set
                </button>
              </form>
            </div>

            <details>
              <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wider hover:text-[color:var(--color-foreground)]">
                Kill criteria
              </summary>
              <form
                action={setProbeKillCriteriaAction}
                className="mt-2 grid gap-1.5"
              >
                <input type="hidden" name="probeId" value={probe.id} />
                <label className="flex items-center justify-between gap-2">
                  <span>max bounce rate %</span>
                  <input
                    type="number"
                    step="0.1"
                    name="maxBounceRatePct"
                    defaultValue={Number(probe.maxBounceRatePct)}
                    className="w-16 rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-1 py-0.5 text-xs"
                  />
                </label>
                <label className="flex items-center justify-between gap-2">
                  <span>max complaint rate %</span>
                  <input
                    type="number"
                    step="0.1"
                    name="maxComplaintRatePct"
                    defaultValue={Number(probe.maxComplaintRatePct)}
                    className="w-16 rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-1 py-0.5 text-xs"
                  />
                </label>
                <label className="flex items-center justify-between gap-2">
                  <span>no-reply / segment pause</span>
                  <input
                    type="number"
                    name="maxNoReplyBeforeSegmentPause"
                    defaultValue={probe.maxNoReplyBeforeSegmentPause}
                    className="w-16 rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-1 py-0.5 text-xs"
                  />
                </label>
                <label className="flex items-center justify-between gap-2">
                  <span>no-signal / probe pause</span>
                  <input
                    type="number"
                    name="maxTotalNoSignalBeforeProbePause"
                    defaultValue={probe.maxTotalNoSignalBeforeProbePause}
                    className="w-16 rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-1 py-0.5 text-xs"
                  />
                </label>
                <button
                  type="submit"
                  className="self-end rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-0.5 text-xs hover:bg-[color:var(--color-muted)]/40"
                >
                  Save
                </button>
              </form>
            </details>

            <details>
              <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wider hover:text-[color:var(--color-foreground)]">
                Outreach identity
              </summary>
              <form
                action={setProbeIdentityAction}
                className="mt-2 grid gap-1.5"
              >
                <input type="hidden" name="probeId" value={probe.id} />
                <p className="text-[10px] text-[color:var(--color-muted-foreground)]">
                  Per-probe alias + signature override the company defaults
                  at /settings/email for autopilot dispatch and
                  submit_lead_form. Leave blank to fall back.
                </p>
                <label className="grid gap-1">
                  <span>Alias (sender display name)</span>
                  <input
                    type="text"
                    name="alias"
                    defaultValue={probe.alias ?? ''}
                    placeholder="e.g. Ana Martinez or Procurement Desk"
                    maxLength={120}
                    className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-1 py-0.5 text-xs"
                  />
                </label>
                <label className="grid gap-1">
                  <span>Email signature (text)</span>
                  <textarea
                    name="emailSignatureText"
                    defaultValue={probe.emailSignatureText ?? ''}
                    rows={4}
                    maxLength={2000}
                    placeholder={'Ana Martinez\nProcur • +1 555 0100'}
                    className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-1 py-1 text-xs font-mono"
                  />
                </label>
                <label className="grid gap-1">
                  <span>Email signature (HTML, optional)</span>
                  <textarea
                    name="emailSignatureHtml"
                    defaultValue={probe.emailSignatureHtml ?? ''}
                    rows={3}
                    maxLength={4000}
                    placeholder="<div>Ana Martinez<br>Procur</div>"
                    className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-1 py-1 text-xs font-mono"
                  />
                </label>
                <button
                  type="submit"
                  className="self-end rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-0.5 text-xs hover:bg-[color:var(--color-muted)]/40"
                >
                  Save
                </button>
              </form>
            </details>

            <details>
              <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wider hover:text-[color:var(--color-foreground)]">
                Drafter steering
              </summary>
              <form
                action={setProbeDrafterSteeringAction}
                className="mt-2 grid gap-1.5"
              >
                <input type="hidden" name="probeId" value={probe.id} />
                <p className="text-[10px] text-[color:var(--color-muted-foreground)]">
                  Per-probe formality + domain framing. Threaded into both
                  email and lead-form drafter prompts. Use when the probe
                  is operating outside the default professional-procurement
                  shape (cross-border M&A, succession outreach, warm-market
                  follow-ups).
                </p>
                <label className="grid gap-1">
                  <span>Formality</span>
                  <select
                    name="formalityLevel"
                    defaultValue={probe.formalityLevel ?? ''}
                    className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-1 py-0.5 text-xs"
                  >
                    <option value="">(default — professional)</option>
                    <option value="high">
                      High — deferential, indirect, honorifics
                    </option>
                    <option value="professional">
                      Professional — direct but courteous
                    </option>
                    <option value="casual">
                      Casual — warm-market, conversational
                    </option>
                  </select>
                </label>
                <label className="grid gap-1">
                  <span>Domain hint (optional, max 1000 chars)</span>
                  <textarea
                    name="domainHint"
                    defaultValue={probe.domainHint ?? ''}
                    rows={5}
                    maxLength={1000}
                    placeholder={
                      "e.g. \"Exploratory M&A conversation with a succession-stage business owner. Lead with respect for what they've built; do NOT lead with valuation; goal of first contact is to learn whether succession is on their mind, not to make an offer.\""
                    }
                    className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-1 py-1 text-xs"
                  />
                </label>
                <button
                  type="submit"
                  className="self-end rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-0.5 text-xs hover:bg-[color:var(--color-muted)]/40"
                >
                  Save
                </button>
              </form>
            </details>

            <div className="border-t border-[color:var(--color-border)] pt-3">
              <span className="text-[10px] font-semibold uppercase tracking-wider">
                Autopilot (Tier 1)
              </span>
              <p className="mt-1 text-[10px]">
                Tier {probe.tier} —{' '}
                {probe.tier === 0
                  ? 'research-only; every send is operator-approved.'
                  : `autopilot drafts + sends within caps. Mode: ${probe.mode}.`}
              </p>
              <div className="mt-2 flex flex-col gap-1.5">
                {probe.tier === 0 && probe.mode === 'experiment' && (
                  <form action={setProbeTierAction}>
                    <input type="hidden" name="probeId" value={probe.id} />
                    <input type="hidden" name="tier" value="1" />
                    <button
                      type="submit"
                      className="w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1 text-xs hover:bg-[color:var(--color-muted)]/40"
                      title="Graduate to Tier 1 — autopilot drafts + sends to A/B-tier justified targets within daily caps."
                    >
                      Graduate to Tier 1
                    </button>
                  </form>
                )}
                {probe.tier >= 1 && (
                  <>
                    <form action={autopilotSendBatchAction}>
                      <input type="hidden" name="probeId" value={probe.id} />
                      <button
                        type="submit"
                        disabled={probe.mode !== 'experiment' || probe.status !== 'active'}
                        className="w-full rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-3 py-1.5 text-xs font-medium text-[color:var(--color-background)] disabled:opacity-40"
                        title="Drafts + dispatches the next eligible batch (justified A/B targets, scout-protection cleared, kill criteria not breached, within daily cap)."
                      >
                        Run autopilot batch
                      </button>
                    </form>
                    <form action={setProbeTierAction}>
                      <input type="hidden" name="probeId" value={probe.id} />
                      <input type="hidden" name="tier" value="0" />
                      <button
                        type="submit"
                        className="w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1 text-[10px] text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"
                      >
                        Demote to Tier 0
                      </button>
                    </form>
                  </>
                )}
              </div>
            </div>
            <p className="pt-1">
              Phase 1 = manual approval; Tier 1 graduates to autopilot
              (Phase 2H).
            </p>
            {probe.allowedChannels.length > 0 && (
              <p>Channels: {probe.allowedChannels.join(', ')}</p>
            )}
            {probe.blockedTerms.length > 0 && (
              <p>Blocked terms: {probe.blockedTerms.join(', ')}</p>
            )}
          </div>
        </aside>
      </div>

      {/* Targets */}
      <section className="mt-6 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-5">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
          Targets ({targets.length})
        </h2>
        <p className="mb-3 text-xs text-[color:var(--color-muted-foreground)]">
          {justificationCounts.justified} justified ·{' '}
          {justificationCounts.pending} pending ·{' '}
          {justificationCounts.research_only} research-only.{' '}
          <span className="italic">
            Tier 1 autopilot only sends to justified targets (Phase 2H).
          </span>
        </p>
        {targets.length === 0 ? (
          <p className="text-sm text-[color:var(--color-muted-foreground)]">
            No targets yet. Run <strong>Discover targets</strong> to
            populate via the intelligence-graph ranker (graph similarity +
            customs + web intelligence + Apollo + recency).
          </p>
        ) : (
          <ul className="divide-y divide-[color:var(--color-border)]">
            {targets.map((t) => {
              const evidence = (t.evidenceJson ?? {}) as Record<string, unknown>;
              const entityName =
                typeof evidence['entityName'] === 'string'
                  ? (evidence['entityName'] as string)
                  : t.entitySlug;
              const score =
                typeof evidence['score'] === 'number'
                  ? (evidence['score'] as number).toFixed(0)
                  : null;
              const channel =
                typeof evidence['recommendedChannel'] === 'string'
                  ? (evidence['recommendedChannel'] as string)
                  : null;
              const evidenceItems = Array.isArray(evidence['evidenceItems'])
                ? (evidence['evidenceItems'] as unknown[]).slice(0, 3)
                : [];
              return (
                <li key={t.id} className="py-3">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <Link
                      href={`/entities/${encodeURIComponent(t.entitySlug)}`}
                      className="text-sm font-medium hover:underline"
                    >
                      {entityName}
                    </Link>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${FIT_TONE[t.fitTier] ?? ''}`}
                    >
                      tier {t.fitTier}
                    </span>
                    {score && (
                      <span className="text-xs font-mono text-[color:var(--color-muted-foreground)]">
                        score {score}
                      </span>
                    )}
                    {channel && (
                      <span className="rounded-full bg-[color:var(--color-muted)]/60 px-2 py-0.5 text-xs">
                        {channel}
                      </span>
                    )}
                    <span className="ml-auto text-xs text-[color:var(--color-muted-foreground)]">
                      {t.sendStatus}
                    </span>
                  </div>
                  {evidenceItems.length > 0 && (
                    <ul className="mt-1 list-disc pl-5 text-xs text-[color:var(--color-muted-foreground)]">
                      {evidenceItems.map((e, i) => (
                        <li key={i}>
                          {typeof e === 'string'
                            ? e
                            : typeof e === 'object' && e !== null && 'label' in e
                              ? String((e as { label: unknown }).label)
                              : JSON.stringify(e)}
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="mt-1.5 flex items-center gap-2 text-[11px]">
                    <form action={findDecisionMakersAction}>
                      <input type="hidden" name="probeId" value={probe.id} />
                      <input type="hidden" name="targetId" value={t.id} />
                      <button
                        type="submit"
                        className="text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)] hover:underline"
                        title="Run Apollo searchPeople for decision-makers at this org. Results land in the entity profile's Decision-makers panel."
                      >
                        Find decision-makers
                      </button>
                    </form>
                    <span className="text-[color:var(--color-muted-foreground)]">
                      ·
                    </span>
                    <form action={markTargetResearchOnlyAction}>
                      <input type="hidden" name="probeId" value={probe.id} />
                      <input type="hidden" name="targetId" value={t.id} />
                      <button
                        type="submit"
                        className="text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)] hover:underline"
                        title="Demote to research_only — never auto-drafted."
                      >
                        research only
                      </button>
                    </form>
                    <span
                      className={`ml-auto rounded-full px-2 py-0.5 font-medium ${
                        t.justificationState === 'justified'
                          ? 'bg-green-100 text-green-900'
                          : t.justificationState === 'research_only'
                            ? 'bg-[color:var(--color-muted)]/60'
                            : 'bg-yellow-100 text-yellow-900'
                      }`}
                      title={
                        t.justificationState === 'justified'
                          ? 'Eligible for autopilot draft (Phase 2H).'
                          : t.justificationState === 'research_only'
                            ? 'Held back from outreach.'
                            : 'Justification pending — fill in the why fields below to promote to justified.'
                      }
                    >
                      {t.justificationState}
                    </span>
                  </div>
                  {/* Justification panel — collapsed by default; the
                      operator opens to fill in the why-fields. Promotes
                      to justification_state='justified' when all four
                      narrative fields are populated. */}
                  <details className="mt-2">
                    <summary className="cursor-pointer text-[11px] text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]">
                      Justification {t.justificationState === 'justified' ? '✓' : ''}
                    </summary>
                    <form
                      action={setTargetJustificationAction}
                      className="mt-2 grid gap-2 rounded-[var(--radius-sm)] border border-dashed border-[color:var(--color-border)] p-2 text-xs"
                    >
                      <input
                        type="hidden"
                        name="probeId"
                        value={probe.id}
                      />
                      <input
                        type="hidden"
                        name="targetId"
                        value={t.id}
                      />
                      <label className="flex flex-col gap-0.5">
                        <span className="text-[10px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
                          Why this company?
                        </span>
                        <input
                          type="text"
                          name="whyThisCompany"
                          defaultValue={t.whyThisCompany ?? ''}
                          placeholder="What evidence makes this a real candidate?"
                          className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1"
                        />
                      </label>
                      <label className="flex flex-col gap-0.5">
                        <span className="text-[10px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
                          Why this person?
                        </span>
                        <input
                          type="text"
                          name="whyThisPerson"
                          defaultValue={t.whyThisPerson ?? ''}
                          placeholder="Title / role / responsibility — why are we writing to THIS contact?"
                          className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1"
                        />
                      </label>
                      <label className="flex flex-col gap-0.5">
                        <span className="text-[10px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
                          Why now?
                        </span>
                        <input
                          type="text"
                          name="whyNow"
                          defaultValue={t.whyNow ?? ''}
                          placeholder="Trigger — recent imports, new tender, hiring, news event..."
                          className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1"
                        />
                      </label>
                      <label className="flex flex-col gap-0.5">
                        <span className="text-[10px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
                          Safest first ask
                        </span>
                        <input
                          type="text"
                          name="safestFirstAsk"
                          defaultValue={t.safestFirstAsk ?? ''}
                          placeholder="Most-deferential single question. NEVER pricing/quantity/terms."
                          className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1"
                        />
                      </label>
                      <button
                        type="submit"
                        className="self-start rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-3 py-1 font-medium hover:bg-[color:var(--color-muted)]/40"
                      >
                        Save justification
                      </button>
                    </form>
                  </details>

                  {/* Signal flags — checkbox grid. Operator marks
                      observed signals; scorecard correlates against
                      reply outcomes. */}
                  <details className="mt-1">
                    <summary className="cursor-pointer text-[11px] text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]">
                      Signals (
                      {Object.values(t.signalsPresent ?? {}).filter(Boolean)
                        .length}{' '}
                      / {PROBE_SIGNAL_KINDS.length})
                    </summary>
                    <SignalFlagsForm
                      probeId={probe.id}
                      targetId={t.id}
                      current={(t.signalsPresent ?? {}) as Record<string, boolean>}
                    />
                  </details>

                  {/* Feedback shortcuts — one-click labels, sentiment
                      derived in the helper. Writes feedback_events rows. */}
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {PROBE_FEEDBACK_LABELS.map((label) => (
                      <form
                        key={label}
                        action={recordTargetFeedbackAction}
                        className="inline"
                      >
                        <input type="hidden" name="probeId" value={probe.id} />
                        <input type="hidden" name="targetId" value={t.id} />
                        <input type="hidden" name="label" value={label} />
                        <button
                          type="submit"
                          className="rounded-full border border-[color:var(--color-border)] px-2 py-0.5 text-[10px] hover:bg-[color:var(--color-muted)]/40"
                          title={`Record feedback: ${label.replace(/_/g, ' ')}`}
                        >
                          {label.replace(/_/g, ' ')}
                        </button>
                      </form>
                    ))}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Hypotheses — explicit pre-hoc commitments. Agent emits 3-7 at
          plan-gen time; operator edits/adds/resolves. Each is a
          falsifiable statement with confidence + test method + status. */}
      <section className="mt-6 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-5">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Hypotheses ({hypotheses.length})
          </h2>
          <span className="text-xs text-[color:var(--color-muted-foreground)]">
            {hypotheses.filter((h) => h.status === 'active').length} active ·{' '}
            {hypotheses.filter((h) => h.status === 'confirmed').length} confirmed ·{' '}
            {hypotheses.filter((h) => h.status === 'falsified').length} falsified
          </span>
        </div>

        {hypotheses.length === 0 ? (
          <p className="text-sm text-[color:var(--color-muted-foreground)]">
            No hypotheses yet. The plan-gen agent emits 3-7 at probe
            creation; click <strong>Generate plan</strong> (above) to
            populate, or add one manually below.
          </p>
        ) : (
          <ul className="space-y-2">
            {hypotheses.map((h) => {
              const start = Math.round(Number(h.confidenceStart) * 100);
              const current = Math.round(Number(h.confidenceCurrent) * 100);
              const delta = current - start;
              return (
                <li
                  key={h.id}
                  className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] p-3"
                >
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="rounded-full bg-[color:var(--color-muted)]/60 px-2 py-0.5 text-[10px] font-mono">
                      {h.hypothesisType}
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                        h.status === 'confirmed'
                          ? 'bg-green-100 text-green-900'
                          : h.status === 'falsified'
                            ? 'bg-red-100 text-red-900'
                            : h.status === 'unclear' || h.status === 'abandoned'
                              ? 'bg-yellow-100 text-yellow-900'
                              : 'bg-[color:var(--color-muted)]/60'
                      }`}
                    >
                      {h.status}
                    </span>
                    <span className="text-[10px] text-[color:var(--color-muted-foreground)]">
                      confidence {start}% → {current}%
                      {delta !== 0 && (
                        <span
                          className={`ml-1 ${delta > 0 ? 'text-green-700' : 'text-red-700'}`}
                        >
                          ({delta > 0 ? '+' : ''}
                          {delta})
                        </span>
                      )}
                    </span>
                  </div>
                  <p className="mt-1.5 text-sm">{h.statement}</p>
                  {h.testMethod && (
                    <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">
                      <strong>Test:</strong> {h.testMethod}
                    </p>
                  )}
                  {h.result && (
                    <p className="mt-1 text-xs">
                      <strong>Result:</strong> {h.result}
                    </p>
                  )}
                  {h.status === 'active' && (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-[11px] text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]">
                        Resolve
                      </summary>
                      <form
                        action={resolveHypothesisAction}
                        className="mt-2 flex flex-wrap items-center gap-2"
                      >
                        <input type="hidden" name="probeId" value={probe.id} />
                        <input
                          type="hidden"
                          name="hypothesisId"
                          value={h.id}
                        />
                        <select
                          name="status"
                          defaultValue="confirmed"
                          className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-xs"
                        >
                          {HYPOTHESIS_STATUSES.filter(
                            (s) => s !== 'active',
                          ).map((s) => (
                            <option key={s} value={s}>
                              {s}
                            </option>
                          ))}
                        </select>
                        <input
                          type="text"
                          name="result"
                          placeholder="result note"
                          className="flex-1 rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-xs"
                        />
                        <button
                          type="submit"
                          className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-3 py-1 text-xs hover:bg-[color:var(--color-muted)]/40"
                        >
                          Save
                        </button>
                      </form>
                    </details>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {/* Manual add-hypothesis form */}
        <form
          action={addHypothesisAction}
          className="mt-4 grid gap-2 rounded-[var(--radius-md)] border border-dashed border-[color:var(--color-border)] p-3 text-xs md:grid-cols-[160px,1fr,auto]"
        >
          <input type="hidden" name="probeId" value={probe.id} />
          <select
            name="hypothesisType"
            required
            className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1"
          >
            {HYPOTHESIS_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <input
            type="text"
            name="statement"
            placeholder='falsifiable statement — e.g. "Hotels reply more than fuel distributors at >20%"'
            required
            className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1"
          />
          <button
            type="submit"
            className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-3 py-1 font-medium hover:bg-[color:var(--color-muted)]/40"
          >
            Add hypothesis
          </button>
        </form>
      </section>

      {/* Strategy proposals — agent-proposed plan changes for review. */}
      <section className="mt-6 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Strategy proposals
            {pendingProposals.length > 0 && (
              <span className="ml-2 rounded-full bg-yellow-100 px-2 py-0.5 text-xs font-medium text-yellow-900">
                {pendingProposals.length} pending
              </span>
            )}
          </h2>
          <form action={generateStrategyProposalsAction}>
            <input type="hidden" name="probeId" value={probe.id} />
            <button
              type="submit"
              className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-3 py-1.5 text-xs font-medium hover:bg-[color:var(--color-muted)]/40"
              title="Sonnet reviews probe metrics + rejection history; emits 0-3 proposals."
            >
              Ask agent for proposals
            </button>
          </form>
        </div>

        {pendingProposals.length === 0 ? (
          <p className="text-sm text-[color:var(--color-muted-foreground)]">
            No pending proposals. Click <strong>Ask agent for proposals</strong>{' '}
            after the probe has activity (sends + replies); the agent reviews
            metrics + rejection history and emits 0-3 changes for you to approve.
          </p>
        ) : (
          <ul className="space-y-3">
            {pendingProposals.map((p) => {
              const before = (p.payloadJson?.before ?? {}) as Record<string, unknown>;
              const after = (p.payloadJson?.after ?? {}) as Record<string, unknown>;
              const summary = p.payloadJson?.summary;
              return (
                <li
                  key={p.id}
                  className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] p-3"
                >
                  <div className="flex items-baseline gap-2">
                    <span className="rounded-full bg-[color:var(--color-muted)]/60 px-2 py-0.5 text-xs font-mono">
                      {p.proposalType}
                    </span>
                    {summary && (
                      <span className="text-sm">{summary}</span>
                    )}
                  </div>
                  <p className="mt-1.5 text-sm">{p.rationale}</p>
                  {(Object.keys(before).length > 0 || Object.keys(after).length > 0) && (
                    <div className="mt-2 grid grid-cols-2 gap-2 rounded-[var(--radius-sm)] bg-[color:var(--color-muted)]/30 p-2 text-xs font-mono">
                      <div>
                        <div className="mb-0.5 text-[10px] uppercase text-[color:var(--color-muted-foreground)]">
                          before
                        </div>
                        <pre className="whitespace-pre-wrap break-words">
                          {JSON.stringify(before, null, 2)}
                        </pre>
                      </div>
                      <div>
                        <div className="mb-0.5 text-[10px] uppercase text-[color:var(--color-muted-foreground)]">
                          after
                        </div>
                        <pre className="whitespace-pre-wrap break-words">
                          {JSON.stringify(after, null, 2)}
                        </pre>
                      </div>
                    </div>
                  )}
                  <div className="mt-3 flex items-center gap-2">
                    <form action={approveStrategyProposalAction}>
                      <input type="hidden" name="proposalId" value={p.id} />
                      <input type="hidden" name="probeId" value={probe.id} />
                      <button
                        type="submit"
                        className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-3 py-1 text-xs font-medium text-[color:var(--color-background)]"
                      >
                        Approve
                      </button>
                    </form>
                    <form
                      action={rejectStrategyProposalAction}
                      className="flex flex-1 items-center gap-2"
                    >
                      <input type="hidden" name="proposalId" value={p.id} />
                      <input type="hidden" name="probeId" value={probe.id} />
                      <input
                        type="text"
                        name="feedback"
                        placeholder="reason (rides into next plan-gen pass)"
                        className="flex-1 rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-xs focus:border-[color:var(--color-foreground)] focus:outline-none"
                      />
                      <button
                        type="submit"
                        className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-3 py-1 text-xs font-medium hover:bg-[color:var(--color-muted)]/40"
                      >
                        Reject
                      </button>
                    </form>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {reviewedProposals.length > 0 && (
          <details className="mt-4">
            <summary className="cursor-pointer text-xs text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]">
              History ({reviewedProposals.length})
            </summary>
            <ul className="mt-2 space-y-1.5 text-xs">
              {reviewedProposals.slice(0, 10).map((p) => (
                <li key={p.id} className="flex items-start gap-2">
                  <span
                    className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                      p.status === 'approved'
                        ? 'bg-green-100 text-green-900'
                        : 'bg-[color:var(--color-muted)]/60'
                    }`}
                  >
                    {p.status}
                  </span>
                  <span className="font-mono">{p.proposalType}</span>
                  <span className="flex-1 text-[color:var(--color-muted-foreground)]">
                    {p.reviewerFeedback ?? p.rationale.slice(0, 120)}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      {/* Market atlas — facts about market structure that persist
          across probes. Operator + agent both write here. */}
      <section className="mt-6 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Market atlas
            <span className="ml-2 text-xs text-[color:var(--color-muted-foreground)] normal-case">
              {atlasFacts.length} fact{atlasFacts.length === 1 ? '' : 's'} from this probe
            </span>
          </h2>
          {probe.country && (
            <Link
              href={`/market-atlas/${probe.country.toUpperCase()}`}
              className="text-xs underline text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"
            >
              See all facts for {probe.country.toUpperCase()} →
            </Link>
          )}
        </div>

        {/* Add-fact form */}
        <form
          action={addAtlasFactAction}
          className="mb-4 grid gap-2 rounded-[var(--radius-md)] border border-dashed border-[color:var(--color-border)] p-3 text-xs md:grid-cols-[140px,140px,140px,1fr,auto]"
        >
          <input type="hidden" name="probeId" value={probe.id} />
          <input
            type="text"
            name="country"
            defaultValue={probe.country?.toUpperCase() ?? ''}
            placeholder="country (ISO-2)"
            required
            className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1"
          />
          <select
            name="factType"
            required
            className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1"
          >
            {ATLAS_FACT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <input
            type="text"
            name="entitySlug"
            placeholder="entity slug (optional)"
            className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1"
          />
          <input
            type="text"
            name="description"
            placeholder='e.g. "Vitol Caribbean handles all USVI fuel; reps direct queries to ops@..."'
            required
            className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1"
          />
          <button
            type="submit"
            className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-3 py-1 font-medium hover:bg-[color:var(--color-muted)]/40"
          >
            Add fact
          </button>
          <input
            type="text"
            name="ruleText"
            placeholder='Optional rule_text — for negative_rule / procurement_pattern, e.g. "never target generic info@ inboxes for fuel"'
            className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 md:col-span-5"
          />
        </form>

        {atlasFacts.length === 0 ? (
          <p className="text-sm text-[color:var(--color-muted-foreground)]">
            No facts captured for this probe yet. Write what you learn —
            gatekeepers, dead ends, referrals, surprising assumptions —
            so the next probe in this market starts smarter.
          </p>
        ) : (
          <ul className="space-y-2 text-sm">
            {atlasFacts.map((f) => (
              <li
                key={f.id}
                className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] p-2.5"
              >
                <div className="flex items-baseline gap-2">
                  <span className="rounded-full bg-[color:var(--color-muted)]/60 px-2 py-0.5 text-[10px] font-mono">
                    {f.factType}
                  </span>
                  {f.entitySlug && (
                    <Link
                      href={`/entities/${encodeURIComponent(f.entitySlug)}`}
                      className="text-xs font-medium hover:underline"
                    >
                      {f.entitySlug}
                    </Link>
                  )}
                  <span className="ml-auto text-[10px] text-[color:var(--color-muted-foreground)]">
                    {f.authoredBy} · {Math.round(Number(f.confidence) * 100)}%
                  </span>
                </div>
                <p className="mt-1">{f.description}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Market map — per-segment coverage. Operator sets
          estimatedTotal; counts auto-aggregate from targets via
          refreshSegmentCounts on scorecard read. */}
      <section className="mt-6 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-5">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
          Market map ({segments.length} segment{segments.length === 1 ? '' : 's'})
        </h2>

        {segments.length === 0 ? (
          <p className="text-sm text-[color:var(--color-muted-foreground)]">
            No segments tracked yet. The scorecard auto-creates segment
            rows as targets land with a `segment` value; or set an
            estimated total below to track coverage explicitly.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-[color:var(--color-muted-foreground)]">
                <tr>
                  <th className="px-2 py-1 text-left">Segment</th>
                  <th className="px-2 py-1 text-right">Identified</th>
                  <th className="px-2 py-1 text-right">Contacted</th>
                  <th className="px-2 py-1 text-right">Replied</th>
                  <th className="px-2 py-1 text-right">Est. total</th>
                  <th className="px-2 py-1 text-right">Coverage</th>
                </tr>
              </thead>
              <tbody>
                {segments.map((s) => {
                  const cov =
                    s.estimatedTotal && s.estimatedTotal > 0
                      ? Math.round((s.contactedCount / s.estimatedTotal) * 100)
                      : null;
                  return (
                    <tr key={s.id} className="border-t border-[color:var(--color-border)]">
                      <td className="px-2 py-1 font-medium">{s.segmentName}</td>
                      <td className="px-2 py-1 text-right font-mono">
                        {s.identifiedCount}
                      </td>
                      <td className="px-2 py-1 text-right font-mono">
                        {s.contactedCount}
                      </td>
                      <td className="px-2 py-1 text-right font-mono">
                        {s.repliedCount}
                      </td>
                      <td className="px-2 py-1 text-right font-mono">
                        {s.estimatedTotal ?? '—'}
                      </td>
                      <td className="px-2 py-1 text-right font-mono">
                        {cov != null ? `${cov}%` : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <form
          action={upsertSegmentAction}
          className="mt-3 grid gap-2 rounded-[var(--radius-md)] border border-dashed border-[color:var(--color-border)] p-3 text-xs md:grid-cols-[1fr,140px,auto]"
        >
          <input type="hidden" name="probeId" value={probe.id} />
          <input
            type="text"
            name="segmentName"
            placeholder="segment name (e.g. hotel_procurement)"
            required
            className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1"
          />
          <input
            type="number"
            name="estimatedTotal"
            placeholder="est. total"
            className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1"
          />
          <button
            type="submit"
            className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-3 py-1 font-medium hover:bg-[color:var(--color-muted)]/40"
          >
            Set / update
          </button>
        </form>
      </section>

      {/* Signal validation — top signals by reply correlation. */}
      {scorecard && scorecard.topSignals.length > 0 && (
        <section className="mt-6 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-5">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Signal validation
            <span className="ml-2 text-xs normal-case text-[color:var(--color-muted-foreground)]">
              top {scorecard.topSignals.length} by observation count
            </span>
          </h2>
          <p className="mb-2 text-xs text-[color:var(--color-muted-foreground)]">
            Reply rate <em>with</em> the signal vs <em>without</em>. Positive
            delta = signal predicts reply; negative = signal is anti-predictive
            or noise. Set per-target signal flags via the panel inside each
            target row.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-[color:var(--color-muted-foreground)]">
                <tr>
                  <th className="px-2 py-1 text-left">Signal</th>
                  <th className="px-2 py-1 text-right">w/ signal (sent / replied)</th>
                  <th className="px-2 py-1 text-right">w/o signal (sent / replied)</th>
                  <th className="px-2 py-1 text-right">Reply Δ</th>
                </tr>
              </thead>
              <tbody>
                {scorecard.topSignals.map((s) => {
                  const wn = s.withSignal.sent;
                  const wn2 = s.withoutSignal.sent;
                  return (
                    <tr key={s.signal} className="border-t border-[color:var(--color-border)]">
                      <td className="px-2 py-1 font-mono">{s.signal}</td>
                      <td className="px-2 py-1 text-right font-mono">
                        {wn} / {s.withSignal.replied}
                      </td>
                      <td className="px-2 py-1 text-right font-mono">
                        {wn2} / {s.withoutSignal.replied}
                      </td>
                      <td
                        className={`px-2 py-1 text-right font-mono ${
                          s.replyDelta > 0
                            ? 'text-green-700'
                            : s.replyDelta < 0
                              ? 'text-red-700'
                              : ''
                        }`}
                      >
                        {s.replyDelta > 0 ? '+' : ''}
                        {Math.round(s.replyDelta * 100)}%
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Learning report — end-of-probe Sonnet synthesis. Stored as
          a row so operator can re-read; playbook generator reads
          payload.playbookUpdates for nominations. */}
      <section className="mt-6 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Learning report
          </h2>
          <form action={generateLearningReportAction}>
            <input type="hidden" name="probeId" value={probe.id} />
            <button
              type="submit"
              className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-3 py-1.5 text-xs font-medium hover:bg-[color:var(--color-muted)]/40"
              title="Sonnet synthesizes scorecard + atlas + hypotheses + signals + feedback into a structured report."
            >
              {latestReport ? 'Regenerate report' : 'Generate report'}
            </button>
          </form>
        </div>

        {!latestReport ? (
          <p className="text-sm text-[color:var(--color-muted-foreground)]">
            No report yet. Click <strong>Generate report</strong> after
            the probe has activity (sends + replies + atlas facts) — the
            agent will diff what we believed at start vs what changed,
            nominate playbook fields, and recommend the next probe.
          </p>
        ) : (
          <div className="space-y-3 text-sm">
            <p className="font-medium">{latestReport.summary}</p>
            <p className="text-[10px] text-[color:var(--color-muted-foreground)]">
              Generated {latestReport.generatedAt.toLocaleString()}
              {latestReport.generatedByModel && ` · ${latestReport.generatedByModel}`}
            </p>
            <LearningReportPayloadView
              payload={latestReport.payloadJson}
            />

            {/* Save-as-playbook form — pre-fills from report
                nominations; operator edits and submits. */}
            <details className="mt-4 rounded-[var(--radius-md)] border border-dashed border-[color:var(--color-border)] p-3">
              <summary className="cursor-pointer text-xs font-medium">
                Save as playbook
              </summary>
              <form
                action={savePlaybookFromProbeAction}
                className="mt-3 grid gap-2 text-xs"
              >
                <input type="hidden" name="probeId" value={probe.id} />
                <input
                  type="text"
                  name="name"
                  defaultValue={
                    latestReport.payloadJson?.playbookUpdates?.name ?? ''
                  }
                  placeholder='e.g. "Caribbean Food Importer Playbook v1"'
                  required
                  className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1"
                />
                <textarea
                  name="description"
                  rows={2}
                  placeholder="Optional description"
                  className="resize-y rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1"
                />
                <input
                  type="text"
                  name="applicableCountries"
                  defaultValue={
                    latestReport.payloadJson?.playbookUpdates
                      ?.applicableCountries?.join(', ') ??
                    probe.country?.toUpperCase() ??
                    ''
                  }
                  placeholder="comma-separated ISO-2 (e.g. BB, JM, BS)"
                  className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1"
                />
                <input
                  type="text"
                  name="recommendedSegments"
                  defaultValue={
                    latestReport.payloadJson?.playbookUpdates
                      ?.recommendedSegments?.join(', ') ?? ''
                  }
                  placeholder="recommended segments (comma-separated)"
                  className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1"
                />
                <input
                  type="text"
                  name="bestContactTitles"
                  defaultValue={
                    latestReport.payloadJson?.playbookUpdates
                      ?.bestContactTitles?.join(', ') ?? ''
                  }
                  placeholder="best contact titles (comma-separated)"
                  className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1"
                />
                <input
                  type="text"
                  name="bestFirstTouchAngle"
                  defaultValue={
                    latestReport.payloadJson?.playbookUpdates
                      ?.bestFirstTouchAngle ?? ''
                  }
                  placeholder="best first-touch angle"
                  className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1"
                />
                <button
                  type="submit"
                  className="self-start rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-3 py-1.5 text-xs font-medium text-[color:var(--color-background)]"
                >
                  Save as draft playbook
                </button>
              </form>
            </details>
          </div>
        )}
      </section>

      {/* Message variants — A/B framework. Operator authors 2-3
          variants; autopilot picks per target via weighted sampling
          among 'active' variants. Per-variant outcomes (sent /
          replied / positive / bounce) aggregate via
          computeVariantPerformance. */}
      <section className="mt-6 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Message variants ({variants.length})
          </h2>
          {variants.some((v) => v.status === 'active' || v.status === 'paused') && (
            <form action={generateVariantProposalsAction}>
              <input type="hidden" name="probeId" value={probe.id} />
              <button
                type="submit"
                className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-3 py-1 text-xs font-medium hover:bg-[color:var(--color-muted)]/40"
                title="Sonnet pass — reads current variants + per-variant reply rates and emits 0-3 nominations as paused variants. Operator activates via Status."
              >
                Propose new variants
              </button>
            </form>
          )}
        </div>

        {variants.length === 0 ? (
          <p className="mb-4 text-sm text-[color:var(--color-muted-foreground)]">
            No variants yet. Authoring 2-3 variants lets the autopilot
            sample across them and surface a winning template. Without
            variants the autopilot falls back to the plan&apos;s outreach
            angle.
          </p>
        ) : (
          <div className="mb-4 overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-[color:var(--color-muted-foreground)]">
                <tr>
                  <th className="px-2 py-1 text-left">Variant</th>
                  <th className="px-2 py-1 text-left">Status</th>
                  <th className="px-2 py-1 text-right">Sent</th>
                  <th className="px-2 py-1 text-right">Reply</th>
                  <th className="px-2 py-1 text-right">Positive</th>
                  <th className="px-2 py-1 text-right">Bounce</th>
                  <th className="px-2 py-1 text-left">Actions</th>
                </tr>
              </thead>
              <tbody>
                {variants.map((v) => {
                  const perf = variantPerformance.find(
                    (p) => p.variantId === v.id,
                  );
                  const sent = perf?.sent ?? 0;
                  const replyPct = perf
                    ? Math.round(perf.replyRate * 100)
                    : 0;
                  const posPct = perf
                    ? Math.round(perf.positiveReplyRate * 100)
                    : 0;
                  const bouncePct = perf
                    ? Math.round(perf.bounceRate * 100)
                    : 0;
                  return (
                    <tr
                      key={v.id}
                      className="border-t border-[color:var(--color-border)]"
                    >
                      <td className="px-2 py-1 font-medium">
                        {v.variantName}
                        {v.angle && (
                          <span className="ml-2 text-[color:var(--color-muted-foreground)]">
                            — {v.angle}
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-1">
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                            v.status === 'winner'
                              ? 'bg-green-100 text-green-900'
                              : v.status === 'active'
                                ? 'bg-blue-100 text-blue-900'
                                : v.status === 'paused'
                                  ? 'bg-yellow-100 text-yellow-900'
                                  : 'bg-[color:var(--color-muted)]/60'
                          }`}
                        >
                          {v.status}
                        </span>
                      </td>
                      <td className="px-2 py-1 text-right font-mono">{sent}</td>
                      <td className="px-2 py-1 text-right font-mono">
                        {sent > 0 ? `${replyPct}%` : '—'}
                      </td>
                      <td className="px-2 py-1 text-right font-mono">
                        {sent > 0 ? `${posPct}%` : '—'}
                      </td>
                      <td className="px-2 py-1 text-right font-mono">
                        {sent > 0 ? `${bouncePct}%` : '—'}
                      </td>
                      <td className="px-2 py-1">
                        <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
                          {v.status !== 'winner' && (
                            <form action={setVariantStatusAction}>
                              <input
                                type="hidden"
                                name="probeId"
                                value={probe.id}
                              />
                              <input
                                type="hidden"
                                name="variantId"
                                value={v.id}
                              />
                              <input
                                type="hidden"
                                name="status"
                                value="winner"
                              />
                              <button
                                type="submit"
                                className="hover:underline"
                                title="Promote to winner — autopilot uses ONLY this variant; others move to archived."
                              >
                                promote winner
                              </button>
                            </form>
                          )}
                          {v.status === 'active' && (
                            <form action={setVariantStatusAction}>
                              <input
                                type="hidden"
                                name="probeId"
                                value={probe.id}
                              />
                              <input
                                type="hidden"
                                name="variantId"
                                value={v.id}
                              />
                              <input
                                type="hidden"
                                name="status"
                                value="paused"
                              />
                              <button
                                type="submit"
                                className="hover:underline"
                              >
                                pause
                              </button>
                            </form>
                          )}
                          {v.status === 'paused' && (
                            <form action={setVariantStatusAction}>
                              <input
                                type="hidden"
                                name="probeId"
                                value={probe.id}
                              />
                              <input
                                type="hidden"
                                name="variantId"
                                value={v.id}
                              />
                              <input
                                type="hidden"
                                name="status"
                                value="active"
                              />
                              <button
                                type="submit"
                                className="hover:underline"
                              >
                                resume
                              </button>
                            </form>
                          )}
                          {(v.status === 'active' || v.status === 'paused') && (
                            <form action={setVariantStatusAction}>
                              <input
                                type="hidden"
                                name="probeId"
                                value={probe.id}
                              />
                              <input
                                type="hidden"
                                name="variantId"
                                value={v.id}
                              />
                              <input
                                type="hidden"
                                name="status"
                                value="archived"
                              />
                              <button
                                type="submit"
                                className="text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)] hover:underline"
                              >
                                archive
                              </button>
                            </form>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <form
          action={createVariantAction}
          className="grid gap-2 rounded-[var(--radius-md)] border border-dashed border-[color:var(--color-border)] p-3 text-xs"
        >
          <input type="hidden" name="probeId" value={probe.id} />
          <div className="grid gap-2 md:grid-cols-2">
            <input
              type="text"
              name="variantName"
              placeholder="variant name (e.g. routing-v1)"
              required
              className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1"
            />
            <input
              type="text"
              name="angle"
              placeholder="angle (e.g. routing / supplier-intro / industry-question)"
              className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1"
            />
          </div>
          <input
            type="text"
            name="subjectTemplate"
            placeholder="subject template (optional — agent draft uses this as seed)"
            className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1"
          />
          <textarea
            name="bodyTemplate"
            rows={3}
            placeholder="body template / direction (optional — agent uses this as intent. e.g. 'Are you the right person for supplier inquiries? routing tone, 2-3 sentences, no commercial language.')"
            className="resize-y rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1"
          />
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5">
              <span className="text-[10px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
                weight
              </span>
              <input
                type="number"
                step="0.1"
                name="weight"
                defaultValue="1"
                className="w-16 rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1"
              />
            </label>
            <button
              type="submit"
              className="ml-auto rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-3 py-1 font-medium hover:bg-[color:var(--color-muted)]/40"
            >
              Add variant
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function LearningReportPayloadView({
  payload,
}: {
  payload: LearningReportPayload;
}) {
  return (
    <div className="space-y-3">
      {payload.whatWeBelievedAtStart && (
        <ReportField label="What we believed at start" text={payload.whatWeBelievedAtStart} />
      )}
      {payload.whatChanged && (
        <ReportField label="What changed" text={payload.whatChanged} />
      )}
      {payload.whatWorked && payload.whatWorked.length > 0 && (
        <ReportList label="What worked" items={payload.whatWorked} />
      )}
      {payload.whatFailed && payload.whatFailed.length > 0 && (
        <ReportList label="What failed" items={payload.whatFailed} />
      )}
      {payload.bestSegment && (
        <ReportField
          label="Best segment"
          text={`${payload.bestSegment.name} — ${payload.bestSegment.evidence}`}
        />
      )}
      {payload.worstSegment && (
        <ReportField
          label="Worst segment"
          text={`${payload.worstSegment.name} — ${payload.worstSegment.evidence}`}
        />
      )}
      {payload.bestContactTitle && (
        <ReportField
          label="Best contact title"
          text={`${payload.bestContactTitle.title} — ${payload.bestContactTitle.evidence}`}
        />
      )}
      {payload.strongestSignal && (
        <ReportField
          label="Strongest signal"
          text={`${payload.strongestSignal.signal} (Δ ${Math.round(payload.strongestSignal.replyDelta * 100)}%) — ${payload.strongestSignal.evidence}`}
        />
      )}
      {payload.noisySignals && payload.noisySignals.length > 0 && (
        <ReportList label="Noisy signals" items={payload.noisySignals} />
      )}
      {payload.badTargetRules && payload.badTargetRules.length > 0 && (
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
            Bad-target rules (proposed atlas negative_rule entries)
          </div>
          <ul className="mt-1 list-disc pl-5 text-xs">
            {payload.badTargetRules.map((r, i) => (
              <li key={i}>
                <strong>{r.rule}</strong> — {r.rationale}
              </li>
            ))}
          </ul>
        </div>
      )}
      {payload.recommendedNextProbe && (
        <div className="rounded-[var(--radius-sm)] border border-dashed border-[color:var(--color-border)] p-2">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
            Recommended next probe
          </div>
          <p className="mt-1 text-xs">
            <strong>Country:</strong>{' '}
            {payload.recommendedNextProbe.country ?? '(unspecified)'}
          </p>
          {payload.recommendedNextProbe.segments &&
            payload.recommendedNextProbe.segments.length > 0 && (
              <p className="text-xs">
                <strong>Segments:</strong>{' '}
                {payload.recommendedNextProbe.segments.join(', ')}
              </p>
            )}
          {payload.recommendedNextProbe.rationale && (
            <p className="mt-1 text-xs">
              {payload.recommendedNextProbe.rationale}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function ReportField({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
        {label}
      </div>
      <p className="mt-0.5 text-xs">{text}</p>
    </div>
  );
}

function ReportList({ label, items }: { label: string; items: string[] }) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
        {label}
      </div>
      <ul className="mt-0.5 list-disc pl-5 text-xs">
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
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
