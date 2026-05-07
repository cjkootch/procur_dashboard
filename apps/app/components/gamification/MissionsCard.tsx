import { getCurrentUser } from '@procur/auth';
import {
  evaluateAutomatedMissions,
  listActiveMissions,
  spawnDealLifecycleMissions,
} from '@procur/catalog';
import {
  abandonMissionAction,
  completeMissionStageAction,
} from '../../app/missions/actions';

/**
 * Live-missions card on the home Brief. Renders each active mission
 * (deal-bound or chat-proposed custom) as a stacked checklist of
 * stages. Manual stages on custom missions show a "Mark done" button
 * wired to a server action; automated stages on deal_lifecycle
 * missions render as read-only progress (they auto-tick from the
 * post-awardXp evaluator).
 *
 * Server component. On render:
 *   1. spawnDealLifecycleMissions — ensures every active deal has
 *      a mission row (idempotent on the unique partial index).
 *   2. evaluateAutomatedMissions — catches up any stage that
 *      crossed its predicate since the last awardXp pass.
 *   3. listActiveMissions — read for render.
 */
export async function MissionsCard() {
  const user = await getCurrentUser();
  if (!user) return null;

  try {
    await spawnDealLifecycleMissions(user.id);
    await evaluateAutomatedMissions(user.id);
  } catch {
    // Render even when the spawn / eval pass fails — the read below
    // is the fallback path.
  }

  let missions;
  try {
    missions = await listActiveMissions(user.id, { limit: 5 });
  } catch {
    return null;
  }
  if (missions.length === 0) return null;

  return (
    <section
      className="flex flex-col rounded-[var(--radius-lg)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-4 md:col-span-2"
      style={{ boxShadow: 'var(--shadow-sm)' }}
    >
      <header className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          Live missions
        </h2>
        <span className="text-xs text-[color:var(--color-muted-foreground)]">
          {missions.length} active
        </span>
      </header>

      <div className="space-y-3">
        {missions.map((m) => {
          const pct = Math.round(
            (m.progress.completed / Math.max(1, m.progress.total)) * 100,
          );
          return (
            <article
              key={m.id}
              className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] p-3"
            >
              <header className="mb-2 flex items-baseline justify-between gap-2">
                <h3 className="truncate text-sm font-semibold">{m.title}</h3>
                <div className="flex items-center gap-2 text-xs text-[color:var(--color-muted-foreground)]">
                  <span>
                    {m.progress.completed} / {m.progress.total}
                  </span>
                  <span className="rounded-full bg-[color:var(--color-muted)]/60 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
                    +{m.completionBonus} XP bonus
                  </span>
                </div>
              </header>
              <div className="mb-2 h-1.5 w-full overflow-hidden rounded-full bg-[color:var(--color-muted)]">
                <div
                  className="h-full bg-[color:var(--color-foreground)]"
                  style={{ width: `${pct}%` }}
                />
              </div>
              {m.description && (
                <p className="mb-2 text-xs text-[color:var(--color-muted-foreground)]">
                  {m.description}
                </p>
              )}
              <ol className="space-y-1.5">
                {m.stages.map((s, i) => {
                  const done = Boolean(s.completedAt);
                  const stagePct =
                    s.progress
                      ? Math.min(
                          100,
                          Math.round(
                            (s.progress.current / Math.max(1, s.progress.target)) *
                              100,
                          ),
                        )
                      : null;
                  return (
                    <li
                      key={s.key}
                      className="flex items-start gap-2 text-xs"
                    >
                      <span
                        className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                          done
                            ? 'border-[color:var(--color-foreground)] bg-[color:var(--color-foreground)] text-[color:var(--color-background)]'
                            : 'border-[color:var(--color-border)] text-[color:var(--color-muted-foreground)]'
                        }`}
                      >
                        {done ? '✓' : i + 1}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-2">
                          <span
                            className={`truncate ${done ? 'line-through text-[color:var(--color-muted-foreground)]' : 'font-medium'}`}
                          >
                            {s.title}
                          </span>
                          <div className="flex shrink-0 items-center gap-1.5 text-[color:var(--color-muted-foreground)]">
                            {s.automated && (
                              <span className="rounded-full bg-violet-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-violet-900">
                                Auto
                              </span>
                            )}
                            <span>+{s.xpReward}</span>
                          </div>
                        </div>
                        {s.description && (
                          <p className="mt-0.5 text-[11px] text-[color:var(--color-muted-foreground)]">
                            {s.description}
                          </p>
                        )}
                        {s.automated && s.progress && !done && (
                          <div className="mt-1 flex items-center gap-2 text-[11px]">
                            <div className="h-1 flex-1 overflow-hidden rounded-full bg-[color:var(--color-muted)]">
                              <div
                                className="h-full bg-[color:var(--color-foreground)]/70"
                                style={{ width: `${stagePct ?? 0}%` }}
                              />
                            </div>
                            <span className="shrink-0 text-[color:var(--color-muted-foreground)]">
                              {s.progress.current} / {s.progress.target}
                            </span>
                          </div>
                        )}
                        {s.automated && s.predicateLabel && !done && (
                          <p className="mt-0.5 text-[10px] text-[color:var(--color-muted-foreground)]">
                            Tracks: {s.predicateLabel}
                          </p>
                        )}
                        {!done && !s.automated && (
                          <form action={completeMissionStageAction} className="mt-1">
                            <input type="hidden" name="missionId" value={m.id} />
                            <input type="hidden" name="stageKey" value={s.key} />
                            <button
                              type="submit"
                              className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-0.5 text-[11px] font-medium hover:border-[color:var(--color-foreground)]"
                            >
                              Mark done
                            </button>
                          </form>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
              <div className="mt-2 flex justify-end">
                <form action={abandonMissionAction}>
                  <input type="hidden" name="missionId" value={m.id} />
                  <button
                    type="submit"
                    className="text-[11px] text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"
                  >
                    Dismiss mission
                  </button>
                </form>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
