# Supplier Graph + Reverse Search — Claude Code Brief

**Status:** spec, not yet implemented
**Owner:** Cole
**Last updated:** 2026-04-28

---

## 1. What we're building, in one paragraph

A supplier intelligence layer on top of `procur_dashboard` that records who has won which public tenders globally, enriches those suppliers with capability metadata, and exposes a reverse-search API. The reverse search answers: *"A trusted broker tells me a 1M-bbl Azeri Light cargo is loading Batumi in June, CIF ASWP — who in our database has bought light sweet crude in the last 5 years and is plausibly a buyer for this cargo?"* Same query template runs for diesel, jet fuel, food commodities, vehicles. Every supplier offer that crosses VTC's desk runs this query.

This is the "supplier graph" (Layer 2 + Layer 3) that the strategic frame calls the moat. The buy-side workflow (find tender → find past winners → send RFQ) and the sell-side workflow (find supplier offer → find past buyers → send pitch) **share the same data spine**. Build the spine once.

---

## 2. Why this lives inside `procur_dashboard` (not a separate repo)

Until VTC has proven the model with one real deal, the supplier-graph and the tender-discovery layer are the same product. Splitting them creates premature complexity. Migration path: if/when this becomes a sellable standalone product, fork it into its own service — the cost of separating later is low; the cost of starting separate is high.

Concretely:

- **Reuse:** `jurisdictions`, `agencies`, `opportunities`, `external_suppliers`, the assistant, the auth layer, the scraper framework. None of these need a fork.
- **New:** four schema files (`awards.ts`, `award_awardees.ts`, `supplier_aliases.ts`, `supplier_signals.ts`), one materialized view, one route, one query module, one assistant tool.

---

## 3. Naming reminder — read before writing any code

The existing `companies` table is **Procur tenants** (paying customers / Clerk orgs), not suppliers. Do not collide with it.

The existing `external_suppliers` table holds public supplier-registry rows scraped from government portals (e.g. GOJEP supplier registry). It's the start of the supplier graph, but it's *registry data* — companies registered to bid — not award data.

Naming convention for everything new in this brief:

| Concept | Table name | Notes |
|---|---|---|
| Supplier graph nodes | `external_suppliers` | already exists, reuse |
| Per-portal name variants for fuzzy matching | `supplier_aliases` | NEW |
| Public tender awards | `awards` | NEW |
| Award ↔ supplier link (M2M for consortia) | `award_awardees` | NEW |
| Per-supplier behavioral signals (RFQ responsiveness, etc) | `supplier_signals` | NEW |
| Per-supplier capability roll-up | `supplier_capability_summary` | NEW (materialized view) |

---

## 4. Schema

Add four new files under `packages/db/src/schema/`. Drizzle, snake_case, one file per domain. Match the surrounding code style.

### 4.1 `packages/db/src/schema/awards.ts`

