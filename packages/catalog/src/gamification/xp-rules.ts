/**
 * XP rule table. The single source of truth for "how many points is
 * this verb worth + what's the user-facing reason string."
 *
 * Verb taxonomy:
 *   outreach.*       — already emitted by emitOutreachOutcome /
 *                      emitOutreachSent (packages/ai/src/executors/
 *                      outreach-evidence.ts).
 *   feedback.*       — sub-typed by feedback_events.kind (match_quality
 *                      / entity_attribute / friction / disposition /
 *                      retrospective). insertFeedbackEvent maps to the
 *                      correct sub-verb per the kind argument.
 *   mention.resolved — fires when extracted_entities.resolved_entity_slug
 *                      transitions from null → set.
 *   web_fact.*       — confirmed / rejected (UI not shipped yet; rules
 *                      land here pre-baked).
 *   signal.muted     — signal_mute_rules insert.
 *   retrospective.completed — deal_retrospectives flips to completed.
 *   kyc.*            — supplier_approvals.status transitions.
 *   quest.<key>      — Slice 2.
 *   achievement.<key>— Slice 3.
 */

export interface XpRule {
  /** Reason string surfaced in the toast. Operator-readable. */
  reason: string;
  /** Base points; multipliers are applied at award time. */
  points: number;
}

const RULES: Record<string, XpRule> = {
  // Outreach lifecycle (verbs match emitOutreachSent / emitOutreachOutcome).
  'outreach.proposed': { reason: 'Outreach drafted', points: 2 },
  'outreach.approved': { reason: 'Outreach approved', points: 5 },
  'outreach.sent': { reason: 'Outreach sent', points: 5 },
  'outreach.replied': { reason: 'Outreach replied', points: 25 },
  'outreach.meeting_booked': { reason: 'Meeting booked', points: 50 },
  'outreach.converted_to_lead': { reason: 'Converted to lead', points: 75 },
  'outreach.converted_to_deal': { reason: 'Converted to deal', points: 200 },
  'outreach.disqualified': { reason: 'Outreach disqualified', points: 10 },
  // outreach.no_response_7d intentionally omitted — auto-stamped, no reward.

  // ML training labels.
  'feedback.match_quality': { reason: 'Match feedback', points: 10 },
  'feedback.entity_attribute': { reason: 'Entity attribute corrected', points: 15 },
  'feedback.disposition': { reason: 'Deal outcome tagged', points: 20 },
  'feedback.friction': { reason: 'Friction logged', points: 10 },
  'mention.resolved': { reason: 'Mention resolved', points: 15 },
  'web_fact.confirmed': { reason: 'Web fact confirmed', points: 10 },
  'web_fact.rejected': { reason: 'Web fact corrected', points: 15 },
  'signal.muted': { reason: 'Signal muted', points: 5 },

  // Discipline / lifecycle.
  'retrospective.completed': { reason: 'Retrospective submitted', points: 100 },
  'kyc.approved_with_kyc': { reason: 'KYC approved', points: 100 },
  'kyc.approved_without_kyc': { reason: 'Supplier approved (no KYC)', points: 50 },
  'kyc.rejected': { reason: 'Supplier rejected', points: 25 },
};

/**
 * Look up the rule for a verb. Returns null when no rule exists —
 * caller (awardXp) should treat that as "no XP for this action,
 * skip the ledger write." Don't throw; new event types should be
 * silently no-rewarded until a rule lands.
 */
export function xpRuleFor(verb: string): XpRule | null {
  return RULES[verb] ?? null;
}

/** Bonus on the first XP-earning action of each calendar day. */
export const FIRST_OF_DAY_BONUS = 10;

/**
 * Streak multiplier applied to base points (excluding the first-of-
 * day bonus). 7-day streak = 1.10×, 30-day = 1.25×, otherwise 1.00×.
 */
export function streakMultiplier(currentStreakDays: number): number {
  if (currentStreakDays >= 30) return 1.25;
  if (currentStreakDays >= 7) return 1.1;
  return 1.0;
}
