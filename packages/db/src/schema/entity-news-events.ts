import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  date,
  timestamp,
  jsonb,
  numeric,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { knownEntities } from './known-entities';
import { externalSuppliers } from './external-suppliers';

/**
 * Discrete public-source events relevant to a counterparty's
 * motivation to deal. Distinct from supplier_signals (which is
 * tenant-private behavioral data captured during VTC interactions)
 * — this is observation of publicly-disclosed events, shared across
 * all tenants.
 *
 * Event types (free-text vocabulary, set by ingest workers):
 *   - 'sec_filing_offtake_change'   — 10-K/10-Q/8-K offtake mentions
 *   - 'sedar_filing_offtake_change' — Canadian equivalents
 *   - 'bankruptcy_filing'           — PACER on petroleum/metals SIC
 *   - 'leadership_change'           — LinkedIn-detected role moves
 *   - 'turnaround_announced'        — refinery maintenance windows
 *   - 'sanctions_action'            — OFAC SDN updates, EU sanctions
 *   - 'press_distress_signal'       — RSS-monitored trade-press
 *
 * Linked to either a known_entity (preferred, analyst-curated) or
 * an external_supplier (when it's a public-procurement winner).
 * Both nullable: some events arrive before the entity is known, in
 * which case `sourceEntityName` lets us retroactively link once the
 * entity record gets added.
 *
 * `relevanceScore` is set by an LLM extraction step (0.0-1.0). Below
 * 0.5 = noise (mention without substantive content); above 0.8 =
 * high-signal.
 *
 * Public-domain. No tenant scoping.
 */
export const entityNewsEvents = pgTable(
  'entity_news_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    knownEntityId: uuid('known_entity_id').references(() => knownEntities.id, {
      onDelete: 'set null',
    }),
    externalSupplierId: uuid('external_supplier_id').references(
      () => externalSuppliers.id,
      { onDelete: 'set null' },
    ),

    /** Verbatim entity name from source — used for retroactive linking
        when known_entities / external_suppliers gain a new row. */
    sourceEntityName: text('source_entity_name').notNull(),
    sourceEntityCountry: text('source_entity_country'),

    eventType: text('event_type').notNull(),
    eventDate: date('event_date').notNull(),

    /** 1-2 sentence summary the LLM extracted from the source. */
    summary: text('summary').notNull(),
    /** Full source payload for re-extraction. */
    rawPayload: jsonb('raw_payload'),

    /** Source identifiers. */
    source: text('source').notNull(),
    sourceUrl: text('source_url'),
    sourceDocId: text('source_doc_id'),

    /** Set by extraction step. 0.00-1.00. */
    relevanceScore: numeric('relevance_score', { precision: 3, scale: 2 }),

    ingestedAt: timestamp('ingested_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    entityIdx: index('entity_news_events_entity_idx').on(table.knownEntityId),
    supplierIdx: index('entity_news_events_supplier_idx').on(
      table.externalSupplierId,
    ),
    eventTypeIdx: index('entity_news_events_type_idx').on(table.eventType),
    eventDateIdx: index('entity_news_events_date_idx').on(table.eventDate),
    sourceEntityNameIdx: index('entity_news_events_name_trgm_idx').using(
      'gin',
      sql`${table.sourceEntityName} gin_trgm_ops`,
    ),
    sourceDocUniqIdx: uniqueIndex('entity_news_events_source_doc_uniq').on(
      table.source,
      table.sourceDocId,
    ),
  }),
);

export type EntityNewsEvent = typeof entityNewsEvents.$inferSelect;
export type NewEntityNewsEvent = typeof entityNewsEvents.$inferInsert;