```ts
import {
  pgTable,
  uuid,
  text,
  timestamp,
  numeric,
  date,
  jsonb,
  integer,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { jurisdictions } from './jurisdictions';
import { agencies } from './agencies';
import { opportunities } from './opportunities';

/**
 * Public tender awards — backward-looking record of who has won what.
 * One row per (source_portal, source_award_id). For multi-supplier
 * consortium awards, see award_awardees.
 *
 * Distinct from `opportunities` (forward-looking solicitations) and
 * `external_suppliers` (registry of orgs registered to bid). Awards
 * close the loop between those two by recording the realized winner.
 *
 * UNSPSC, CPV, and NAICS classification codes are stored as text
 * arrays so a single award can carry multiple codes (common when an
 * award covers multiple line items).
 */
export const awards = pgTable(
  'awards',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // ─── Source ──────────────────────────────────────────────────
    sourcePortal: text('source_portal').notNull(),       // 'gojep', 'dr_dgcp_ocds', 'sam_gov', 'ungm', etc.
    sourceAwardId: text('source_award_id').notNull(),    // portal's native award id
    sourceUrl: text('source_url'),
    sourceUrlArchived: text('source_url_archived'),       // wayback / R2 snapshot
    rawPayload: jsonb('raw_payload'),                     // full scraped record for re-parsing

    // ─── Linkage ─────────────────────────────────────────────────
    jurisdictionId: uuid('jurisdiction_id').references(() => jurisdictions.id),
    agencyId: uuid('agency_id').references(() => agencies.id),
    opportunityId: uuid('opportunity_id').references(() => opportunities.id),

    // ─── Buyer ───────────────────────────────────────────────────
    buyerName: text('buyer_name').notNull(),              // verbatim from source
    buyerCountry: text('buyer_country').notNull(),        // ISO 3166-1 alpha-2 (validated app-side)
    beneficiaryCountry: text('beneficiary_country'),      // mirrors opportunities.beneficiary_country

    // ─── Object ──────────────────────────────────────────────────
    title: text('title'),
    commodityDescription: text('commodity_description'),
    unspscCodes: text('unspsc_codes').array(),            // GIN-indexed
    cpvCodes: text('cpv_codes').array(),
    naicsCodes: text('naics_codes').array(),
    /**
     * Internal taxonomy mapping for fast filtering. Free-text array
     * matching values like 'petroleum-fuels', 'food-commodities',
     * 'vehicles', 'aviation-fuels', 'crude-oil', etc. Set by an
     * enrichment step (LLM classification or rules) at ingest time.
     */
    categoryTags: text('category_tags').array(),

    // ─── Money & timing ──────────────────────────────────────────
    contractValueNative: numeric('contract_value_native', { precision: 20, scale: 2 }),
    contractCurrency: text('contract_currency'),           // 'USD', 'DOP', 'JMD', etc.
    contractValueUsd: numeric('contract_value_usd', { precision: 20, scale: 2 }),  // converted at award_date FX
    contractDurationMonths: integer('contract_duration_months'),

    awardDate: date('award_date').notNull(),
    performanceStart: date('performance_start'),
    performanceEnd: date('performance_end'),

    // ─── Lifecycle ───────────────────────────────────────────────
    status: text('status').default('active').notNull(),    // active | terminated | expired | unknown
    scrapedAt: timestamp('scraped_at').defaultNow().notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    sourceUniq: uniqueIndex('awards_source_uniq_idx').on(
      table.sourcePortal,
      table.sourceAwardId,
    ),
    buyerCountryIdx: index('awards_buyer_country_idx').on(table.buyerCountry),
    beneficiaryCountryIdx: index('awards_beneficiary_country_idx')
      .on(table.beneficiaryCountry)
      .where(sql`${table.beneficiaryCountry} IS NOT NULL`),
    awardDateIdx: index('awards_award_date_idx').on(table.awardDate),
    valueUsdIdx: index('awards_value_usd_idx')
      .on(table.contractValueUsd)
      .where(sql`${table.contractValueUsd} IS NOT NULL`),
    unspscIdx: index('awards_unspsc_idx').using('gin', table.unspscCodes),
    cpvIdx: index('awards_cpv_idx').using('gin', table.cpvCodes),
    categoryTagsIdx: index('awards_category_tags_idx').using('gin', table.categoryTags),
    descriptionTrgmIdx: index('awards_description_trgm_idx').using(
      'gin',
      sql`${table.commodityDescription} gin_trgm_ops`,
    ),
  }),
);

export type Award = typeof awards.$inferSelect;
export type NewAward = typeof awards.$inferInsert;
```

### 4.2 `packages/db/src/schema/award-awardees.ts`

