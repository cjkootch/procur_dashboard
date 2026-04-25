import { pgTable, uuid, text, timestamp, integer, index } from 'drizzle-orm/pg-core';
import { companies } from './companies';
import { pursuits } from './pursuits';

/**
 * Reusable bank of capabilities for the company. Edited once, referenced
 * across pursuits when building the capability matrix. Categories help
 * group capabilities in the UI but are free-form so teams can add new
 * categories without a migration.
 *
 * Suggested categories: 'service', 'certification', 'technology',
 * 'geography', 'personnel', 'past_performance'.
 */

export type CapabilityCategory =
  | 'service'
  | 'certification'
  | 'technology'
  | 'geography'
  | 'personnel'
  | 'past_performance'
  | 'other';

export const CAPABILITY_CATEGORIES: CapabilityCategory[] = [
  'service',
  'certification',
  'technology',
  'geography',
  'personnel',
  'past_performance',
  'other',
];

export const companyCapabilities = pgTable(
  'company_capabilities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .references(() => companies.id, { onDelete: 'cascade' })
      .notNull(),

    name: text('name').notNull(),
    category: text('category').$type<CapabilityCategory>().notNull().default('service'),
    description: text('description'),
    /** Optional URL — link to a case study, certification PDF, etc. */
    evidenceUrl: text('evidence_url'),

    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    companyIdx: index('company_capabilities_company_idx').on(table.companyId),
  }),
);

export type CompanyCapability = typeof companyCapabilities.$inferSelect;
export type NewCompanyCapability = typeof companyCapabilities.$inferInsert;

/**
 * Per-pursuit row in the capability matrix. Each row is a requirement
 * extracted from the RFP (mandatory or nice-to-have), mapped to one of
 * the company's capabilities (or unmapped → gap), with a coverage
 * status driving the roll-up + teaming decisions.
 */

export type RequirementPriority = 'must' | 'should' | 'nice';
export type CoverageStatus = 'covered' | 'partial' | 'gap' | 'not_assessed';

export const REQUIREMENT_PRIORITIES: RequirementPriority[] = ['must', 'should', 'nice'];
export const COVERAGE_STATUSES: CoverageStatus[] = [
  'not_assessed',
  'covered',
  'partial',
  'gap',
];

export const pursuitCapabilityRequirements = pgTable(
  'pursuit_capability_requirements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    pursuitId: uuid('pursuit_id')
      .references(() => pursuits.id, { onDelete: 'cascade' })
      .notNull(),

    requirement: text('requirement').notNull(),
    priority: text('priority').$type<RequirementPriority>().notNull().default('must'),
    coverage: text('coverage').$type<CoverageStatus>().notNull().default('not_assessed'),

    /** Nullable — a gap row exists before any capability is mapped. */
    capabilityId: uuid('capability_id').references(() => companyCapabilities.id, {
      onDelete: 'set null',
    }),

    notes: text('notes'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    pursuitIdx: index('pursuit_capability_requirements_pursuit_idx').on(table.pursuitId),
  }),
);

export type PursuitCapabilityRequirement = typeof pursuitCapabilityRequirements.$inferSelect;
export type NewPursuitCapabilityRequirement = typeof pursuitCapabilityRequirements.$inferInsert;
