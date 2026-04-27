import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  numeric,
  uniqueIndex,
  index,
  customType,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { opportunityStatusEnum } from './enums';
import { jurisdictions } from './jurisdictions';
import { agencies } from './agencies';
import { companies } from './companies';
import { users } from './users';

const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector';
  },
});

export const opportunities = pgTable(
  'opportunities',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    sourceReferenceId: text('source_reference_id').notNull(),
    jurisdictionId: uuid('jurisdiction_id').references(() => jurisdictions.id),
    agencyId: uuid('agency_id').references(() => agencies.id),
    sourceUrl: text('source_url'),

    /**
     * 'scraped' = public tender ingested by a scraper (the historical default).
     * 'uploaded' = private RFP a customer uploaded via the Capture app — only
     * visible to the owning company.
     */
    source: text('source').default('scraped').notNull(),
    /**
     * Set when source='uploaded'. Null for public scraped opportunities;
     * private uploads are scoped to one tenant via this FK. Discover queries
     * filter on `companyId IS NULL` so privates never leak.
     */
    companyId: uuid('company_id').references(() => companies.id),
    uploadedByUserId: uuid('uploaded_by_user_id').references(() => users.id),

    title: text('title').notNull(),
    description: text('description'),
    referenceNumber: text('reference_number'),
    type: text('type'),

    category: text('category'),
    subCategory: text('sub_category'),
    naicsCode: text('naics_code'),
    cpvCode: text('cpv_code'),
    tags: text('tags').array(),

    valueEstimate: numeric('value_estimate', { precision: 20, scale: 2 }),
    valueMin: numeric('value_min', { precision: 20, scale: 2 }),
    valueMax: numeric('value_max', { precision: 20, scale: 2 }),
    currency: text('currency').default('USD'),
    valueEstimateUsd: numeric('value_estimate_usd', { precision: 20, scale: 2 }),

    publishedAt: timestamp('published_at'),
    deadlineAt: timestamp('deadline_at'),
    deadlineTimezone: text('deadline_timezone'),
    preBidMeetingAt: timestamp('pre_bid_meeting_at'),
    clarificationDeadlineAt: timestamp('clarification_deadline_at'),

    rawContent: jsonb('raw_content'),
    parsedContent: jsonb('parsed_content'),
    extractedRequirements: jsonb('extracted_requirements').$type<
      Array<{
        id: string;
        type: 'technical' | 'financial' | 'legal' | 'compliance' | 'experience';
        text: string;
        mandatory: boolean;
        sourceSection: string;
      }>
    >(),
    extractedCriteria: jsonb('extracted_criteria').$type<
      Array<{
        name: string;
        weight: number;
        description: string;
      }>
    >(),
    mandatoryDocuments: jsonb('mandatory_documents').$type<string[]>(),
    aiSummary: text('ai_summary'),
    aiCategoryConfidence: numeric('ai_category_confidence', { precision: 3, scale: 2 }),
    extractionConfidence: numeric('extraction_confidence', { precision: 3, scale: 2 }),

    status: opportunityStatusEnum('status').default('active').notNull(),
    awardedToCompanyName: text('awarded_to_company_name'),
    awardedAmount: numeric('awarded_amount', { precision: 20, scale: 2 }),
    awardedAt: timestamp('awarded_at'),

    language: text('language').default('en'),
    slug: text('slug').unique(),
    searchVector: tsvector('search_vector'),

    firstSeenAt: timestamp('first_seen_at').defaultNow(),
    lastSeenAt: timestamp('last_seen_at').defaultNow(),

    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    // Partial unique: only enforced for scraped rows. Uploaded rows have
    // synthetic source_reference_id values and no jurisdiction — they
    // shouldn't share a deduplication namespace with the scraped corpus.
    sourceRefIdx: uniqueIndex('opp_source_ref_idx')
      .on(table.jurisdictionId, table.sourceReferenceId)
      .where(sql`${table.source} = 'scraped'`),
    slugIdx: uniqueIndex('opp_slug_idx').on(table.slug),
    deadlineIdx: index('opp_deadline_idx').on(table.deadlineAt),
    statusIdx: index('opp_status_idx').on(table.status),
    jurisdictionStatusIdx: index('opp_jur_status_idx').on(table.jurisdictionId, table.status),
    // Capture queries scope by company; partial keeps the index small
    // since the vast majority of rows are public (company_id IS NULL).
    companyIdx: index('opp_company_id_idx')
      .on(table.companyId)
      .where(sql`${table.companyId} IS NOT NULL`),
    searchIdx: index('opp_search_idx').using('gin', table.searchVector),
  }),
);

export type Opportunity = typeof opportunities.$inferSelect;
export type NewOpportunity = typeof opportunities.$inferInsert;