```ts
import { pgTable, uuid, text, numeric, timestamp, primaryKey, index } from 'drizzle-orm/pg-core';
import { awards } from './awards';
import { externalSuppliers } from './external-suppliers';

/**
 * Many-to-many link between awards and the suppliers who won them.
 * Most awards have one supplier, but consortia and joint ventures
 * are common in larger procurement (~5-10% of awards). Storing this
 * flat avoids losing consortium structure to a single-FK design.
 *
 * Composite primary key on (award_id, supplier_id). Role and share
 * are per-link (not per-supplier).
 */
export const awardAwardees = pgTable(
  'award_awardees',
  {
    awardId: uuid('award_id')
      .references(() => awards.id, { onDelete: 'cascade' })
      .notNull(),
    supplierId: uuid('supplier_id')
      .references(() => externalSuppliers.id, { onDelete: 'cascade' })
      .notNull(),

    /** 'prime' | 'subcontractor' | 'consortium_member' | 'consortium_lead' */
    role: text('role').default('prime').notNull(),

    /** % of total contract value (0..100). Optional — many awards
        don't disclose the consortium share. */
    sharePct: numeric('share_pct', { precision: 5, scale: 2 }),

    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.awardId, table.supplierId] }),
    supplierIdx: index('award_awardees_supplier_idx').on(table.supplierId),
  }),
);

export type AwardAwardee = typeof awardAwardees.$inferSelect;
export type NewAwardAwardee = typeof awardAwardees.$inferInsert;
```

### 4.3 `packages/db/src/schema/supplier-aliases.ts`

```ts
import { pgTable, uuid, text, numeric, boolean, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { externalSuppliers } from './external-suppliers';

/**
 * Per-portal name variants that all map to a single canonical
 * supplier. Necessary because the same supplier appears across 10+
 * portals with 10+ spelling variants ("Vitol SA" / "VITOL S.A." /
 * "Vitol Group" / etc). Without this table, dedup happens at insert
 * time with no audit trail and no way to undo bad merges.
 *
 * `alias_normalized` is lowercased + suffix-stripped + whitespace-
 * collapsed. The trigram index supports fuzzy match queries during
 * the merge process.
 */
export const supplierAliases = pgTable(
  'supplier_aliases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    supplierId: uuid('supplier_id')
      .references(() => externalSuppliers.id, { onDelete: 'cascade' })
      .notNull(),

    alias: text('alias').notNull(),
    aliasNormalized: text('alias_normalized').notNull(),

    sourcePortal: text('source_portal'),
    /** 0.00..1.00 — match score when this alias was linked to the canonical
        supplier. Set to 1.0 for human-verified merges. */
    confidence: numeric('confidence', { precision: 3, scale: 2 }),
    verified: boolean('verified').default(false).notNull(),

    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    aliasNormalizedIdx: index('supplier_aliases_normalized_trgm_idx').using(
      'gin',
      sql`${table.aliasNormalized} gin_trgm_ops`,
    ),
    supplierIdx: index('supplier_aliases_supplier_idx').on(table.supplierId),
    uniqueAlias: uniqueIndex('supplier_aliases_uniq_idx').on(
      table.supplierId,
      table.aliasNormalized,
    ),
  }),
);

export type SupplierAlias = typeof supplierAliases.$inferSelect;
export type NewSupplierAlias = typeof supplierAliases.$inferInsert;
```

### 4.4 `packages/db/src/schema/supplier-signals.ts`

```ts
import { pgTable, uuid, text, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { externalSuppliers } from './external-suppliers';

/**
 * Per-supplier behavioral signals captured during VTC's interactions
 * with the supplier graph. Distinct from awards (publicly observable
 * facts) — these are private learnings that compound into the moat.
 *
 * Signal types (free-text, application-defined):
 *   rfq_response_time_hrs
 *   rfq_decline_reason
 *   price_vs_index_pct
 *   delivery_on_time
 *   no_response
 *   capability_confirmed
 *   capability_denied
 *   credit_check_passed
 *   ofac_screen_passed
 *
 * Free-text by design — application code defines the canonical set
 * and roll-up logic. New signal types should not require a migration.
 *
 * Roll-ups (avg_response_time_hrs, last_responsive_at, etc.) live
 * in supplier_capability_summary (materialized view) and are
 * refreshed nightly.
 */
export const supplierSignals = pgTable(
  'supplier_signals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    supplierId: uuid('supplier_id')
      .references(() => externalSuppliers.id, { onDelete: 'cascade' })
      .notNull(),

    signalType: text('signal_type').notNull(),
    signalValue: jsonb('signal_value').notNull(),

    /** Optional reference to the RFQ that produced this signal.
        Free-text uuid string for now — wire to a future rfqs table. */
    rfqId: text('rfq_id'),

    observedAt: timestamp('observed_at').defaultNow().notNull(),
  },
  (table) => ({
    supplierObservedIdx: index('supplier_signals_supplier_observed_idx').on(
      table.supplierId,
      table.observedAt,
    ),
    typeIdx: index('supplier_signals_type_idx').on(table.signalType),
  }),
);

export type SupplierSignal = typeof supplierSignals.$inferSelect;
export type NewSupplierSignal = typeof supplierSignals.$inferInsert;
```

