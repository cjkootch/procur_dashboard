import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireCompany } from '@procur/auth';
import {
  getProbe,
  listAtlasFactsForProbe,
  listStrategyProposals,
  listTargetsForProbe,
  ATLAS_FACT_TYPES,
} from '@procur/catalog';
import {
  addApolloLookalikesAction,
  addAtlasFactAction,
  addThesisOrgsAction,
  approveStrategyProposalAction,
  discoverTargetsAction,
  findDecisionMakersAction,
  generatePlanAction,
  generateStrategyProposalsAction,
  rejectStrategyProposalAction,
  setProbeStatusAction,
  setTaskSkippedAction,
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
  const [targets, atlasFacts, pendingProposals, reviewedProposals] =
    await Promise.all([
      listTargetsForProbe(id),
      listAtlasFactsForProbe(id),
      listStrategyProposals(id, { status: 'proposed' }),
      Promise.all([
        listStrategyProposals(id, { status: 'approved' }),
        listStrategyProposals(id, { status: 'rejected' }),
      ]).then(([a, r]) => [...a, ...r].sort((x, y) =>
        (y.reviewedAt?.getTime() ?? 0) - (x.reviewedAt?.getTime() ?? 0),
      )),
    ]);

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

          <div className="mt-5 space-y-1 text-xs text-[color:var(--color-muted-foreground)]">
            <p>
              Tier {probe.tier} — Phase 1 ships research-only. Autopilot
              graduation arrives in Phase 2.
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
                  <div className="mt-1.5 flex items-center gap-2">
                    <form action={findDecisionMakersAction}>
                      <input type="hidden" name="probeId" value={probe.id} />
                      <input type="hidden" name="targetId" value={t.id} />
                      <button
                        type="submit"
                        className="text-[11px] text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)] hover:underline"
                        title="Run Apollo searchPeople for decision-makers at this org. Results land in the entity profile's Decision-makers panel."
                      >
                        Find decision-makers
                      </button>
                    </form>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
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
    </div>
  );
}
