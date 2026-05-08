import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireCompany } from '@procur/auth';
import { getProbe, listTargetsForProbe } from '@procur/catalog';
import {
  discoverTargetsAction,
  generatePlanAction,
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
  const targets = await listTargetsForProbe(id);

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
              {!probe.country && (
                <p className="mt-1 text-[11px] text-[color:var(--color-muted-foreground)]">
                  Set country (ISO-2) to enable discovery.
                </p>
              )}
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
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