### 4.5 Update `packages/db/src/schema/index.ts`

Add the new exports in the same alphabetical-ish order the file already follows:

```ts
export * from './awards';
export * from './award-awardees';
export * from './supplier-aliases';
export * from './supplier-signals';
```

### 4.6 Update `packages/db/src/schema/external-suppliers.ts`

The existing schema is fine for v1. Eventually we'll want to add:
- `category_capabilities` text[] — derived from awards, GIN-indexed
- `awards_count` integer — denormalized counter
- `awards_value_usd_total` numeric(20,2) — denormalized
- `most_recent_award_date` date

But these can wait — the materialized view (4.7) computes them and is cheaper to maintain than denormalized columns.

### 4.7 Materialized view: `supplier_capability_summary`

Create as a Drizzle migration after the four new tables exist. Hand-write the SQL because Drizzle's materialized view support is limited.

```sql
-- packages/db/drizzle/0030_supplier_capability_summary.sql

CREATE MATERIALIZED VIEW supplier_capability_summary AS
SELECT
  s.id AS supplier_id,
  s.organisation_name,
  s.country,

  -- Counts per category (drives reverse search)
  COUNT(*) FILTER (WHERE 'petroleum-fuels' = ANY(a.category_tags))   AS petroleum_awards,
  COUNT(*) FILTER (WHERE 'crude-oil' = ANY(a.category_tags))         AS crude_awards,
  COUNT(*) FILTER (WHERE 'diesel' = ANY(a.category_tags))            AS diesel_awards,
  COUNT(*) FILTER (WHERE 'gasoline' = ANY(a.category_tags))          AS gasoline_awards,
  COUNT(*) FILTER (WHERE 'jet-fuel' = ANY(a.category_tags)
                     OR 'aviation-fuels' = ANY(a.category_tags))     AS jet_awards,
  COUNT(*) FILTER (WHERE 'lpg' = ANY(a.category_tags))               AS lpg_awards,
  COUNT(*) FILTER (WHERE 'marine-bunker' = ANY(a.category_tags))     AS marine_bunker_awards,
  COUNT(*) FILTER (WHERE 'food-commodities' = ANY(a.category_tags))  AS food_awards,
  COUNT(*) FILTER (WHERE 'vehicles' = ANY(a.category_tags))          AS vehicle_awards,

  -- Volume signals
  SUM(a.contract_value_usd)                                          AS total_value_usd,
  COUNT(*)                                                            AS total_awards,
  MAX(a.award_date)                                                   AS most_recent_award_date,
  MIN(a.award_date)                                                   AS first_award_date,

  -- Geography arrays for "where do they deliver"
  ARRAY_AGG(DISTINCT a.beneficiary_country) FILTER (WHERE a.beneficiary_country IS NOT NULL)
                                                                      AS beneficiary_countries,
  ARRAY_AGG(DISTINCT a.buyer_country)                                AS buyer_countries
FROM external_suppliers s
JOIN award_awardees aa ON aa.supplier_id = s.id
JOIN awards a          ON a.id = aa.award_id
GROUP BY s.id, s.organisation_name, s.country;

-- Indexes for fast reverse search
CREATE UNIQUE INDEX supplier_cap_summary_supplier_idx
  ON supplier_capability_summary (supplier_id);
CREATE INDEX supplier_cap_summary_crude_idx
  ON supplier_capability_summary (crude_awards DESC, total_value_usd DESC)
  WHERE crude_awards > 0;
CREATE INDEX supplier_cap_summary_diesel_idx
  ON supplier_capability_summary (diesel_awards DESC, total_value_usd DESC)
  WHERE diesel_awards > 0;
CREATE INDEX supplier_cap_summary_jet_idx
  ON supplier_capability_summary (jet_awards DESC, total_value_usd DESC)
  WHERE jet_awards > 0;
CREATE INDEX supplier_cap_summary_recent_idx
  ON supplier_capability_summary (most_recent_award_date DESC);
CREATE INDEX supplier_cap_summary_country_idx
  ON supplier_capability_summary (country);
```

