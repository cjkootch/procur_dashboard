import { pgTable, uuid, text, timestamp, integer, boolean, jsonb } from 'drizzle-orm/pg-core';
import { opportunities } from './opportunities';

export const documents = pgTable('documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  opportunityId: uuid('opportunity_id').references(() => opportunities.id),

  documentType: text('document_type').notNull(),
  title: text('title'),
  originalUrl: text('original_url').notNull(),
  r2Key: text('r2_key'),
  r2Url: text('r2_url'),

  extractedText: text('extracted_text'),
  extractedStructure: jsonb('extracted_structure'),
  ocrApplied: boolean('ocr_applied').default(false),
  processingStatus: text('processing_status').default('pending'),
  processingError: text('processing_error'),

  pageCount: integer('page_count'),
  fileSize: integer('file_size'),
  mimeType: text('mime_type'),
  language: text('language'),

  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export type Document = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;
