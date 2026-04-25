/**
 * Plan-tier limits enforced in app code. Single source of truth so the
 * UI guard (capture/new), the imperative server action (capture/actions),
 * and the assistant apply path (lib/assistant/apply) can never drift.
 *
 * Eventually these should live on `companies` or a `plan_tiers` table so
 * sales can grant per-tenant overrides without a deploy. Until then this
 * file is the single seam.
 */

/** Active pursuits (anything not in a terminal stage) a free-tier company
 *  can have open at once. Hitting this cap redirects to /billing. */
export const FREE_TIER_ACTIVE_PURSUIT_CAP = 5;