Refresh nightly via a Trigger.dev job:

```ts
// services/ai-pipeline/src/refresh-supplier-summary.ts
await db.execute(sql`REFRESH MATERIALIZED VIEW CONCURRENTLY supplier_capability_summary`);
```

The `CONCURRENTLY` flag keeps reads working during refresh — required because reverse-search hits this view on every supplier offer that crosses the desk.

---

## 5. Reverse-search query module

New file: `packages/db/src/queries/reverse-search.ts`

Single function — `findBuyersForCommodityOffer()` — that takes a structured commodity offer and returns ranked candidate buyers from the awards table. This is the canonical query that every supplier-offer scenario hits.

```ts
import { sql } from 'drizzle-orm';
import { db } from '../client';

export interface CommodityOfferSpec {
  /** Internal taxonomy tag — e.g. 'crude-oil', 'diesel', 'jet-fuel', 'food-commodities'. */
  categoryTag: string;
  /** Optional commodity name keywords to match against commodity_description (ILIKE). */
  descriptionKeywords?: string[];
  /** Optional UNSPSC codes to require (any-match). */
  unspscCodes?: string[];
  /** Optional ISO-2 country list to filter buyer_country. Empty = all. */
  buyerCountries?: string[];
  /** How far back to look. Default: 5 years. */
  yearsLookback?: number;
  /** Minimum number of matching awards a buyer must have. Default: 2. */
  minAwards?: number;
  /** Page size. Default: 50. */
  limit?: number;
}

export interface CandidateBuyer {
  buyerName: string;
  buyerCountry: string;
  awardsCount: number;
  totalValueUsd: number | null;
  mostRecentAwardDate: string;
  agencies: string[];
  commoditiesBought: string[];
  beneficiaryCountries: string[];
  exampleAwardIds: string[];
}

/**
 * Reverse search: given a commodity offer, find public buyers who
 * have demonstrably bought that commodity in recent history. Returns
 * a ranked list ordered by recency × volume.
 *
 * This is THE function VTC runs on every supplier offer. Schema is
 * stable; the query template should not change without a deliberate
 * conversation about the strategic implication.
 */
export async function findBuyersForCommodityOffer(
  spec: CommodityOfferSpec,
): Promise<CandidateBuyer[]> {
  const yearsLookback = spec.yearsLookback ?? 5;
  const minAwards = spec.minAwards ?? 2;
  const limit = spec.limit ?? 50;

  const result = await db.execute(sql`
    WITH matching_awards AS (
      SELECT
        a.id,
        a.buyer_name,
        a.buyer_country,
        a.contract_value_usd,
        a.award_date,
        a.commodity_description,
        a.beneficiary_country,
        ag.name AS agency_name
      FROM awards a
      LEFT JOIN agencies ag ON ag.id = a.agency_id
      WHERE
        ${spec.categoryTag} = ANY(a.category_tags)
        AND a.award_date >= NOW() - (${yearsLookback}::int || ' years')::interval
        ${spec.descriptionKeywords?.length
          ? sql`AND (${sql.join(
              spec.descriptionKeywords.map((kw) => sql`a.commodity_description ILIKE ${`%${kw}%`}`),
              sql` OR `,
            )})`
          : sql``}
        ${spec.unspscCodes?.length
          ? sql`AND a.unspsc_codes && ${spec.unspscCodes}::text[]`
          : sql``}
        ${spec.buyerCountries?.length
          ? sql`AND a.buyer_country = ANY(${spec.buyerCountries}::text[])`
          : sql``}
    )
    SELECT
      buyer_name,
      buyer_country,
      COUNT(*)::int                                     AS awards_count,
      SUM(contract_value_usd)                           AS total_value_usd,
      MAX(award_date)                                   AS most_recent_award_date,
      ARRAY_AGG(DISTINCT agency_name) FILTER (WHERE agency_name IS NOT NULL) AS agencies,
      ARRAY_AGG(DISTINCT commodity_description) FILTER (WHERE commodity_description IS NOT NULL) AS commodities_bought,
      ARRAY_AGG(DISTINCT beneficiary_country) FILTER (WHERE beneficiary_country IS NOT NULL) AS beneficiary_countries,
      (ARRAY_AGG(id ORDER BY award_date DESC))[1:5]    AS example_award_ids
    FROM matching_awards
    GROUP BY buyer_name, buyer_country
    HAVING COUNT(*) >= ${minAwards}
    ORDER BY MAX(award_date) DESC, SUM(contract_value_usd) DESC NULLS LAST
    LIMIT ${limit};
  `);

  return result.rows as unknown as CandidateBuyer[];
}
```

