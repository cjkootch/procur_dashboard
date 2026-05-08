import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  numeric,
  bigint,
  integer,
  date,
  index,
  boolean,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

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

    /** Compartmentalization tags stamped at probe-discovery time
     *  (migration 0108 added as text; migration 0110 widened to
     *  text[] so cross-domain rediscovery + concurrent races
     *  accumulate rather than first-write-wins). Identifies the
     *  domain(s) of probes that have discovered this entity:
     *    NULL              — hand-curated / fuel-era. Gold rolodex.
     *                        Operator promotion (set back to NULL)
     *                        is sticky — subsequent rediscovery does
     *                        NOT re-stamp.
     *    []                — never used; treated as null for
     *                        filter purposes.
     *    ['fuel_supply']   — discovered by one probe domain
     *    ['fuel_supply',
     *     'ma_matchmaking'] — discovered by multiple probes in
     *                         different domains (rare but the right
     *                         model — both probes get visibility
     *                         into their own discovered targets)
     *
     *  Filterable via lookupKnownEntities — fuel-side chat tools
     *  default to discovery_domain IS NULL OR 'fuel_supply' = ANY(...)
     *  so M&A probe stubs don't surface as fuel-procurement
     *  candidates. The race condition that motivated text→text[]:
     *  two probes in different domains concurrently discovering the
     *  same Apollo org — first INSERT wins by unique constraint;
     *  loser's catch path now appends to the existing array rather
     *  than silently losing its domain stamp. */
    discoveryDomain: text('discovery_domain').array(),

    /** Open metadata bucket — where the analyst pulled the data from,
        last review date, deal-specific flags, etc. */
    metadata: jsonb('metadata'),

    /** Latitude / longitude in WGS84 decimal degrees. Populated for
        physical-asset entities (refineries, terminals, ports) — null
        for entities with no canonical location (multinational trading
        houses headquartered everywhere, etc.). Stored as numeric so
        precision is preserved through serialization round-trips. */
    latitude: numeric('latitude', { precision: 9, scale: 6 }),
    longitude: numeric('longitude', { precision: 9, scale: 6 }),

    /** Identity key for external corporate-data APIs (Apollo, Clearbit,
        OpenCorporates, Sayari). Not Apollo-specific — adding it once
        keeps future enrichment surfaces API-agnostic. NULL for
        entities without a canonical web presence (ministries, individual
        brokers). */
    primaryDomain: text('primary_domain'),

    // ─── Apollo.io enrichment cache (per apollo-integration-brief.md) ─

    /** Apollo's stable org ID, populated by enrichOrgsBatch on first
        domain match. NULL while unmatched or when Apollo has no record. */
    apolloOrgId: text('apollo_org_id'),
    /** When this entity's Apollo data was last refreshed. Drives
        the on-demand single-get freshness check (default 30 days). */
    apolloSyncedAt: timestamp('apollo_synced_at'),
    /** Surfaced in rolodex chip + entity profile. e.g.
        'Series D', 'Series A', 'Public', 'Private Equity'. */
    apolloFundingStage: text('apollo_funding_stage'),
    /** Cumulative funding across all rounds, USD. Sortable in rolodex. */
    apolloTotalFunding: bigint('apollo_total_funding', { mode: 'number' }),
    /** Date of most recent funding event. Sortable; powers the
        "who has fresh capital" workflow. */
    apolloLatestFundingAt: date('apollo_latest_funding_at'),
    apolloEstimatedEmployees: integer('apollo_estimated_employees'),
    apolloAnnualRevenue: bigint('apollo_annual_revenue', { mode: 'number' }),
    /** Wide / rarely-queried Apollo fields: 24-month
        employee_metrics by department, current_technologies stack,
        per-round funding_events, keywords, short_description.
        Lives in jsonb because none of these are filtered on; rendering
        is the only access pattern. */
    apolloSnapshot: jsonb('apollo_snapshot'),

    /** Phase 2G safety net (migration 0100). When true, all probe
     *  target-discovery paths skip this entity — strategic
     *  relationships, sensitive counterparties, manual-only entities.
     *  Operator opts in per entity from the entity profile. */
    scoutProtection: boolean('scout_protection').notNull().default(false),

    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    countryIdx: index('known_entities_country_idx').on(table.country),
    roleIdx: index('known_entities_role_idx').on(table.role),
    categoriesIdx: index('known_entities_categories_idx').using('gin', table.categories),
    tagsIdx: index('known_entities_tags_idx').using('gin', table.tags),
    discoveryDomainIdx: index('known_entities_discovery_domain_idx')
      .using('gin', table.discoveryDomain),
    primaryDomainIdx: index('known_entities_primary_domain_idx').on(table.primaryDomain),
    apolloOrgIdIdx: index('known_entities_apollo_org_id_idx').on(table.apolloOrgId),
    apolloFundingStageIdx: index('known_entities_apollo_funding_stage_idx').on(
      table.apolloFundingStage,
    ),
    apolloLatestFundingAtIdx: index('known_entities_apollo_latest_funding_at_idx').on(
      table.apolloLatestFundingAt,
    ),
  }),
);

export type KnownEntity = typeof knownEntities.$inferSelect;
export type NewKnownEntity = typeof knownEntities.$inferInsert;
