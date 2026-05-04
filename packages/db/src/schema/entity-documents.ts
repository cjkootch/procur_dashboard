import {
  pgTable,
  uuid,
  text,
  bigint,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { companies } from './companies';
import { users } from './users';

/**
 * Per-tenant document attachments on rolodex entities.
 *
 * Distinct from the global `documents` table (which is per-
 * opportunity scraped tender content). entity_documents is
 * per-tenant private — KYC packs are sensitive; one tenant's
 * attached docs must never leak to another even if both tenants
 * have the same entity in their rolodex.
 *
 * Storage: blob_url points at Vercel Blob (same provider as tender
 * uploads). Surfaces always go through `/api/entities/[slug]/
 * documents/*` which enforces company_id scoping; the blob URL
 * itself is treated as opaque.
 *
 * `entity_slug` is text (not FK) because the entity may live in
 * `known_entities` (slug) OR `external_suppliers` (id) — the
 * unified profile resolves both.
 */
export const entityDocuments = pgTable(
  'entity_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** Per-tenant scope. Cascade on company delete. */
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),

    /** known_entities.slug or external_suppliers.id (text). */
    entitySlug: text('entity_slug').notNull(),

    filename: text('filename').notNull(),
    /** Vercel Blob public URL. Treated as opaque outside the API. */
    blobUrl: text('blob_url').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    mimeType: text('mime_type'),

    /** 'kyc' | 'msa' | 'contract' | 'datasheet' | 'price-sheet' |
     *  'compliance' | 'correspondence' | 'other'. Free text for
     *  additive evolution; validated at the route. */
    category: text('category'),

    /** Operator's description. */
    description: text('description'),

    /** Uploader. SET NULL preserves the doc when the user is
     *  offboarded — the upload still happened. */
    uploadedBy: uuid('uploaded_by').references(() => users.id, { onDelete: 'set null' }),

    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyEntityIdx: index('entity_documents_company_entity_idx').on(
      table.companyId,
      table.entitySlug,
      table.uploadedAt,
    ),
    categoryIdx: index('entity_documents_category_idx').on(
      table.companyId,
      table.category,
      table.uploadedAt,
    ),
  }),
);

/** Valid `category` values — single source of truth. The route
 *  validates against this list; future categories add here. */
export const ENTITY_DOCUMENT_CATEGORIES = [
  'kyc',
  'msa',
  'contract',
  'datasheet',
  'price-sheet',
  'compliance',
  'correspondence',
  'other',
] as const;
export type EntityDocumentCategory = (typeof ENTITY_DOCUMENT_CATEGORIES)[number];

export type EntityDocument = typeof entityDocuments.$inferSelect;
export type NewEntityDocument = typeof entityDocuments.$inferInsert;
