import { pgTable, uuid, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { proposalStatusEnum } from './enums';
import { pursuits } from './pursuits';
import { users } from './users';

export const proposals = pgTable(
  'proposals',
  {
  id: uuid('id').primaryKey().defaultRandom(),
  pursuitId: uuid('pursuit_id')
    .references(() => pursuits.id)
    .notNull()
    .unique(),

  status: proposalStatusEnum('status').default('drafting').notNull(),

  outline: jsonb('outline').$type<
    Array<{
      id: string;
      number: string;
      title: string;
      description: string;
      evaluationCriteria: string[];
      pageLimit?: number;
      mandatoryContent: string[];
    }>
  >(),

  complianceMatrix: jsonb('compliance_matrix').$type<
    Array<{
      requirementId: string;
      requirementText: string;
      sourceSection: string;
      addressedInSection?: string;
      status: 'not_addressed' | 'partially_addressed' | 'fully_addressed' | 'confirmed';
      confidence: number;
      notes?: string;
    }>
  >(),

  sections: jsonb('sections').$type<
    Array<{
      id: string;
      outlineId: string;
      title: string;
      content: string;
      status: 'empty' | 'ai_drafted' | 'in_review' | 'finalized';
      assignedUserId?: string;
      wordCount: number;
      lastEditedAt: string;
    }>
  >(),

  aiReview: jsonb('ai_review').$type<{
    overallScore: number;
    overallVerdict: 'red' | 'yellow' | 'green';
    summary: string;
    strengths: string[];
    risks: Array<{ severity: 'low' | 'medium' | 'high'; text: string }>;
    sectionFeedback: Array<{
      sectionId: string;
      score: number;
      suggestions: string[];
    }>;
    generatedAt: string;
  } | null>(),

  latestWordExportR2Key: text('latest_word_export_r2_key'),
  latestWordExportUrl: text('latest_word_export_url'),
  latestPdfExportR2Key: text('latest_pdf_export_r2_key'),
  latestPdfExportUrl: text('latest_pdf_export_url'),

  submittedAt: timestamp('submitted_at'),
  submittedBy: uuid('submitted_by').references(() => users.id),
  submissionConfirmation: text('submission_confirmation'),

  /** References deal_structure_templates(slug). Set when the proposal
   *  was composed against a template from the catalog. NULL for
   *  legacy proposals (forward-only per
   *  docs/deal-structures-catalog-brief.md §10.4). */
  dealStructureTemplateSlug: text('deal_structure_template_slug'),

  /** Slugs of commission_structures that apply to this proposal —
   *  surfaced at proposal time so fee burden is visible before the
   *  contract gets signed. Empty array when no structures match. */
  applicableCommissionSlugs: text('applicable_commission_slugs')
    .array()
    .notNull()
    .default([]),

  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    pursuitUpdatedIdx: index('proposals_pursuit_updated_idx').on(
      table.pursuitId,
      table.updatedAt,
    ),
    templateSlugIdx: index('proposals_template_slug_idx').on(
      table.dealStructureTemplateSlug,
    ),
  }),
);

export type Proposal = typeof proposals.$inferSelect;
export type NewProposal = typeof proposals.$inferInsert;
