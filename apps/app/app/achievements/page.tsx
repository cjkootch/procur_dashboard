import { redirect } from 'next/navigation';
import { getCurrentUser } from '@procur/auth';
import {
  evaluateAchievements,
  listAchievementsForUser,
  type AchievementCategory,
} from '@procur/catalog';
import { AppShell } from '../../components/shell/AppShell';

export const dynamic = 'force-dynamic';

const CATEGORY_LABELS: Record<AchievementCategory, string> = {
  outreach: 'Outreach',
  kyc: 'KYC',
  deals: 'Deals',
  discipline: 'Discipline',
  ml: 'ML training',
  meta: 'Meta',
};

const CATEGORY_ORDER: AchievementCategory[] = [
  'outreach',
  'kyc',
  'deals',
  'discipline',
  'ml',
  'meta',
];

/**
 * /achievements — full grid of every registered achievement, locked
 * vs unlocked. Server-rendered. Re-evaluates predicates on render
 * so any criteria that crossed since last visit unlock immediately
 * (the post-awardXp eval should normally have done this, but this
 * is a belt-and-suspenders pass that also catches achievements
 * unlocked by activity outside the awardXp loop).
 */
export default async function AchievementsPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/sign-in');

  // Run a fresh eval pass. Idempotent — already-unlocked rows are
  // skipped at the conflict-do-nothing layer.
  await evaluateAchievements(user.id);

  const all = await listAchievementsForUser(user.id);
  const unlockedCount = all.filter((a) => a.unlocked).length;
  const totalXpFromAchievements = all
    .filter((a) => a.unlocked)
    .reduce((sum, a) => sum + a.xpReward, 0);

  const byCategory = new Map<AchievementCategory, typeof all>();
  for (const a of all) {
    const arr = byCategory.get(a.category) ?? [];
    arr.push(a);
    byCategory.set(a.category, arr);
  }

  return (
    <AppShell title="Achievements">
      <div className="mx-auto max-w-5xl px-4 py-6 md:px-6">
        <p className="mb-6 text-sm text-[color:var(--color-muted-foreground)]">
          One-time milestones tied to real progress. Unlocking one credits
          XP and fires a notification. So far:{' '}
          <strong>{unlockedCount}</strong> of {all.length} unlocked,{' '}
          {totalXpFromAchievements} XP earned.
        </p>

        {CATEGORY_ORDER.map((cat) => {
          const items = byCategory.get(cat) ?? [];
          if (items.length === 0) return null;
          return (
            <section key={cat} className="mb-8">
              <h2 className="mb-3 text-base font-semibold">
                {CATEGORY_LABELS[cat]}
              </h2>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
                {items.map((a) => (
                  <div
                    key={a.key}
                    className={`rounded-[var(--radius-lg)] border p-4 ${
                      a.unlocked
                        ? 'border-[color:var(--color-foreground)] bg-[color:var(--color-background)]'
                        : 'border-[color:var(--color-border)] bg-[color:var(--color-background)] opacity-60'
                    }`}
                    style={{ boxShadow: 'var(--shadow-sm)' }}
                  >
                    <div className="flex items-start gap-3">
                      <span className="text-2xl" aria-hidden="true">
                        {a.unlocked ? a.icon : '🔒'}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-2">
                          <h3 className="truncate text-sm font-semibold">
                            {a.name}
                          </h3>
                          <span className="shrink-0 rounded-full bg-[color:var(--color-muted)]/60 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
                            +{a.xpReward} XP
                          </span>
                        </div>
                        <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">
                          {a.description}
                        </p>
                        {a.unlocked && a.earnedAt && (
                          <p className="mt-2 text-[11px] text-[color:var(--color-muted-foreground)]">
                            ✓ Unlocked {a.earnedAt.toLocaleDateString()}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </AppShell>
  );
}
