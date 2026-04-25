import { pgTable, uuid, text, timestamp, numeric, integer, index } from 'drizzle-orm/pg-core';
import { pursuits } from './pursuits';

/**
 * Teaming partners for a pursuit (prime, subs, mentors, JV partners).
 *
 * Stored as free-text partner names rather than FKs to a partner-companies
 * table — most teaming relationships are with external firms we won't have
 * profiles for, and forcing pre-creation slows the capture flow. We can
 * normalize to a real partners table later (and link via partnerCompanyId)
 * once the partner CRM exists.
 */

export type TeamRole = 'prime' | 'subcontractor' | 'mentor' | 'joint_venture' | 'consultant';

export type TeamingStatus =
  | 'engaging'
  | 'nda_signed'
  | 'teaming_agreement'
  | 'executed'
  | 'declined';

export const TEAM_ROLES: TeamRole[] = [
  'prime',
  'subcontractor',
  'mentor',
  'joint_venture',
  'consultant',
];

export const TEAMING_STATUSES: TeamingStatus[] = [
  'engaging',
  'nda_signed',
  'teaming_agreement',
  'executed',
  'declined',
];

export const pursuitTeamMembers = pgTable(
  'pursuit_team_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    pursuitId: uuid('pursuit_id')
      .references(() => pursuits.id, { onDelete: 'cascade' })
      .notNull(),

    partnerName: text('partner_name').notNull(),
    role: text('role').$type<TeamRole>().notNull().default('subcontractor'),
    status: text('status').$type<TeamingStatus>().notNull().default('engaging'),

    /** % of total contract value (0..100). Optional — many teaming arrangements
        are scoped by capability, not dollars. */
    allocationPct: numeric('allocation_pct', { precision: 5, scale: 2 }),

    /** Free-text capabilities or scope this partner brings. */
    capabilities: text('capabilities'),

    contactName: text('contact_name'),
    contactEmail: text('contact_email'),
    notes: text('notes'),

    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    pursuitIdx: index('pursuit_team_members_pursuit_idx').on(table.pursuitId),
  }),
);

export type PursuitTeamMember = typeof pursuitTeamMembers.$inferSelect;
export type NewPursuitTeamMember = typeof pursuitTeamMembers.$inferInsert;
