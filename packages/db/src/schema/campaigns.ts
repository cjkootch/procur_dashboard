import {
  doublePrecision,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { campaignStatusEnum } from './enums';
import type { ExternalKeys } from './organizations';

/**
 * Per docs/vex-into-procur-merge-brief.md Phase 4. Marketing /
 * outbound campaign — the orchestration root. `channel` (email, sms,
 * call, whatsapp, …) and `source`/`medium` are UTM-style classifiers.
 * `external_keys` lets a campaign pin to upstream IDs (HubSpot id,
 * Resend id, etc.).
 */
export const campaigns = pgTable(
  'campaigns',
  {
    id: text('id').primaryKey(),
    channel: text('channel').notNull(),
    source: text('source'),
    medium: text('medium'),
    accountRef: text('account_ref'),
    spend: doublePrecision('spend'),
    objective: text('objective'),
    externalKeys: jsonb('external_keys')
      .$type<ExternalKeys>()
      .notNull()
      .default({}),
    status: campaignStatusEnum('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    statusIdx: index('campaigns_status_idx').on(t.status),
    channelIdx: index('campaigns_channel_idx').on(t.channel),
  }),
);

export type Campaign = typeof campaigns.$inferSelect;
export type NewCampaign = typeof campaigns.$inferInsert;
