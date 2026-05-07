import {
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Communication templates — pre-built email / SMS / WhatsApp / call
 * bodies the chat assistant references by name. Cole's vex-parity
 * request: build a library once, reuse in chat ("use the intro
 * template for Acme") with operator-supplied variables.
 *
 * Migration 0084. Distinct from `deal_structure_templates` (deal-
 * shape templates) and from Twilio Content Templates (managed in
 * Twilio; we pin via `content_sid` for whatsapp_template).
 */

export const communicationTemplateKindEnum = pgEnum(
  'communication_template_kind',
  ['email', 'sms', 'whatsapp', 'whatsapp_template', 'call'],
);

/**
 * One entry in a template's variable manifest. Drives render-time
 * validation + the chat tool's missing-variables hint.
 */
export interface CommunicationTemplateVariable {
  name: string;
  description?: string;
  required?: boolean;
  defaultValue?: string;
}

export const communicationTemplates = pgTable(
  'communication_templates',
  {
    id: text('id').primaryKey(),
    kind: communicationTemplateKindEnum('kind').notNull(),
    /** slug — unique within kind. Chat references by this. */
    name: text('name').notNull(),
    /** Free-form human-readable name shown in the settings UI. */
    displayName: text('display_name').notNull(),
    /** Email subject. NULL for sms/whatsapp/call. */
    subject: text('subject'),
    /** Body text with `{{variable}}` placeholders. */
    body: text('body').notNull(),
    /** Twilio Content Template SID for whatsapp_template kind. */
    contentSid: text('content_sid'),
    /** Variable manifest — see CommunicationTemplateVariable. */
    variables: jsonb('variables')
      .$type<CommunicationTemplateVariable[]>()
      .notNull()
      .default([]),
    description: text('description'),
    /** Stamped on every successful dispatch that referenced the
     *  template. Drives a "most-used" sort in the settings UI. */
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdBy: text('created_by'),
    /** Soft-delete. Archived templates don't show in chat lookups
     *  but are preserved for audit (touchpoints from past sends
     *  may reference the template name). */
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => ({
    kindNameUniq: uniqueIndex('communication_templates_kind_name_uniq')
      .on(t.kind, t.name)
      .where(sql`${t.archivedAt} IS NULL`),
    lastUsedIdx: index('communication_templates_last_used_idx').on(
      t.kind,
      t.lastUsedAt,
    ),
  }),
);

export type CommunicationTemplate = typeof communicationTemplates.$inferSelect;
export type NewCommunicationTemplate =
  typeof communicationTemplates.$inferInsert;

/** Stable string IDs of the kind enum — exposed so chat tools can
 *  validate without depending on drizzle. */
export const COMMUNICATION_TEMPLATE_KINDS = [
  'email',
  'sms',
  'whatsapp',
  'whatsapp_template',
  'call',
] as const;
export type CommunicationTemplateKindValue =
  (typeof COMMUNICATION_TEMPLATE_KINDS)[number];