**Note for Claude Code:** the existing assistant module has a tool registry. Wire this query in as a new assistant tool `find_buyers_for_offer` so Cole can run reverse searches conversationally. See `packages/ai/` for the tool pattern. Tool schema mirrors `CommodityOfferSpec`.

---

## 6. API route

New route: `apps/app/src/app/api/suppliers/reverse-search/route.ts`

```ts
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@procur/auth';
import { findBuyersForCommodityOffer, type CommodityOfferSpec } from '@procur/db/queries/reverse-search';

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.userId) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const spec = (await req.json()) as CommodityOfferSpec;

  if (!spec.categoryTag) {
    return NextResponse.json({ error: 'categoryTag is required' }, { status: 400 });
  }

  const buyers = await findBuyersForCommodityOffer(spec);

  return NextResponse.json({ buyers, spec });
}
```

Multi-tenancy note: this endpoint reads from public-domain tables (`awards`, `agencies`, `external_suppliers`) — no tenant scoping needed at this layer. The endpoint is gated by Clerk auth so any logged-in user can run it.

---

## 7. UI surface — minimal v1

New page: `apps/app/src/app/(authed)/suppliers/reverse-search/page.tsx`

Single form with these inputs:

- Category tag (dropdown: `crude-oil`, `diesel`, `gasoline`, `jet-fuel`, `lpg`, `marine-bunker`, `food-commodities`, `vehicles`)
- Description keywords (free-text, comma-separated)
- Buyer country filter (multi-select with ISO-2 codes; "Mediterranean", "Asia-Pacific", "Caribbean" preset macros)
- Years lookback (slider, default 5)
- Minimum awards (slider, default 2)

On submit, hit `/api/suppliers/reverse-search` and render results as a table:

| Buyer | Country | Awards (5y) | Total $USD | Most recent | Agencies | Sample commodities | Beneficiaries |

Each row clickable → drills into the underlying awards.

Don't over-engineer this. The user is Cole. He needs the table + the export-to-CSV button. The conversational interface (assistant tool from §5) is the more important surface anyway.

---

## 8. What we're explicitly NOT building yet

These are real problems, but they belong in v2 or later. Listed here so future-you doesn't think they were forgotten:

