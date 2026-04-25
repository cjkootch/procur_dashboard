/**
 * Single source of truth for the magic numbers scattered across the
 * codebase that decide how Procur classifies / colors / surfaces things.
 *
 * Why centralize:
 *   - lifecycle chips (3, 14 days) appeared in 5+ places with different
 *     copy ("Due Soon" / "Closing Soon" / "due soon").
 *   - pWin tone thresholds (0.75, 0.5, 0.25) appeared in chips + the
 *     pursuit-card hero + the dashboard widget — drift between them
 *     means the same pursuit shows different colors in different views.
 *   - "next 30 days" appears in queries + AI tool descriptions; if we
 *     ever shift to 45 days, we'd miss the AI prompt.
 *
 * Numbers here should be the only place these values live.
 */

/** Lifecycle (deadline-relative) chip thresholds, in days. */
export const LIFECYCLE_DAYS = {
  /** ≤ this many days → "Due Soon" (warning, urgent). */
  dueSoon: 3,
  /** ≤ this many days → "Closing Soon" (warning, awareness). */
  closingSoon: 14,
} as const;

/** Default forward-looking window for "upcoming deadlines" queries (home,
 *  capture, AI assistant). */
export const UPCOMING_DEADLINE_WINDOW_DAYS = 30;

/** pWin (probability-of-win) → tone band thresholds. matchChip() and
 *  any other UI surface that buckets pWin should use these names so a
 *  change here propagates everywhere. */
export const P_WIN_BANDS = {
  /** ≥ this → success tone. */
  high: 0.75,
  /** ≥ this → info tone. */
  medium: 0.5,
  /** ≥ this → warning tone. Below this → neutral. */
  low: 0.25,
} as const;
