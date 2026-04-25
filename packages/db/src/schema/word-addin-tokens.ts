import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';
import { companies } from './companies';
import { users } from './users';

/**
 * Long-lived API tokens for the Microsoft Word add-in. The add-in
 * task pane runs outside the Clerk session, so the user pastes a token
 * once after sideloading the manifest; the token is stored locally in
 * Office's settings cache and used as a Bearer token on every API call.
 *
 * Storage strategy: hash-only at rest (sha-256 of the secret half),
 * plus a 4-char prefix so the user can identify which token they're
 * looking at on the management page. The full token is shown once at
 * creation time and never again — same UX pattern as Stripe / GitHub
 * personal access tokens.
 *
 * Token format: prc_word_<32 random url-safe chars>. The "prc_word_"
 * prefix lets us scope tokens by surface later (Excel add-in, Slack
 * bot, etc.) without rotating this schema.
 */

export const wordAddinTokens = pgTable(
  'word_addin_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .references(() => companies.id, { onDelete: 'cascade' })
      .notNull(),
    userId: uuid('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),

    /** Friendly label set by the user — e.g. "My laptop" / "Office desktop". */
    label: text('label').notNull().default('Word add-in'),

    /** sha-256(token) hex. Never the raw token. */
    tokenHash: text('token_hash').notNull().unique(),
    /** First 4 chars of the secret part for display (e.g. "k3p9"). */
    tokenPrefix: text('token_prefix').notNull(),

    createdAt: timestamp('created_at').defaultNow().notNull(),
    lastUsedAt: timestamp('last_used_at'),
    revokedAt: timestamp('revoked_at'),
  },
  (table) => ({
    companyIdx: index('word_addin_tokens_company_idx').on(table.companyId),
    userIdx: index('word_addin_tokens_user_idx').on(table.userId),
  }),
);

export type WordAddinToken = typeof wordAddinTokens.$inferSelect;
export type NewWordAddinToken = typeof wordAddinTokens.$inferInsert;