1. **Customs / import data integration** (Kpler, Vortexa, ImportGenius). Public tender data alone misses private refiner-to-refiner crude flows. This is the biggest gap for crude specifically. Skip until v1 reverse-search has been used on at least one real supplier offer.
2. **Refinery configuration data** (Argus, Platts, Oil & Gas Journal annual refining survey). Tells you which refineries can run light sweet vs heavy sour. Premium subscription required.
3. **Supplier graph deduplication UI.** Right now, alias merging happens in scripts. A UI for confirming/rejecting fuzzy matches will become necessary as the supplier table grows past ~5,000 rows. Not before.
4. **Real-time supplier_signals dashboards.** The signals table is being created so we can capture data from day 1, but the analytics layer on top of it can wait.
5. **Per-tenant private supplier overlays** (notes, contact attempts, do-not-contact lists). Add a `supplier_engagements` table with `companyId` FK when this becomes a customer-facing feature.
6. **Outbound RFQ workflow** (the `rfqs` and `rfq_responses` tables that the strategic note proposed). Build this in a separate brief once reverse-search has surfaced real candidate buyers and we know what the RFQ payload actually needs.

---

## 9. Definition of done for this brief

A reasonable Claude Code session ships when:

1. `pnpm db:generate` produces a clean migration covering the four new tables.
2. `pnpm db:push` applies cleanly to a fresh Neon DB.
3. Manual SQL test: insert one fake award + one fake supplier + one award_awardees link → `findBuyersForCommodityOffer({ categoryTag: 'diesel' })` returns the expected row.
4. The materialized view migration runs (`0030_supplier_capability_summary.sql`).
5. `REFRESH MATERIALIZED VIEW CONCURRENTLY supplier_capability_summary` works.
6. The `/api/suppliers/reverse-search` endpoint returns 401 without auth and a JSON result with auth.
7. The minimal UI page renders the form and submits successfully.
8. `relations()` exports for the new tables are added (this is also fixing one of the open issues from the schema review — relations are missing across the existing schema).

---

## 10. Migration ordering & journal reconciliation reminder

Before generating new migrations, **reconcile the existing journal mismatch** flagged in the recent schema review (migrations 0020–0029 exist on disk but aren't in `_journal.json`; 0018 and 0019 don't exist). Decide: are we using `drizzle-kit migrate` or the custom `migrate.ts`? If custom, regenerate snapshots + journal entries for the orphaned migrations before adding new ones, otherwise the next `drizzle-kit generate` will produce a corrupted diff.

If that's not done first, this brief's migrations will land on top of a broken foundation.

---

## 11. Source notes — context Cole and Claude shared in chat

These aren't requirements — they're the strategic frame this brief is meant to operationalize. Reading them is optional but worthwhile if you're new to the picture:

- **Strategic thesis:** VTC becomes a global procurement principal with an asset-light, intelligence-driven supply network. Past bid winners are the most pre-qualified supplier list on earth (already cleared operational, financial, regulatory, and pricing checks). Public award data, aggregated and enriched, is the proprietary asset.
- **Two-sided matching engine:** Buy-side (tenders → past winners → RFQs as bidder) and sell-side (supplier offers → past buyers → outreach as principal) share the same data spine.
- **Reverse search is the highest-leverage workflow.** Every time a trusted broker offers VTC a cargo, the database returns a ranked list of buyers who have demonstrably purchased that commodity in recent history. VTC closes the spread; Vector Antilles handles the money flow; Kenge handles licensing.
- **Geographic scope of v1 supplier graph:** Caribbean (DR, Jamaica already scraped — ~6,000 awards). Trinidad, Guyana, Barbados, Bahamas next. Then Mediterranean / Asia-Pacific for crude grades that move through international markets.
- **Compliance:** Major IOC subsidiaries (TotalEnergies-Caribbean, Sol/Parkland, Chevron/Texaco licensees) cannot touch Cuba directly. VTC's selective deals must use clean Caribbean destinations or operate via Vector Antilles structure with bulletproof legal opinion. Filter `awards.buyer_country` accordingly when surfacing candidates for sanctioned-destination cargoes.

---

End of brief.
