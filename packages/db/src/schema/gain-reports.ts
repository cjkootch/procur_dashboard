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
 * USDA FAS GAIN reports — catalog of every observed report regardless
 * of extraction status. Acts as the dedup + idempotency anchor for the
 * scraper. Per docs/gain-extraction-brief.md §5.1.
 *
 * Source: https://gain.fas.usda.gov/ (search API + direct download)
 */
export const gainReports = pgTable(
  'gain_reports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** USDA's internal report ID (e.g. 'VE2025-0008'). May be null when
     *  the search API result doesn't expose one cleanly. */
    reportId: text('report_id'),
    countryCode: text('country_code').notNull(),
    postCity: text('post_city'),
    /** Normalized report type — 'Exporter Guide' | 'Retail Foods' |
     *  'Grain and Feed Annual' | etc. Filtered at scraper level
     *  to high-yield types only. */
    reportType: text('report_type').notNull(),
    title: text('title').notNull(),
    publicationDate: date('publication_date'),
    /** The URL-encoded filename component (e.g.
     *  'Venezuela+Agricultural+Imports+Grow+9+Percent_Caracas_Venezuela_VE2025-0008').
     *  Unique key — primary dedup signal. */
    sourceFilename: text('source_filename').notNull(),
    sourceUrl: text('source_url').notNull(),
    /** Vercel Blob URL of the cached PDF; null when BLOB_READ_WRITE_TOKEN
     *  isn't configured or upload failed. The PDF can always be
     *  re-downloaded from sourceUrl. */
    pdfBlobUrl: text('pdf_blob_url'),
    pdfSha256: text('pdf_sha256'),
    pdfPageCount: integer('pdf_page_count'),
    /** 'pending' until the Day 3 LLM extractor runs; then 'extracted'
     *  | 'failed' | 'skipped'. */
    extractionStatus: text('extraction_status').notNull().default('pending'),
    extractionAttemptedAt: timestamp('extraction_attempted_at'),
    extractionCompletedAt: timestamp('extraction_completed_at'),
    extractionError: text('extraction_error'),
    rawMetadata: jsonb('raw_metadata'),
    discoveredAt: timestamp('discovered_at').defaultNow().notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    sourceFilenameUniq: uniqueIndex('gain_reports_source_filename_uniq').on(
      table.sourceFilename,
    ),
    countryDateIdx: index('gain_reports_country_date_idx').on(
      table.countryCode,
      table.publicationDate.desc(),
    ),
  }),
);

export type GainReport = typeof gainReports.$inferSelect;
export type NewGainReport = typeof gainReports.$inferInsert;

/**
 * Extracted named-importer mentions from GAIN reports. One row per
 * (report, company) — within-report dedup happens at extraction time;
 * across-report mentions are preserved (a company referenced in 5
 * reports across 4 years is structurally important, the multi-mention
 * pattern IS the signal). Per docs/gain-extraction-brief.md §5.2.
 *
 * Populated by the Day 3 LLM extractor. This table ships empty in Day 1.
 */
export const gainImporterMentions = pgTable(
  'gain_importer_mentions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reportId: uuid('report_id')
      .notNull()
      .references(() => gainReports.id, { onDelete: 'cascade' }),
    companyName: text('company_name').notNull(),
    /** Lowercase, suffix-stripped name for resolver matching. */
    companyNameNormalized: text('company_name_normalized').notNull(),
    /** ['importer' | 'distributor' | 'wholesaler' | 'retailer' |
     *   'food_service' | 'miller' | 'refiner' | 'integrator' | ...] */
    roles: text('roles').array().notNull(),
    /** HS-aligned controlled vocabulary — 'wheat' | 'soybean_oil' |
     *  'sugar' | 'beef' | etc. */
    commodityCategories: text('commodity_categories').array().notNull(),
    /** 'dominant' | 'major' | 'emerging' | 'declining' | 'unknown' */
    marketPosition: text('market_position'),
    supplyPreferences: text('supply_preferences').array(),
    contextExcerpt: text('context_excerpt').notNull(),
    sourceSection: text('source_section'),
    sourcePage: integer('source_page'),
    /** LLM self-rated 0-1 on whether this is a genuine commercial
     *  counterparty mention vs. a passing reference. */
    extractionConfidence: numeric('extraction_confidence', {
      precision: 3,
      scale: 2,
    }).notNull(),
    /** 'confirmed' | 'flagged' | 'rejected' | null. Filled by the
     *  validator second-pass sampler. */
    validatorGrade: text('validator_grade'),
    /** FK to known_entities.id when resolved. Polymorphic-friendly
     *  text shape mirrors fuel_consumption_signals + supplier_approvals
     *  convention; the resolver can target either canonical entities or
     *  external_suppliers stubs. */
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
    reportIdx: index('gain_importer_mentions_report_idx').on(table.reportId),
    companyNormalizedIdx: index(
      'gain_importer_mentions_company_normalized_idx',
    ).on(table.companyNameNormalized),
  }),
);

export type GainImporterMention = typeof gainImporterMentions.$inferSelect;
export type NewGainImporterMention = typeof gainImporterMentions.$inferInsert;
