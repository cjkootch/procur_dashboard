import {
  doublePrecision,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { recordStatusEnum } from './enums';
import { organizations } from './organizations';
import type { ExternalKeys, FieldConfidenceMap } from './organizations';

/**
 * Per docs/vex-into-procur-merge-brief.md Phase 1. New table —
 * procur had no contacts model before. Per-person CRM record with
 * email + phone arrays, role scoring, language hint, and merge
 * tombstones. The legacy `org_id` denormalised pointer mirrors the
 * primary `contact_org_memberships` row for back-compat readers.
 */
export const contacts = pgTable(
  'contacts',
  {
    id: text('id').primaryKey(),
    /** Denormalised pointer to the contact's primary org. Kept in
     *  sync with the primary `contact_org_memberships` row; readers
     *  should prefer the memberships table when m:n matters. */
    orgId: text('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    fullName: text('full_name').notNull(),
    title: text('title'),
    emails: jsonb('emails').$type<string[]>().notNull().default([]),
    phones: jsonb('phones').$type<string[]>().notNull().default([]),
    roleScore: doublePrecision('role_score'),
    externalKeys: jsonb('external_keys')
      .$type<ExternalKeys>()
      .notNull()
      .default({}),
    fieldConfidence: jsonb('field_confidence')
      .$type<FieldConfidenceMap>()
      .notNull()
      .default({}),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    status: recordStatusEnum('status').notNull().default('active'),
    /** Tombstone — when set, this contact was merged into the
     *  referenced one and `status` flipped to 'archived'. */
    mergedIntoContactId: text('merged_into_contact_id'),
    timezone: text('timezone'),
    /** ISO 639-1 — defaults email drafts to recipient's language. */
    primaryLanguage: text('primary_language'),
    optOutAt: timestamp('opt_out_at', { withTimezone: true }),
    optOutReason: text('opt_out_reason'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    orgIdx: index('contacts_org_idx').on(t.orgId),
    statusIdx: index('contacts_status_idx').on(t.status),
    mergedIntoIdx: index('contacts_merged_into_idx').on(t.mergedIntoContactId),
    emailsGinIdx: index('contacts_emails_gin_idx').using('gin', t.emails),
    phonesGinIdx: index('contacts_phones_gin_idx').using('gin', t.phones),
    externalKeysGinIdx: index('contacts_external_keys_gin_idx').using(
      'gin',
      t.externalKeys,
    ),
  }),
);

export type Contact = typeof contacts.$inferSelect;
export type NewContact = typeof contacts.$inferInsert;
