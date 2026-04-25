import { pgTable, uuid, text, timestamp, integer, boolean, index } from 'drizzle-orm/pg-core';
import { proposals } from './proposals';
import { documents } from './documents';

/**
 * Sentence-level compliance shred extracted from an RFP. Each row is
 * one sentence (or short clause) classified by its compliance language
 * (shall / will / must / should / may / none) and tagged with the
 * outline section it lives under.
 *
 * The shred drives the compliance matrix: every "shall" / "must"
 * sentence is a mandatory requirement, and the `accountedFor` flag
 * tracks whether the proposal addresses it.
 *
 * Why a flat row table (not nested in proposal.outline JSONB):
 *   - Bulk-classified by Claude one section at a time → fast inserts
 *   - Filterable by type / accountedFor without JSONB scans
 *   - Per-row audit (who toggled accountedFor, when) is feasible later
 *   - Unbounded sentence count won't bloat one row
 */

export type ShredType = 'shall' | 'will' | 'must' | 'should' | 'may' | 'none';

export const SHRED_TYPES: ShredType[] = ['shall', 'will', 'must', 'should', 'may', 'none'];

export const proposalShreds = pgTable(
  'proposal_shreds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    proposalId: uuid('proposal_id')
      .references(() => proposals.id, { onDelete: 'cascade' })
      .notNull(),

    /** Outline section path, e.g. "1.1.3" or "Volume I / 1.1.3". Free-text
        so we can mirror whatever the RFP uses. */
    sectionPath: text('section_path').notNull().default(''),
    sectionTitle: text('section_title'),

    sentenceText: text('sentence_text').notNull(),
    shredType: text('shred_type').$type<ShredType>().notNull().default('none'),

    accountedFor: boolean('accounted_for').notNull().default(false),

    /** Free-text reference to the proposal section that addresses this shred
        (e.g. outline section number). Not a FK because outline IDs live in
        the proposal.outline JSONB; this is the GovDash convention. */
    addressedInSection: text('addressed_in_section'),

    /** Source document this shred was extracted from. Optional — manual
        rows have no source. */
    sourceDocumentId: uuid('source_document_id').references(() => documents.id, {
      onDelete: 'set null',
    }),
    sourcePage: integer('source_page'),

    notes: text('notes'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    proposalIdx: index('proposal_shreds_proposal_idx').on(table.proposalId),
    proposalSectionIdx: index('proposal_shreds_proposal_section_idx').on(
      table.proposalId,
      table.sectionPath,
    ),
    proposalSortIdx: index('proposal_shreds_proposal_sort_idx').on(
      table.proposalId,
      table.sortOrder,
    ),
  }),
);

export type ProposalShred = typeof proposalShreds.$inferSelect;
export type NewProposalShred = typeof proposalShreds.$inferInsert;
