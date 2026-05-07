import Link from 'next/link';
import { getCurrentUser } from '@procur/auth';
import { getDailyQuests } from '@procur/catalog';

/**
 * Today's Quests card for the home Brief. Server component, evaluates
 * 3 daily quests on render. Each quest's predicate is a SQL count
 * over today's events; quest-complete transitions write to the
 * xp_ledger and fire a `gamification.quest_complete` notification
 * inline.
 *
 * Styled to match the existing BriefCard pattern in
 * apps/app/app/page.tsx so it sits in the 2-col grid without
 * standing out.
 */
export async function QuestsCard() {
  const user = await getCurrentUser();
  if (!user) return null;
  let quests;
  try {
    quests = await getDailyQuests(user.id);
  } catch {
    return null;
  }
  const completedCount = quests.filter((q) => q.complete).length;

  return (
    <section
      className="flex flex-col rounded-[var(--radius-lg)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-4 md:col-span-2"
      style={{ boxShadow: 'var(--shadow-sm)' }}
    >
      <header className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          Today&apos;s quests
        </h2>
        <span className="text-xs text-[color:var(--color-muted-foreground)]">
          {completedCount} of {quests.length} complete
        </span>
      </header>

      <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
        {quests.length === 0 ? (
          <div className="col-span-full text-xs text-[color:var(--color-muted-foreground)]">
            No quests available.
          </div>
        ) : (
          quests.map((q) => {
            const pct = Math.min(
              100,
              Math.round((q.count / Math.max(1, q.target)) * 100),
            );
            return (
              <div
                key={q.key}
                className={`rounded-[var(--radius-md)] border px-3 py-2 ${
                  q.complete
                    ? 'border-[color:var(--color-foreground)] bg-[color:var(--color-muted)]/30'
                    : 'border-[color:var(--color-border)]'
                }`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <p className="truncate text-sm font-medium">{q.title}</p>
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
                <p className="mt-0.5 line-clamp-2 text-xs text-[color:var(--color-muted-foreground)]">
                  {q.description}
                </p>
                <div className="mt-2 flex items-center gap-2 text-xs">
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
              </div>
            );
          })
        )}
      </div>

      <div className="mt-3 flex items-center justify-end">
        <Link
          href="/quests"
          className="text-xs text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"
        >
          View history →
        </Link>
      </div>
    </section>
  );
}
