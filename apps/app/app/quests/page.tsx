import { redirect } from 'next/navigation';
import { getCurrentUser } from '@procur/auth';
import {
  getDailyQuests,
  listQuestHistory,
  QUEST_REGISTRY,
} from '@procur/catalog';
import { AppShell } from '../../components/shell/AppShell';

export const dynamic = 'force-dynamic';

/**
 * /quests — full quest surface. Three sections:
 *
 *   1. Today's quests (the same trio rendered on the home Brief, in
 *      a roomier layout with longer descriptions and full progress
 *      visible).
 *   2. Last 7 days history — completion count + total XP earned per
 *      day so Cole can see his quest-completion rhythm.
 *   3. Quest pool — the full registered catalog, including the ones
 *      not in today's rotation, with category + XP reward.
 */
export default async function QuestsPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/sign-in');

  const [today, history] = await Promise.all([
    getDailyQuests(user.id),
    listQuestHistory(user.id, 7),
  ]);

  const totalQuestXp7d = history.reduce((sum, d) => sum + d.totalQuestXp, 0);
  const completedCount7d = history.reduce(
    (sum, d) => sum + d.questsCompleted,
    0,
  );

  return (
    <AppShell title="Quests">
      <div className="mx-auto max-w-4xl px-4 py-6 md:px-6">
        <p className="mb-6 text-sm text-[color:var(--color-muted-foreground)]">
          Three daily quests refresh at UTC midnight. Completing one credits
          XP and fires a notification. Last 7 days:{' '}
          <strong>{completedCount7d}</strong> quests, {totalQuestXp7d} XP.
        </p>

        <section className="mb-8">
          <h2 className="mb-3 text-base font-semibold">Today</h2>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            {today.map((q) => {
              const pct = Math.min(
                100,
                Math.round((q.count / Math.max(1, q.target)) * 100),
              );
              return (
                <div
                  key={q.key}
                  className={`rounded-[var(--radius-lg)] border bg-[color:var(--color-background)] p-4 ${
                    q.complete
                      ? 'border-[color:var(--color-foreground)]'
                      : 'border-[color:var(--color-border)]'
                  }`}
                  style={{ boxShadow: 'var(--shadow-sm)' }}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <h3 className="text-sm font-semibold">{q.title}</h3>
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                        q.category === 'ml'
                          ? 'bg-violet-100 text-violet-900'
                          : q.category === 'hygiene'
                            ? 'bg-amber-100 text-amber-900'
                            : 'bg-sky-100 text-sky-900'
                      }`}
                    >
                      +{q.xpReward} XP
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">
                    {q.description}
                  </p>
                  <div className="mt-3 flex items-center gap-2 text-xs">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[color:var(--color-muted)]">
                      <div
                        className={`h-full ${
                          q.complete
                            ? 'bg-[color:var(--color-foreground)]'
                            : 'bg-[color:var(--color-foreground)]/60'
                        }`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="shrink-0 text-[color:var(--color-muted-foreground)]">
                      {q.count} / {q.target}
                    </span>
                  </div>
                  {q.completedAt && (
                    <p className="mt-2 text-[11px] text-[color:var(--color-muted-foreground)]">
                      ✓ Completed {q.completedAt.toLocaleTimeString()}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        <section className="mb-8">
          <h2 className="mb-3 text-base font-semibold">Last 7 days</h2>
          {history.length === 0 ? (
            <p className="text-xs text-[color:var(--color-muted-foreground)]">
              No quest completions in the last 7 days. Open a quest above to
              get the streak going.
            </p>
          ) : (
            <div className="overflow-hidden rounded-[var(--radius-lg)] border border-[color:var(--color-border)]">
              <table className="w-full text-sm">
                <thead className="bg-[color:var(--color-muted)]/40 text-left text-xs">
                  <tr>
                    <th className="px-3 py-2">Date</th>
                    <th className="px-3 py-2">Quests completed</th>
                    <th className="px-3 py-2">XP earned</th>
                    <th className="px-3 py-2">Quests</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((day) => (
                    <tr
                      key={day.dateIso}
                      className="border-t border-[color:var(--color-border)]"
                    >
                      <td className="px-3 py-2">{day.dateIso}</td>
                      <td className="px-3 py-2">{day.questsCompleted}</td>
                      <td className="px-3 py-2">+{day.totalQuestXp}</td>
                      <td className="px-3 py-2 text-xs text-[color:var(--color-muted-foreground)]">
                        {day.completedKeys.join(', ')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section>
          <h2 className="mb-3 text-base font-semibold">Quest pool</h2>
          <p className="mb-3 text-xs text-[color:var(--color-muted-foreground)]">
            Full catalog of registered quests. Three are picked per day,
            deterministically by the date — refresh the page and you&apos;ll
            see the same trio.
          </p>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {QUEST_REGISTRY.map((q) => (
              <div
                key={q.key}
                className={`rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-3 py-2 ${
                  q.enabled ? '' : 'opacity-60'
                }`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <p className="truncate text-sm font-medium">
                    {q.title}
                    {!q.enabled && (
                      <span className="ml-2 text-[11px] text-[color:var(--color-muted-foreground)]">
                        (coming soon)
                      </span>
                    )}
                  </p>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                      q.category === 'ml'
                        ? 'bg-violet-100 text-violet-900'
                        : q.category === 'hygiene'
                          ? 'bg-amber-100 text-amber-900'
                          : 'bg-sky-100 text-sky-900'
                    }`}
                  >
                    +{q.xpReward} XP
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-[color:var(--color-muted-foreground)]">
                  {q.description}
                </p>
              </div>
            ))}
          </div>
        </section>
      </div>
    </AppShell>
  );
}
