import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';

/**
 * Sub-address tokens for lead-form reply attribution.
 *
 * When the autopilot (or chat-driven submit_lead_form) submits a
 * counterparty's contact form on behalf of a probe target, the form's
 * email field gets filled with a sub-addressed variant of our
 * configured sender:
 *
 *     LEAD_FORM_SENDER_EMAIL = hello@procur.app
 *     submission for (probe X, target Y) → hello+<token>@procur.app
 *
 * Recipients who reply to the form-acknowledgement email send to that
 * exact plus-addressed address. The Resend inbound webhook parses
 * the `+token` suffix from the To: header, looks up this row, and
 * attaches the probe + target context to the inbound message:
 *   - stamps messages.metadata.lead_form_attribution
 *   - upserts conversation_settings with linkedProbeId + the probe's
 *     drafter steering (formality, domainHint, language) so reply-
 *     path agents inherit the same persona as first-touch
 *
 * Without this layer, lead-form replies would land at the bare
 * sender address with no probe linkage — operator sees an
 * unattributed inbound and the AI auto-reply doesn't know which
 * probe's context to use.
 *
 * Token format: 8-char base32 (lowercase a-z + 2-7), generated at
 * submission time via random bytes. 32^8 = 1.1 trillion — collision-
 * safe for any realistic submission volume.
 *
 * Lifecycle: rows are immutable once written (audit). last_seen_at
 * gets touched on each matching inbound for activity tracking but
 * tokens are never reissued.
 *
 * Operator dependency: the receiving Resend address pattern must
 * accept the plus-addressed form (e.g. catch-all `*@procur.app` or
 * pattern listener `hello+*@procur.app`). Most modern Resend setups
 * already do; verify via the resend-inbound webhook config.
 */
export const leadFormSubmissionTokens = pgTable(
  'lead_form_submission_tokens',
  {
    /** 8-char base32 token. Used as the +<token> sub-address suffix
     *  on the form's email field. Unguessable enough that random
     *  spam to hello+xxxxxxxx@procur.app won't collide with a real
     *  submission token. */
    token: text('token').primaryKey(),

    /** market_probes.id at submission time. Operator can complete or
     *  abandon the probe later; token still resolves so late replies
     *  get correctly attributed. */
    probeId: text('probe_id').notNull(),
    /** market_probe_targets.id at submission time. Snapshot — target
     *  may be deleted later; token still resolves but the autopilot's
     *  reply-path will fall back to probe-only context if target is
     *  gone. */
    targetId: text('target_id').notNull(),
    /** known_entities.slug or external_suppliers.id — denormalized
     *  for quick joins on the inbound webhook hot path (avoids a
     *  second lookup through market_probe_targets). */
    entitySlug: text('entity_slug').notNull(),
    /** entity_contact_form_endpoints.url — denormalized for audit. */
    formUrl: text('form_url').notNull(),
    /** approvals.id of the lead_form.submit row that produced this
     *  submission. Useful for tracing back to who approved. */
    approvalId: text('approval_id').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Stamped by the inbound webhook on each matching reply.
     *  Quiet-period analytics: tokens with createdAt → lastSeenAt
     *  gaps tell us "form acknowledgement → first reply" cadence
     *  per market. NULL until the first inbound matches. */
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  },
  (table) => ({
    probeIdx: index('lead_form_submission_tokens_probe_idx').on(table.probeId),
    targetIdx: index('lead_form_submission_tokens_target_idx').on(
      table.targetId,
    ),
    entityIdx: index('lead_form_submission_tokens_entity_idx').on(
      table.entitySlug,
    ),
  }),
);

export type LeadFormSubmissionToken =
  typeof leadFormSubmissionTokens.$inferSelect;
export type NewLeadFormSubmissionToken =
  typeof leadFormSubmissionTokens.$inferInsert;
