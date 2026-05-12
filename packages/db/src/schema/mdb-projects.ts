import {
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Multilateral Development Bank (MDB) project archive.
 *
 * One row per observed project across IDB / CDB / World Bank / IFC.
 * Acts as the dedup + idempotency anchor for the per-bank scrapers
 * (one ingest script per bank, all writing here). Per
 * docs/multilateral-bank-docs-brief.md §5.1.
 *
 * Source URLs:
 *   - IDB:        https://api.iadb.org/v1/projects
 *   - CDB:        https://www.caribank.org/operations/projects (HTML)
 *   - World Bank: https://search.worldbank.org/api/v3/projects
 *   - IFC:        https://www.ifc.org/projects
 */
export const mdbProjects = pgTable(
  'mdb_projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bank: text('bank').notNull(), // 'idb' | 'cdb' | 'worldbank' | 'ifc'
    /** Bank-internal project identifier (e.g. IDB's projectNumber like
     *  'JM-L1093', World Bank's project_id like 'P172332'). Unique per bank. */
    externalId: text('external_id').notNull(),
    countryCode: text('country_code').notNull(),
    projectName: text('project_name').notNull(),
    /** Bank-published sector classification (varies per bank — energy /
     *  transport / agriculture / water / financial services etc.). */
    sector: text('sector'),
    /** 'active' | 'closed' | 'cancelled' | 'pipeline'. Normalized at ingest. */
    status: text('status'),
    approvalDate: date('approval_date'),
    closingDate: date('closing_date'),
    /** Total approved financing in USD. */
    totalAmountUsd: numeric('total_amount_usd', { precision: 20, scale: 2 }),
    sourceUrl: text('source_url').notNull(),
    sourceDocUrl: text('source_doc_url'),
    pdfBlobUrl: text('pdf_blob_url'),
    pdfSha256: text('pdf_sha256'),
    pdfPageCount: integer('pdf_page_count'),
    extractionStatus: text('extraction_status').notNull().default('pending'),
    extractionAttemptedAt: timestamp('extraction_attempted_at'),
    extractionCompletedAt: timestamp('extraction_completed_at'),
    extractionError: text('extraction_error'),
    rawMetadata: jsonb('raw_metadata'),
    discoveredAt: timestamp('discovered_at').defaultNow().notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    bankExternalUniq: uniqueIndex('mdb_projects_bank_external_uniq').on(
      table.bank,
      table.externalId,
    ),
    countryStatusIdx: index('mdb_projects_country_status_idx').on(
      table.countryCode,
      table.status,
      table.approvalDate.desc(),
    ),
    bankIdx: index('mdb_projects_bank_idx').on(
      table.bank,
      table.approvalDate.desc(),
    ),
  }),
);

export type MdbProject = typeof mdbProjects.$inferSelect;
export type NewMdbProject = typeof mdbProjects.$inferInsert;

/**
 * Extracted named-entity mentions from MDB project documents.
 * Roles: 'borrower' | 'contractor' | 'supplier' | 'consultant' |
 * 'technical_advisor' | 'implementing_agency' | 'executing_agency'.
 *
 * Populated by the Day 3 LLM extractor (reuses the GAIN extraction
 * stack — same parser, same Sonnet call shape, MDB-specific Zod
 * schema + prompt). Ships empty in Day 1.
 *
 * Per docs/multilateral-bank-docs-brief.md §5.2.
 */
export const mdbEntityMentions = pgTable(
  'mdb_entity_mentions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => mdbProjects.id, { onDelete: 'cascade' }),
    companyName: text('company_name').notNull(),
    companyNameNormalized: text('company_name_normalized').notNull(),
    roles: text('roles').array().notNull(),
    /** 'energy' | 'transport' | 'water' | 'agriculture' |
     *  'financial_services' | 'health' | 'education' | etc. */
    sector: text('sector'),
    /** Awarded contract value in USD when published. NULL when the
     *  entity is named without a per-contract figure (borrower,
     *  implementing agency). */
    contractValueUsd: numeric('contract_value_usd', { precision: 20, scale: 2 }),
    contextExcerpt: text('context_excerpt').notNull(),
    sourceSection: text('source_section'),
    sourcePage: integer('source_page'),
    extractionConfidence: numeric('extraction_confidence', {
      precision: 3,
      scale: 2,
    }).notNull(),
    validatorGrade: text('validator_grade'),
    resolvedEntityId: text('resolved_entity_id'),
    resolutionConfidence: numeric('resolution_confidence', {
      precision: 3,
      scale: 2,
    }),
    resolutionMethod: text('resolution_method'),
    extractedAt: timestamp('extracted_at').defaultNow().notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    projectIdx: index('mdb_entity_mentions_project_idx').on(table.projectId),
    companyNormalizedIdx: index(
      'mdb_entity_mentions_company_normalized_idx',
    ).on(table.companyNameNormalized),
  }),
);

export type MdbEntityMention = typeof mdbEntityMentions.$inferSelect;
export type NewMdbEntityMention = typeof mdbEntityMentions.$inferInsert;
