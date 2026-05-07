import { getCurrentUser } from '@procur/auth';
import { getXpProgress } from '@procur/catalog';

/**
 * Topbar gamification chip — `Lvl 7 · 4,820 XP · 🔥 12d`. Server
 * component, recomputes per render. The aggregation query is
 * sub-50ms on a single-user ledger; no caching layer.
 *
 * Hover/click reveals the popover (`<details>`/`<summary>`) with
 * the level name + progress-to-next bar + longest-streak readout.
 * Native <details> so we don't ship JS for the open/close.
 */
export async function LevelChip() {
  const user = await getCurrentUser();
  if (!user) return null;

  let progress;
  try {
    progress = await getXpProgress(user.id);
  } catch {
    return null;
  }

  const xpLabel = progress.totalXp.toLocaleString();
  const streakLabel = progress.currentStreakDays > 0
    ? `🔥 ${progress.currentStreakDays}d`
    : null;
  const pctToNext =
    progress.nextLevelMinXp != null && progress.nextLevelMinXp > progress.currentLevelMinXp
      ? Math.min(
          100,
          Math.max(
            0,
            Math.round(
              ((progress.totalXp - progress.currentLevelMinXp) /
                (progress.nextLevelMinXp - progress.currentLevelMinXp)) *
                100,
            ),
          ),
        )
      : 100;

  return (
    <details className="relative">
      <summary
        className="flex cursor-pointer list-none items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1 text-xs text-[color:var(--color-foreground)] hover:bg-[color:var(--color-muted)]/40"
        aria-label={`Level ${progress.level}, ${progress.totalXp} XP`}
      >
        <span className="font-medium">Lvl {progress.level}</span>
        <span className="text-[color:var(--color-muted-foreground)]">
          {xpLabel} XP
        </span>
        {streakLabel && (
          <span className="text-[color:var(--color-muted-foreground)]">
            {streakLabel}
          </span>
        )}
      </summary>
      <div
        className="absolute right-0 top-full z-30 mt-2 w-64 rounded-[var(--radius)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-3 text-xs shadow-lg"
      >
        <div className="mb-1 flex items-baseline justify-between">
          <span className="font-semibold">{progress.levelName}</span>
          <span className="text-[color:var(--color-muted-foreground)]">
            Lvl {progress.level}
          </span>
        </div>
        <div className="mb-2 text-[color:var(--color-muted-foreground)]">
          {progress.totalXp.toLocaleString()} XP total
        </div>
        {progress.nextLevelMinXp != null ? (
          <>
            <div className="mb-1 h-1.5 w-full overflow-hidden rounded-full bg-[color:var(--color-muted)]">
              <div
                className="h-full bg-[color:var(--color-foreground)]"
                style={{ width: `${pctToNext}%` }}
              />
            </div>
            <div className="mb-3 text-[color:var(--color-muted-foreground)]">
              {progress.xpToNextLevel?.toLocaleString()} XP to next level
            </div>
          </>
        ) : (
          <div className="mb-3 text-[color:var(--color-muted-foreground)]">
            Top level reached.
          </div>
        )}
        <div className="border-t border-[color:var(--color-border)] pt-2">
          <div className="flex items-baseline justify-between">
            <span className="text-[color:var(--color-muted-foreground)]">Current streak</span>
            <span>{progress.currentStreakDays}d</span>
          </div>
          <div className="flex items-baseline justify-between">
            <span className="text-[color:var(--color-muted-foreground)]">Best</span>
            <span>{progress.longestStreakDays}d</span>
          </div>
        </div>
      </div>
    </details>
  );
}
