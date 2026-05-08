import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireCompany } from '@procur/auth';
import {
  countTargetsByJustification,
  getProbe,
  listProbeFeedbackShortcuts,
  listTargetsForProbe,
  PROBE_FEEDBACK_LABELS,
  PROBE_SIGNAL_KINDS,
  type ProbeFeedbackLabel,
} from '@procur/catalog';
import { SignalFlagsForm } from '../../_components/SignalFlagsForm';
import { TargetFeedbackChips } from '../../_components/TargetFeedbackChips';
import {
  addProbeTargetAction,
  dismissAllPendingTargetsAction,
  findDecisionMakersAction,
  markTargetResearchOnlyAction,
  setTargetJustificationAction,
} from '../../actions';

export const dynamic = 'force-dynamic';

const FIT_TONE: Record<string, string> = {
  A: 'bg-green-100 text-green-900',
  B: 'bg-blue-100 text-blue-900',
  C: 'bg-[color:var(--color-muted)]/60',
  D: 'bg-red-100 text-red-900',
};

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function ProbeTargetsPage({ params }: PageProps) {
  await requireCompany();
  const { id } = await params;
  const probe = await getProbe(id);
  if (!probe) notFound();

  const [targets, justificationCounts, feedbackShortcuts] = await Promise.all([
    listTargetsForProbe(id),
    countTargetsByJustification(id),
    listProbeFeedbackShortcuts(id),
  ]);

  const feedbackByTargetId = new Map<string, Set<ProbeFeedbackLabel>>();
  for (const event of feedbackShortcuts) {
    if (!event.targetId) continue;
    const label = (event.payload as { label?: unknown })?.label;
    if (typeof label !== 'string') continue;
    let set = feedbackByTargetId.get(event.targetId);
    if (!set) {
      set = new Set<ProbeFeedbackLabel>();
      feedbackByTargetId.set(event.targetId, set);
    }
    set.add(label as ProbeFeedbackLabel);
  }

  return (
    <section className="rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-5">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
          Targets ({targets.length})
        </h2>
        {justificationCounts.pending > 0 && (
          <form action={dismissAllPendingTargetsAction}>
            <input type="hidden" name="probeId" value={probe.id} />
            <button
              type="submit"
              className="text-[11px] text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)] hover:underline"
              title={`Flip all ${justificationCounts.pending} pending targets to research_only so autopilot skips them.`}
            >
              Dismiss all {justificationCounts.pending} pending
            </button>
          </form>
        )}
      </div>
      <p className="mb-3 text-xs text-[color:var(--color-muted-foreground)]">
        {justificationCounts.justified} justified ·{' '}
        {justificationCounts.pending} pending ·{' '}
        {justificationCounts.research_only} research-only.{' '}
        <span className="italic">
          Tier 1 autopilot only sends to justified targets (Phase 2H).
        </span>
      </p>
      <form
        action={addProbeTargetAction}
        className="mb-3 flex items-center gap-1.5"
      >
        <input type="hidden" name="probeId" value={probe.id} />
        <input
          type="text"
          name="entitySlug"
          placeholder="entity slug (e.g. caribbean-importers:wibisco)"
          required
          maxLength={200}
          className="flex-1 rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-xs"
        />
        <button
          type="submit"
          className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2.5 py-1 text-xs hover:bg-[color:var(--color-muted)]/40"
          title="Add an entity from the rolodex as a target. Defaults to fitTier C; idempotent on the same slug."
        >
          Add target
        </button>
      </form>
      {targets.length === 0 ? (
        <p className="text-sm text-[color:var(--color-muted-foreground)]">
          No targets yet. Run <strong>Discover targets</strong> on the
          Overview tab to populate via the intelligence-graph ranker
          (graph similarity + customs + web intelligence + Apollo +
          recency).
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
                      title="Dismiss — flips send_status to research_only so autopilot skips this target."
                    >
                      dismiss
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
                <details className="mt-2">
                  <summary className="cursor-pointer text-[11px] text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]">
                    Justification {t.justificationState === 'justified' ? '✓' : ''}
                  </summary>
                  <form
                    action={setTargetJustificationAction}
                    className="mt-2 grid gap-2 rounded-[var(--radius-sm)] border border-dashed border-[color:var(--color-border)] p-2 text-xs"
                  >
                    <input type="hidden" name="probeId" value={probe.id} />
                    <input type="hidden" name="targetId" value={t.id} />
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
                <TargetFeedbackChips
                  probeId={probe.id}
                  targetId={t.id}
                  labels={PROBE_FEEDBACK_LABELS}
                  selectedLabels={[
                    ...(feedbackByTargetId.get(t.id) ?? new Set<string>()),
                  ]}
                />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
