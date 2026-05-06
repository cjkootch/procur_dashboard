import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  boolean,
  numeric,
  index,
  unique,
} from 'drizzle-orm/pg-core';

/**
 * Website intelligence enrichment for known_entities. Per the
 * agreed-scope from the website-metadata-layer chat thread:
 * "company intelligence enrichment", not an ML feature layer.
 * Outreach + chat dossier lift, not graph-extraction features
 * (those land in v2 only if commercial validation justifies).
 *
 * Three tables, one shared (entity_slug, source_url) audit shape:
 *   entityWebPages      — one row per crawled URL, page text in
 *                         Vercel Blob (blob_url) not Postgres
 *   entityWebFacts      — one row per LLM-extracted structured fact
 *                         with confidence + evidence text
 *   entityWebSummaries  — multi-section narrative summaries
 *
 * Confidence framing: website-extracted facts default 0.4-0.6 —
 * marketing self-presentation, not regulatory disclosure. EITI /
 * NI 43-101 / customs in fuel_consumption_signals stay at 0.85+.
 *
 * entity_slug is text (not FK) — accepts known_entities.slug or
 * external_suppliers.id (UUID). Same canonical-key shape elsewhere.
 */
export const entityWebPages = pgTable(
  'entity_web_pages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entitySlug: text('entity_slug').notNull(),
    /** Canonicalized full URL — query strings stripped to dedup. */
    url: text('url').notNull(),
    /** 'home' | 'about' | 'products' | 'services' | 'operations' |
        'assets' | 'investors' | 'sustainability' | 'contact' |
        'terminals' | 'refineries' | 'fleet' | 'projects' | 'other'. */
    pageKind: text('page_kind').notNull(),
    httpStatus: integer('http_status'),
    /** SHA-256 of extracted plain-text — drives "did this page change" check. */
    contentHash: text('content_hash'),
    textLength: integer('text_length'),
    /** Vercel Blob URL with the full extracted text. Null when crawl bailed. */
    blobUrl: text('blob_url'),
    title: text('title'),
    fetchedAt: timestamp('fetched_at').defaultNow().notNull(),
    /** False rows kept for audit so re-crawl doesn't keep retrying robots-blocked pages. */
    robotsAllowed: boolean('robots_allowed').default(true).notNull(),
    skipReason: text('skip_reason'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    slugIdx: index('entity_web_pages_slug_idx').on(table.entitySlug),
    fetchedAtIdx: index('entity_web_pages_fetched_at_idx').on(table.fetchedAt),
    uniqByUrl: unique().on(table.entitySlug, table.url),
  }),
);

export type EntityWebPage = typeof entityWebPages.$inferSelect;
export type NewEntityWebPage = typeof entityWebPages.$inferInsert;

/**
 * One row per LLM-extracted structured fact. Multiple facts of the
 * same type per entity (multiple ports, multiple products) are
 * expected. source_page_id ties back to the page for audit.
 */
export const entityWebFacts = pgTable(
  'entity_web_facts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entitySlug: text('entity_slug').notNull(),
    /** 'commercial_role' | 'product' | 'service' | 'country_served' |
        'port' | 'terminal' | 'refinery' | 'mine' | 'power_plant' |
        'contact_email' | 'contact_phone' | 'decision_maker_role' |
        'certification' | 'license' — free text, capture-as-extracted. */
    factType: text('fact_type').notNull(),
    value: text('value').notNull(),
    /** Up to 500-char evidence excerpt from the page. */
    evidenceText: text('evidence_text'),
    /** 0.0-1.0 self-assessed by Sonnet. Default mental model 0.5
        for website-sourced facts. */
    confidence: numeric('confidence', { precision: 3, scale: 2 }),
    /** ON DELETE CASCADE — when a page is re-crawled, its facts
        are wiped before the new ones land. */
    sourcePageId: uuid('source_page_id').references(() => entityWebPages.id, {
      onDelete: 'cascade',
    }),
    /** Convenience copy of source URL so chat output skips the join. */
    sourceUrl: text('source_url'),
    modelVersion: text('model_version').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    slugIdx: index('entity_web_facts_slug_idx').on(table.entitySlug),
    typeIdx: index('entity_web_facts_type_idx').on(table.factType),
  }),
);

export type EntityWebFact = typeof entityWebFacts.$inferSelect;
export type NewEntityWebFact = typeof entityWebFacts.$inferInsert;

/**
 * Multi-section narrative summaries. One row per
 * (entity, section_kind, model_version). Re-running summarization
 * with same model overwrites in place.
 */
export const entityWebSummaries = pgTable(
  'entity_web_summaries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entitySlug: text('entity_slug').notNull(),
    /** 'company_overview' | 'products_services' | 'operations' |
        'fuel_relevance' | 'crude_relevance' | 'logistics_relevance' |
        'contact_path'. */
    sectionKind: text('section_kind').notNull(),
    /** Markdown-friendly text. Capped at ~4KB at extraction time. */
    content: text('content').notNull(),
    modelVersion: text('model_version').notNull(),
    generatedAt: timestamp('generated_at').defaultNow().notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    slugIdx: index('entity_web_summaries_slug_idx').on(table.entitySlug),
    uniq: unique().on(table.entitySlug, table.sectionKind, table.modelVersion),
  }),
);

export type EntityWebSummary = typeof entityWebSummaries.$inferSelect;
export type NewEntityWebSummary = typeof entityWebSummaries.$inferInsert;
