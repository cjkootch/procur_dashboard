import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

/**
 * Analyst-curated rolodex of buyers / sellers / traders relevant to
 * VTC's deal flow. DELIBERATELY SEPARATE from `external_suppliers`
 * (which is portal-scraped) so the curated/scraped distinction stays
 * clean and queries can choose which slice they want.
 *
 * The supplier-graph tables (`awards`, `award_awardees`, etc.) capture
 * what HAS HAPPENED — actual public procurement transactions. This
 * table captures what we KNOW — analyst research on relevant entities,
 * including ones we have zero public-tender visibility on (private
 * commercial refiners, trading houses, off-take counterparties).
 *
 * Lifecycle:
 *   - Rows are seeded from research and updated as deal flow evolves.
 *   - Re-running the seed script is idempotent on (slug).
 *   - When public-tender data starts surfacing the same entity, the
 *     scraper writes to `external_suppliers` independently — no
 *     auto-link in v1. Reconciliation is manual until the volume
 *     justifies a fuzzy-merge step.
 *
 * Public-domain: shared across tenants in v1. If/when private deal
 * notes start landing here, add `companyId NOT NULL` + tenant scoping
 * — same path supplier_signals will need to take.
 */
export const knownEntities = pgTable(
  'known_entities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Stable url-safe identifier — used for re-seed idempotency. */
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    /** ISO-3166-1 alpha-2. For multinationals, the headquarters / primary registration. */
    country: text('country').notNull(),

    /** 'buyer' | 'seller' | 'trader' | 'producer' | 'refiner'. Free-text
        because real entities often play multiple roles (e.g., a national
        oil company that's both producer + buyer for downstream needs). */
    role: text('role').notNull(),

    /** Free-text array of category tags (mirrors awards.category_tags
        vocabulary): 'crude-oil', 'diesel', 'jet-fuel', 'food-commodities', etc. */
    categories: text('categories').array().notNull(),

    /** Multi-paragraph analyst notes — capability, recent activity,
        outreach angle. Markdown-friendly. */
    notes: text('notes'),

    /** Outreach contact: name + role + email/phone, if known. */
    contactEntity: text('contact_entity'),

    /** Aliases the entity goes by across portals + trade press, used
        to support fuzzy match if/when the supplier-graph layer wants
        to reconcile a scraped row against a curated one. */
    aliases: text('aliases').array(),

    /** Free-form tags for downstream filtering: 'mediterranean-refiner',
        'sweet-crude-runner', 'trading-house', 'state-refiner'. */
    tags: text('tags').array(),

    /** Open metadata bucket — where the analyst pulled the data from,
        last review date, deal-specific flags, etc. */
    metadata: jsonb('metadata'),

    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    countryIdx: index('known_entities_country_idx').on(table.country),
    roleIdx: index('known_entities_role_idx').on(table.role),
    categoriesIdx: index('known_entities_categories_idx').using('gin', table.categories),
    tagsIdx: index('known_entities_tags_idx').using('gin', table.tags),
  }),
);

export type KnownEntity = typeof knownEntities.$inferSelect;
export type NewKnownEntity = typeof knownEntities.$inferInsert;
