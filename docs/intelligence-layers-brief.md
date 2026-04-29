> **IMPLEMENTATION STATUS — refreshed 2026-04-29**
>
> **Status: all three layers shipped.** This brief specified Layer 1 (vessel), Layer 2 (pricing), Layer 3 (distress). All three are operational.
>
> **Layer 1 — Vessel intelligence:** ✓ shipped
> - Migration 0041 (`vessel_intelligence`) — `vessels`, `vessel_positions`, `port_calls` live
> - `ingest-aisstream.ts` worker live with Trigger.dev cron; bounding boxes include Mediterranean, Caribbean, US Gulf, West Africa
> - Cargo trip inference shipped as discrete commit (#268 — pairs load↔discharge port calls into cargo trips)
> - Vessel-activity panel on entity profile pages; `/suppliers/vessels` map view
> - **Beyond spec:** the inference goes one level deeper than described — generates `cargo_trips` records, not just `port_calls`
>
> **Layer 2 — Pricing intelligence:** ✓ shipped
> - Migration 0040 (`commodity_prices`) live
> - Migration 0049 (`crude_basis_differentials`) **goes beyond brief spec** — the brief described named-grade pricing as "use Brent + apply premium where known"; the implementation shipped a proper basis-differential model with structural premiums
> - Workers: `ingest-eia-prices.ts`, `ingest-fred-prices.ts`, `ingest-ecb-fx.ts` all live with daily cron
> - Caveat: OilPriceAPI free-tier worker not shipped; current coverage is EIA + FRED + ECB only. Adequate for Brent/WTI/refined products + grade differentials. International benchmarks (Dubai, Urals, Singapore VLSFO) require OilPriceAPI subscription per the brief — defer until needed.
>
> **Layer 3 — Distress signals:** ✓ shipped (all five workers live)
> - Migration 0048 (`entity_news_events`) live
> - Migration 0047 (`supplier_velocity_signals`) — rolling-window awards velocity in materialized view
> - Workers: `ingest-sec-edgar.ts`, `ingest-bankruptcy-recap.ts` (PACER), `ingest-trade-press-rss.ts` all live
> - LLM relevance scoring shipped (#266) — scores news events on EDGAR + RECAP feeds against operator-tunable threshold
> - SEDAR worker not shipped — deferred per brief priority order
> - LinkedIn Sales Navigator worker not shipped — deferred per brief priority order
>
> **Migration sequencing differs from brief:** the brief proposed migrations 0039-0042 for these three layers. Actual sequence is 0040, 0041, 0047, 0048, 0049 (interleaved with other work — `crude_grades` took 0039, `pricing_analytics_foundation` took 0042, etc.). End state is identical.
>
> **Divergence from brief:** the implementation went notably beyond spec on (a) cargo trip inference, (b) crude basis differentials, (c) cross-source refinery dedup (`dedup-refineries`). These are the components most directly enabling the proactive-matching capstone.
>
> ---

# Cargo, Price, and Distress Intelligence — Combined Brief

**Status:** spec, not yet implemented
**Owner:** Cole
**Last updated:** 2026-04-28
**Prerequisite:** schema must be on `main` through migration 0038. New migrations in this brief start at 0039.

---

## 1. What we're building, in one paragraph

Three new intelligence layers stacked on top of the existing supplier graph + customs flows + known-entities rolodex. **Vessel intelligence** — free AIS data ingested in real time, joined against the `known_entities` lat/lng index to infer which named refineries and terminals are receiving cargoes. **Pricing intelligence** — free EIA/FRED/OilPriceAPI feeds tracking commodity benchmarks and refined-product spot prices, surfaced into every reverse-search response so candidate buyers come with current market context. **Distress intelligence** — public-source signals (award velocity drop-offs, SEC/SEDAR earnings disclosures, PACER bankruptcy filings, LinkedIn leadership changes) that identify motivated counterparties before they show up in deal flow. Together these answer the three open intelligence gaps (per-cargo attribution, forward-looking pricing, distress signals) using only free or near-free public data sources.

---

## 2. Strategic context — read this before writing code

This brief is the third in a series. Read these first if you don't have context:

- `docs/supplier-graph-brief.md` — the schema foundation (awards, external_suppliers, supplier_aliases, supplier_signals)
- `docs/assistant-tools-spec.md` — the three reverse-search tools wired into the Procur assistant
- `docs/libyan-crude-buyer-brief.md` — the active deal driving the requirements

The supplier-graph captures **what governments bought** (~10-15% of the real buyer universe for crude). The customs-imports table captures **country-level trade flows** (aggregate, not per-cargo). The known-entities table captures **named refineries, traders, and terminals** (curated rolodex of physical assets, with lat/lng).

What's still missing — and what this brief addresses:

1. **Per-cargo attribution.** Which specific refinery received which specific cargo. Customs data tells you "DE imported 2M tons of LY crude in March 2026"; doesn't tell you "Sannazzaro received 1.2M tons of that 2M."
2. **Forward-looking pricing.** What's the going price for crude / refined products / metals concentrate today, what's the differential vs benchmark, what's the trend.
3. **Distress and motivation signals.** Which named counterparties are *currently* motivated to deal — distressed sellers, refineries in turnaround, traders with inventory pressure.

The strategic frame is: **VTC is a Stage-1 broker** (sourcing supplier offers via trusted broker network → matching to candidate buyers via the data warehouse → taking brokerage). Stage 2 is back-to-back trades with margin spread. Stage 3 is principal positions. *This brief serves Stage 1.* Vessel attribution at 70% accuracy is fine — Vitol/Trafigura need 99% accuracy because they trade $2B/yr; we need directional truth because we broker a handful of deals.

**The deliberate non-goal of this brief is paid data subscription substitutes.** We're not building "Kpler killer" or "Argus killer." We're building the free-data approximation that gets a Stage-1 broker to deal close. Paid data (Datalastic at €99/mo, then Kpler at $5-30K/yr if/when justified) becomes a per-deal expense, not a fixed subscription, and is triggered only by actual deal flow demanding more precision.

---

## 3. Architecture summary

| Layer | Schema additions | New ingestion | New queries | New tools |
|---|---|---|---|---|
| **Vessel** | `vessels`, `vessel_positions`, `port_calls` | AISStream.io worker | `find_recent_cargoes` | `find_recent_cargoes` |
| **Pricing** | `commodity_prices` | EIA / FRED / OilPriceAPI workers | `get_commodity_price_context` | `get_commodity_price_context` |
| **Distress** | extend `supplier_capability_summary` MV; new `entity_news_events` | SEC EDGAR / SEDAR / PACER / LinkedIn workers | `find_distressed_suppliers` | `find_distressed_suppliers` |

All three layers are **public-domain data, no companyId scoping** — same pattern as awards/customs/known-entities. Tools live in `packages/catalog/src/tools.ts`. Queries live in `packages/catalog/src/queries.ts`. Schema lives in `packages/db/src/schema/`. Migrations are hand-authored (no `drizzle-kit generate`) starting at 0039.

---

## 4. Layer 1 — Vessel intelligence

### 4.1 What problem this solves

When the user describes a supplier offer ("1M bbl Azeri Light loading Batumi"), the existing reverse-search tool returns candidate buyers from public-tender data. That misses ~85% of the real buyer universe (private major refiners). The known-entities rolodex captures those refiners by name + lat/lng but doesn't tell us which ones are *currently* receiving cargoes of similar grades.

Vessel intelligence fills this gap. By tracking tanker AIS positions and joining port-call sequences against the known-entities lat/lng index, we infer cargo flows. A tanker that loaded at Es Sider and arrived at Sannazzaro is, with high probability, a Libyan crude cargo to Eni. Aggregate this across thousands of tanker movements and you have a per-refinery cargo log that approximates Kpler's offering at the precision a Stage-1 broker actually needs.

### 4.2 Schema

#### `packages/db/src/schema/vessels.ts`

```ts
import {
  pgTable,
  uuid,
  text,
  numeric,
  integer,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Vessel registry — one row per tanker / bulk carrier we've observed.
 * IMO is the canonical identifier; MMSI is included because AIS
 * messages key off MMSI primarily, and some legacy AIS streams omit
 * IMO. Reconciliation is by IMO when present, MMSI otherwise.
 *
 * Vessel type codes follow ITU-R M.1371 AIS standard:
 *   80-89 = Tanker (we want all of these)
 *   70-79 = Cargo (selective ingestion based on bulk carrier subtypes)
 *   90-99 = Other (not ingested)
 *
 * Public-domain. No tenant scoping.
 */
export const vessels = pgTable(
  'vessels',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** International Maritime Organization number — globally unique
        7-digit identifier. Null only for vessels we've seen in AIS but
        haven't yet matched to an IMO record (rare). */
    imo: text('imo'),
    /** Maritime Mobile Service Identity — MMSI is unique per radio
        transmitter, but transmitters can be reassigned, so MMSI is
        less stable than IMO. We store both. */
    mmsi: text('mmsi').notNull(),

    name: text('name'),
    callsign: text('callsign'),
    flag: text('flag'),                              // ISO-2 country code

    /** ITU-R M.1371 vessel type code (0-99). 80-89 = tanker. */
    aisVesselType: integer('ais_vessel_type'),
    /** Verbose category for filtering: 'crude_oil_tanker',
        'product_tanker', 'chemical_tanker', 'lpg_carrier',
        'lng_carrier', 'bulk_carrier', 'general_cargo'. Set by
        an enrichment step using IMO database lookup or AIS code
        + ship-name regex. */
    vesselCategory: text('vessel_category'),

    /** Deadweight tonnes — capacity. Used for cargo size estimation
        when joining vessel arrivals to known refinery throughputs. */
    deadweightTonnes: integer('deadweight_tonnes'),
    yearBuilt: integer('year_built'),

    /** Operator / commercial manager. Often differs from registered
        owner; the operator is the entity actually deploying the vessel.
        Useful when a tanker arrival can be attributed to a known
        trading house (Vitol, Trafigura) via its operator. */
    operatorName: text('operator_name'),

    firstSeenAt: timestamp('first_seen_at').defaultNow().notNull(),
    lastSeenAt: timestamp('last_seen_at').defaultNow().notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    mmsiUniq: uniqueIndex('vessels_mmsi_uniq_idx').on(table.mmsi),
    imoIdx: index('vessels_imo_idx').on(table.imo).where(sql`${table.imo} IS NOT NULL`),
    nameTrgmIdx: index('vessels_name_trgm_idx').using(
      'gin',
      sql`${table.name} gin_trgm_ops`,
    ),
    categoryIdx: index('vessels_category_idx').on(table.vesselCategory),
  }),
);

export type Vessel = typeof vessels.$inferSelect;
export type NewVessel = typeof vessels.$inferInsert;
```

#### `packages/db/src/schema/vessel-positions.ts`

```ts
import {
  pgTable,
  uuid,
  numeric,
  integer,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { vessels } from './vessels';

/**
 * Time-series of AIS position reports. WRITE-HEAVY table — expect
 * thousands of rows/minute in production. Partition by day if
 * volume becomes a problem; for v1, single table is fine.
 *
 * Storage strategy: keep 30 days of high-resolution position data,
 * then aggregate to per-day position summaries and drop raw rows.
 * Implement the rollup as a separate Trigger.dev job (NOT in this
 * brief — defer until volume justifies it).
 *
 * Public-domain. No tenant scoping.
 */
export const vesselPositions = pgTable(
  'vessel_positions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    vesselId: uuid('vessel_id')
      .references(() => vessels.id, { onDelete: 'cascade' })
      .notNull(),

    timestamp: timestamp('timestamp').notNull(),

    latitude: numeric('latitude', { precision: 9, scale: 6 }).notNull(),
    longitude: numeric('longitude', { precision: 9, scale: 6 }).notNull(),

    /** Speed over ground, in knots (0.1 precision). Speed near 0
        + close to a known port = arrival event. */
    sogKnots: numeric('sog_knots', { precision: 5, scale: 2 }),
    /** Course over ground, degrees 0-360. Useful for filtering
        anomalous positions. */
    cogDegrees: numeric('cog_degrees', { precision: 5, scale: 2 }),

    /** AIS navigational status code (0-15). 1=anchored, 5=moored —
        these correlate to in-port presence. */
    navStatus: integer('nav_status'),

    /** Reported destination (free-text, AIS-broadcast). Often
        unreliable — vessels sometimes don't update. Used as a
        weak signal. */
    destination: text('destination'),

    /** Source of this position — 'aisstream', 'aishub', etc. */
    source: text('source').notNull(),

    ingestedAt: timestamp('ingested_at').defaultNow().notNull(),
  },
  (table) => ({
    vesselTimeIdx: index('vessel_positions_vessel_time_idx').on(
      table.vesselId,
      table.timestamp,
    ),
    timeIdx: index('vessel_positions_time_idx').on(table.timestamp),
  }),
);

export type VesselPosition = typeof vesselPositions.$inferSelect;
export type NewVesselPosition = typeof vesselPositions.$inferInsert;
```

#### `packages/db/src/schema/port-calls.ts`

```ts
import {
  pgTable,
  uuid,
  text,
  numeric,
  timestamp,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';
import { vessels } from './vessels';
import { knownEntities } from './known-entities';

/**
 * Inferred port-call events. Each row = one observation that a
 * specific vessel entered, anchored at, or departed from a specific
 * port (or near-port area). Generated by a periodic worker that
 * scans vessel_positions for proximity-to-port events.
 *
 * NOT a verbatim AIS port-call (those don't exist as discrete
 * messages). These are derived events; the algorithm is conservative
 * — only emits an event when the vessel is within 5km of a known
 * port for >2 hours at SOG <1 knot.
 *
 * The known_entity_id link is populated when the port falls within
 * 20km of a known refinery, terminal, or named port. This is the
 * cargo-attribution layer: tanker arriving near refinery X is
 * (with probability) discharging crude to refinery X.
 *
 * The attribution is intentionally probabilistic — we expose
 * `confidence` so query-time consumers know how much to trust
 * the link. Confidence factors:
 *   - distance to known_entity: 1.0 at <2km, 0.5 at 20km
 *   - vessel_category match (tanker -> refinery): +0.2
 *   - dwell time (longer = higher conf): +0.0 to +0.2
 *   - prior call history (this vessel has called here before): +0.1
 *
 * Public-domain. No tenant scoping.
 */
export const portCalls = pgTable(
  'port_calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    vesselId: uuid('vessel_id')
      .references(() => vessels.id, { onDelete: 'cascade' })
      .notNull(),

    /** Inferred port name (free text from reverse-geocode + AIS
        destination heuristic). Verbatim from algorithm output;
        not normalized in v1. */
    portName: text('port_name'),
    portCountry: text('port_country'),               // ISO-2

    /** Probable receiving entity, if within 20km of a known entity. */
    knownEntityId: uuid('known_entity_id').references(() => knownEntities.id),
    /** 0.0-1.0 confidence in the entity attribution. */
    attributionConfidence: numeric('attribution_confidence', { precision: 3, scale: 2 }),

    arrivedAt: timestamp('arrived_at').notNull(),
    departedAt: timestamp('departed_at'),
    /** Hours the vessel was in-port (or NULL if still in-port). */
    dwellHours: numeric('dwell_hours', { precision: 6, scale: 2 }),

    /** Inferred draft change — heavy on arrival, light on departure
        suggests discharge; reverse suggests loading. Computed from
        AIS-reported draft if available, NULL otherwise. */
    inferredEvent: text('inferred_event'),           // 'load' | 'discharge' | 'transit' | 'unknown'

    /** Position at arrival — useful for debugging the proximity
        algorithm without rerunning it. */
    arrivalLat: numeric('arrival_lat', { precision: 9, scale: 6 }),
    arrivalLon: numeric('arrival_lon', { precision: 9, scale: 6 }),

    /** Algorithm version + parameters that produced this row.
        Re-running the inference replaces rows where this differs. */
    algorithmVersion: text('algorithm_version').notNull().default('v1'),
    algorithmMetadata: jsonb('algorithm_metadata'),

    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    vesselArrivalIdx: index('port_calls_vessel_arrival_idx').on(
      table.vesselId,
      table.arrivedAt,
    ),
    entityArrivalIdx: index('port_calls_entity_arrival_idx').on(
      table.knownEntityId,
      table.arrivedAt,
    ),
    arrivalTimeIdx: index('port_calls_arrival_time_idx').on(table.arrivedAt),
  }),
);

export type PortCall = typeof portCalls.$inferSelect;
export type NewPortCall = typeof portCalls.$inferInsert;
```

### 4.3 Migration

`packages/db/drizzle/0039_vessel_intelligence.sql` — hand-authored, follows the convention of 0032/0036/0038. Three CREATE TABLE statements, the indexes, and a journal entry.

### 4.4 Ingestion worker

`packages/db/src/ingest-aisstream.ts` (mirrors the existing `ingest-eurostat-comext.ts` pattern):

```ts
/**
 * AISStream.io WebSocket consumer. Subscribes to bounding boxes
 * covering Mediterranean + Caribbean + key tanker routes, filters
 * to tanker vessel types (AIS code 80-89), upserts vessel records,
 * inserts vessel_positions.
 *
 * Bounding boxes for v1 (matches VTC's actual market):
 *   - Mediterranean: lat 30-46, lon -6-37
 *   - Caribbean + Gulf of Mexico: lat 7-31, lon -98 to -58
 *   - West Africa: lat -10 to 15, lon -20 to 12  (Bonny Light, Cabinda)
 *   - Black Sea + Sea of Azov: lat 40-48, lon 27-42  (Azeri Light routing)
 *
 * Run as a long-lived process. Reconnect on disconnect (AISStream
 * occasionally drops the socket). Rate of incoming messages is ~5-50
 * per second across these bounding boxes. Batch-insert positions in
 * 100-row batches every 1-5 seconds for write efficiency.
 *
 * AISStream.io API key is free with registration. Store in env as
 * AISSTREAM_API_KEY.
 *
 * Idempotency: not strictly idempotent on positions (we'd dedupe by
 * (vessel_id, timestamp) but timestamps are at message granularity).
 * Acceptable in v1 — duplicate AIS messages are rare. If needed,
 * add a uniqueIndex on (vessel_id, timestamp).
 */
```

`packages/db/src/infer-port-calls.ts` — separate worker, runs every 15 minutes:

```ts
/**
 * Scans vessel_positions for proximity-to-port events. Algorithm:
 *
 *   1. For each vessel with new positions in the last hour:
 *   2.   Find spans where (sog < 1.0 knots) for >= 2 hours
 *   3.   Reverse-geocode the cluster center against known_entities
 *        with non-null lat/lng, taking the nearest entity within 20km
 *   4.   If no known_entity within 20km, attempt to match against a
 *        known port name via OSM nominatim (cached locally to avoid
 *        rate limits)
 *   5.   Insert/update a port_calls row with attribution confidence
 *   6.   When the vessel resumes movement (sog > 3 knots for >30min),
 *        close the port-call by setting departed_at + dwell_hours
 *
 * Idempotency: re-running the worker should update existing port_calls
 * with later positions, not create duplicates. The (vessel_id,
 * arrived_at) tuple is the natural dedup key.
 *
 * Algorithm version is stamped on every row so future tuning can
 * deprecate old rows cleanly.
 */
```

### 4.5 Query module

`packages/catalog/src/queries.ts` — add:

```ts
export interface RecentCargoesSpec {
  /** ISO-2 country code (e.g. 'IT' for Italian refineries) — find
      cargoes arriving at refineries/terminals in this country. */
  destinationCountry?: string;
  /** Specific known_entity to filter to. */
  knownEntityId?: string;
  /** ISO-2 origin country — find cargoes that loaded at this country's
      ports. Implemented as: vessel had a port_call in this country
      within the cargo voyage window. */
  originCountry?: string;
  /** Vessel category filter: 'crude_oil_tanker', 'product_tanker', etc. */
  vesselCategory?: string;
  /** How many days back. Default 90. */
  daysLookback?: number;
  /** Min attribution confidence. Default 0.4 (suppresses pure
      proximity-without-entity-match noise). */
  minConfidence?: number;
  limit?: number;
}

export interface RecentCargoArrival {
  vesselName: string | null;
  vesselImo: string | null;
  vesselCategory: string | null;
  deadweightTonnes: number | null;
  destinationEntity: string | null;       // known_entities.name
  destinationEntitySlug: string | null;
  destinationPort: string | null;
  destinationCountry: string | null;
  arrivedAt: Date;
  inferredEvent: string | null;
  attributionConfidence: number | null;
  /** Origin = the port the vessel last loaded at, derived from the
      most recent prior port-call where inferred_event = 'load'. */
  inferredOriginPort: string | null;
  inferredOriginCountry: string | null;
  inferredOriginAt: Date | null;
}

export async function findRecentCargoes(
  spec: RecentCargoesSpec,
): Promise<RecentCargoArrival[]> {
  /* Implementation:
   *   1. SELECT from port_calls JOIN vessels JOIN known_entities
   *   2. Filter by destination country / entity / vessel category /
   *      arrival window / min confidence
   *   3. For each result row, look up the most recent prior
   *      port_call for the same vessel where inferred_event = 'load'
   *      → that's the origin
   *   4. Return as RecentCargoArrival
   *
   * Origin lookup is per-row but cheap (vessel_arrival idx covers it).
   * If volume becomes an issue, add a `voyage_id` denormalization
   * field that pairs load + discharge calls. Defer.
   */
}
```

### 4.6 Assistant tool

`packages/catalog/src/tools.ts` — add:

```ts
export const findRecentCargoesTool = defineTool({
  name: 'find_recent_cargoes',
  description:
    "Find recent tanker arrivals at refineries, terminals, or named ports. " +
    "Powered by free AIS data joined against the known-entities rolodex. " +
    "Returns vessel name, destination entity, arrival date, inferred origin " +
    "port, and attribution confidence. Use this when the user asks 'who " +
    "received recent cargoes of X' / 'has Y refinery been buying recently' / " +
    "'what tankers arrived at Z port last month'. Attribution is " +
    "PROBABILISTIC (60-80% accuracy typical) — always surface the confidence " +
    "score to the user. For deal-flow specificity beyond ~80% confidence, " +
    "Kpler or Datalastic paid subscriptions are required; this tool " +
    "intentionally provides directional truth, not certainty.",
  kind: 'read',
  schema: z.object({
    destinationCountry: z.string().length(2).optional(),
    destinationEntitySlug: z.string().optional()
      .describe("known_entities.slug — e.g. 'eni-sannazzaro-refinery'"),
    originCountry: z.string().length(2).optional(),
    vesselCategory: z.enum([
      'crude_oil_tanker', 'product_tanker', 'chemical_tanker',
      'lpg_carrier', 'lng_carrier',
    ]).optional(),
    daysLookback: z.number().min(1).max(365).default(90),
    minConfidence: z.number().min(0).max(1).default(0.4),
    limit: z.number().min(1).max(100).default(30),
  }),
  handler: async (ctx, args) => {
    /* Resolve destinationEntitySlug → knownEntityId, then call
       findRecentCargoes. */
  },
});
```

### 4.7 Free-data limits worth knowing

- **AISStream.io coverage** is terrestrial-receiver-based. Mediterranean/Caribbean/EU coverage is dense (volunteer station network is mature there). Open-ocean coverage is sparse — vessels will "disappear" mid-voyage for hours and reappear when they re-enter coastal range. For our use case (loading + discharge events near coasts), this is acceptable.
- **No per-cargo composition data.** AIS doesn't broadcast what's in the tank. We infer from origin port + vessel category + destination refinery configuration. This works for crude (Es Sider → Sannazzaro = Libyan crude with high probability) but not for refined products where the same tanker could carry diesel, gasoline, or jet fuel sequentially.
- **Vessel ownership / charterer data** is not in AIS. Operator names (when present in IMO database lookups) are 6-12 months stale. Don't trust these for "is this Vitol's cargo" questions; use as weak signal only.

If/when the Libyan deal or any other specific opportunity requires per-cargo composition certainty, **the upgrade path is Datalastic at €99/month**, not Kpler. Datalastic gives proper satellite AIS coverage and slightly richer vessel metadata for ~$1,200/year. Only step up to Kpler/MarineTraffic Enterprise if a deal in front of us specifically demands per-cargo bills-of-lading attribution.

---

## 5. Layer 2 — Pricing intelligence

### 5.1 What problem this solves

Every reverse-search response should arrive with current market context — what's Brent today, what's the 30-day trend, what's the typical seasonal pattern. Without this, the assistant lists candidate buyers but can't answer the next obvious question ("is this priced fairly?"). Every supplier offer gets a sanity check against current spot benchmarks; every buyer outreach gets enriched with "given current Brent at $X and Mediterranean differential at $Y, here's the implied delivered price."

### 5.2 Schema

#### `packages/db/src/schema/commodity-prices.ts`

```ts
import {
  pgTable,
  uuid,
  text,
  numeric,
  date,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';

/**
 * Daily commodity price observations. One row per
 * (source, commodity_code, period). Prices are stored as
 * USD/unit verbatim from source — no FX conversion needed for
 * USD-denominated benchmarks (Brent, WTI, etc).
 *
 * Sources we ingest:
 *   - 'eia' — EIA spot prices (Brent, WTI, refined products)
 *   - 'fred' — FRED daily Brent series, Henry Hub gas
 *   - 'oilpriceapi' — OilPriceAPI free tier (broader benchmark set)
 *
 * Commodity codes follow an internal vocabulary (NOT exchange tickers
 * — exchange tickers conflict between CME/ICE/NYMEX). We define:
 *   - 'brent_dated' — Brent dated benchmark
 *   - 'wti_cushing' — WTI Cushing
 *   - 'dubai_crude' — Dubai/Oman benchmark
 *   - 'urals_med' — Urals Med
 *   - 'gasoline_rbob' — RBOB gasoline (US)
 *   - 'diesel_ulsd_ny' — ULSD New York Harbor
 *   - 'jet_a1_ny' — Jet A-1 New York Harbor
 *   - 'vlsfo_singapore' — VLSFO Singapore (marine fuel)
 *   - 'hsfo_singapore' — HSFO Singapore
 *   - 'henry_hub' — Henry Hub natural gas
 *
 * Source-specific code stored in source_native_code for traceability.
 *
 * Public-domain. No tenant scoping.
 */
export const commodityPrices = pgTable(
  'commodity_prices',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    source: text('source').notNull(),
    sourceNativeCode: text('source_native_code'),     // EIA series code, FRED ID, etc.
    commodityCode: text('commodity_code').notNull(),  // internal vocabulary

    period: date('period').notNull(),
    /** 'D' = daily, 'W' = weekly, 'M' = monthly. */
    periodGranularity: text('period_granularity').notNull().default('D'),

    /** USD per barrel for crude/refined products. USD/MMBtu for natgas.
        Source-canonical — no conversion. */
    priceUsd: numeric('price_usd', { precision: 10, scale: 4 }).notNull(),
    /** Unit label for human readability: 'USD/bbl', 'USD/MMBtu',
        'USD/ton'. */
    priceUnit: text('price_unit').notNull(),

    /** Free-form payload from source for reparsing. */
    rawPayload: jsonb('raw_payload'),

    ingestedAt: timestamp('ingested_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    sourceUniq: uniqueIndex('commodity_prices_source_uniq_idx').on(
      table.source,
      table.commodityCode,
      table.period,
    ),
    commodityPeriodIdx: index('commodity_prices_commodity_period_idx').on(
      table.commodityCode,
      table.period,
    ),
    periodIdx: index('commodity_prices_period_idx').on(table.period),
  }),
);

export type CommodityPrice = typeof commodityPrices.$inferSelect;
export type NewCommodityPrice = typeof commodityPrices.$inferInsert;
```

### 5.3 Migration

`packages/db/drizzle/0040_commodity_prices.sql` — single CREATE TABLE + indexes + journal entry.

### 5.4 Ingestion workers

Three workers, all daily cron:

#### `packages/db/src/ingest-eia-prices.ts`

```ts
/**
 * EIA petroleum spot prices. Public API, requires free API key
 * (EIA_API_KEY env var). Endpoints:
 *   - PET.RBRTE.D = Brent Europe daily
 *   - PET.RWTC.D = WTI Cushing daily
 *   - PET.EER_EPMRR_PF4_Y35NY_DPG.D = NY Harbor RBOB Gasoline
 *   - PET.EER_EPD2DXL0_PF4_Y35NY_DPG.D = NY Harbor No 2 Heating Oil
 *   - PET.EER_EPJK_PF4_RGC_DPG.D = Gulf Coast Jet Fuel
 *
 * Hits the v2 EIA API: https://api.eia.gov/v2/petroleum/pri/spt/data
 *
 * Idempotent on (source='eia', commodity_code, period). Re-running
 * updates rows with revised values (EIA does revise occasionally).
 *
 * Run daily 16:00 UTC (after EIA's typical publish time).
 */
```

#### `packages/db/src/ingest-fred-prices.ts`

```ts
/**
 * FRED (St. Louis Fed) economic data. Public API, requires free
 * API key (FRED_API_KEY env var). Series:
 *   - DCOILBRENTEU = Daily Brent Europe (free, public domain)
 *   - DCOILWTICO = Daily WTI Cushing
 *   - DHHNGSP = Daily Henry Hub Natural Gas Spot
 *
 * FRED is a backup/cross-check for EIA. Rare divergence between the
 * two — when it happens, EIA is canonical (FRED republishes EIA).
 *
 * Run daily 17:00 UTC.
 */
```

#### `packages/db/src/ingest-oilpriceapi.ts`

```ts
/**
 * OilPriceAPI free tier — Urals, Dubai, OPEC Basket, marine fuels
 * (VLSFO, HSFO Singapore), refined products beyond what EIA covers.
 *
 * Free tier rate limits: ~100 requests/day (sufficient for daily
 * polling of ~10 commodities). Requires API key
 * (OILPRICEAPI_KEY env var).
 *
 * Run daily 18:00 UTC.
 */
```

### 5.5 Query module

`packages/catalog/src/queries.ts` — add:

```ts
export interface CommodityPriceContextSpec {
  /** Internal commodity code or category tag.
      'crude-oil' resolves to brent_dated;
      'diesel' to diesel_ulsd_ny;
      'jet-fuel' to jet_a1_ny;
      'marine-bunker' to vlsfo_singapore + hsfo_singapore.
      Multi-resolution allowed. */
  categoryTag: string;
  /** Window for stats. Default 30 days. */
  windowDays?: number;
}

export interface CommodityPriceContext {
  commodityCode: string;
  unit: string;
  /** Most recent close. */
  spotPrice: number;
  spotDate: string;
  /** Stats over window. */
  windowDays: number;
  windowMin: number;
  windowMax: number;
  windowMean: number;
  windowChangePct: number;          // (latest - first) / first * 100
  /** Same-month-previous-year for seasonal comparison. */
  yearAgoPrice: number | null;
  yoyChangePct: number | null;
  /** Notes the LLM should surface verbatim — caveat language about
      free-data limitations. */
  caveat: string;
}

export async function getCommodityPriceContext(
  spec: CommodityPriceContextSpec,
): Promise<CommodityPriceContext[]> {
  /* Implementation:
   *   1. Resolve categoryTag -> 1+ commodity_code(s)
   *   2. For each code, SELECT recent prices (window + 1 year ago)
   *   3. Compute spot, min/max/mean/change, YoY
   *   4. Add fixed caveat text about benchmark vs grade-specific
   *      pricing
   */
}
```

### 5.6 Assistant tool

`packages/catalog/src/tools.ts` — add:

```ts
export const getCommodityPriceContextTool = defineTool({
  name: 'get_commodity_price_context',
  description:
    "Get current spot price, recent trend, and seasonal context for a " +
    "commodity benchmark. Powered by free EIA, FRED, and OilPriceAPI feeds. " +
    "Use this when the user asks 'what's the price of X' / 'is this offer " +
    "competitive' / 'where is the market'. ALWAYS surface the caveat the " +
    "tool returns: this is benchmark pricing (Brent, WTI, Singapore VLSFO), " +
    "NOT grade-specific differentials (Es Sider vs Brent, gasoil vs diesel). " +
    "For grade-specific differentials, Argus or Platts paid letters are " +
    "needed; this tool intentionally provides benchmark context only.",
  kind: 'read',
  schema: z.object({
    categoryTag: z.string().describe(
      "Internal taxonomy tag — 'crude-oil', 'diesel', 'gasoline', " +
      "'jet-fuel', 'marine-bunker', 'lpg', 'natural-gas'."
    ),
    windowDays: z.number().min(7).max(365).default(30),
  }),
  handler: async (ctx, args) => {
    /* Call getCommodityPriceContext(args), return as structured. */
  },
});
```

### 5.7 Free-data limits worth knowing

- **No grade-specific differentials.** Brent is the closest benchmark for Libyan, West African, and most Mediterranean light sweet crudes — but the actual transacted price is "Brent ± $X/bbl" where X is grade-specific and varies daily. Free data tells you Brent. It does not tell you X. The assistant should always frame results as "Brent is currently $Y; the actual deal price for [grade] will trade at a differential to that — get the differential from the seller's broker or pay for Argus."
- **Lag.** EIA/FRED/OilPriceAPI all run with 1-2 day lag for daily series, 1 week for weekly series. Not real-time. Acceptable for Stage-1 brokerage where deal cycles run days-to-weeks.
- **Refined product spot prices are US-centric.** EIA covers NY Harbor RBOB, Gulf Coast Jet, ULSD. Singapore prices via OilPriceAPI. **Mediterranean refined products are not free.** If/when the European Mediterranean refined products market becomes a priority, that's where paid Argus subscription pays for itself.

---

## 6. Layer 3 — Distress and motivation signals

### 6.1 What problem this solves

The existing supplier-graph identifies *who has won what*. It doesn't identify *who is currently motivated to deal*. A supplier who stopped winning awards 6 months ago is more receptive to a back-to-back arrangement than one who's winning every tender. A producer whose offtake contract is up for renegotiation in Q3 is more open to alternative buyers. A trading desk whose parent just announced layoffs has inventory to clear. Public data captures all three of these signals — nobody on your side is mining them yet.

This layer extends `supplier_capability_summary` with rolling-window metrics and adds a new `entity_news_events` table that captures discrete events (filings, leadership changes, contract expirations) extracted from public sources.

### 6.2 Schema

#### Extend `packages/db/drizzle/0033_supplier_capability_summary.sql` via a new migration

`packages/db/drizzle/0041_supplier_velocity_signals.sql` — drops and recreates the materialized view with additional columns:

```sql
DROP MATERIALIZED VIEW IF EXISTS supplier_capability_summary CASCADE;

CREATE MATERIALIZED VIEW supplier_capability_summary AS
SELECT
  s.id AS supplier_id,
  s.organisation_name,
  s.country,

  -- (existing columns from 0033 — counts per category) ...

  -- NEW: rolling-window velocity signals
  COUNT(*) FILTER (
    WHERE a.award_date >= NOW() - INTERVAL '90 days'
  ) AS awards_last_90d,
  COUNT(*) FILTER (
    WHERE a.award_date >= NOW() - INTERVAL '180 days'
      AND a.award_date <  NOW() - INTERVAL '90 days'
  ) AS awards_prev_90d,

  SUM(a.contract_value_usd) FILTER (
    WHERE a.award_date >= NOW() - INTERVAL '90 days'
  ) AS value_usd_last_90d,
  SUM(a.contract_value_usd) FILTER (
    WHERE a.award_date >= NOW() - INTERVAL '180 days'
      AND a.award_date <  NOW() - INTERVAL '90 days'
  ) AS value_usd_prev_90d,

  -- Geographic dispersion: countries in last 12mo
  ARRAY_LENGTH(
    ARRAY_AGG(DISTINCT a.buyer_country) FILTER (
      WHERE a.award_date >= NOW() - INTERVAL '365 days'
    ),
    1
  ) AS distinct_countries_last_12mo,

  MAX(a.award_date) AS most_recent_award_date,
  MIN(a.award_date) AS first_award_date,
  COUNT(*) AS total_awards,
  SUM(a.contract_value_usd) AS total_value_usd

FROM external_suppliers s
JOIN award_awardees aa ON aa.supplier_id = s.id
JOIN awards a          ON a.id = aa.award_id
GROUP BY s.id, s.organisation_name, s.country;

-- Indexes (recreate from 0033) + new ones for velocity queries:
CREATE UNIQUE INDEX supplier_cap_summary_supplier_idx
  ON supplier_capability_summary (supplier_id);
CREATE INDEX supplier_cap_summary_velocity_idx
  ON supplier_capability_summary (awards_last_90d, awards_prev_90d)
  WHERE awards_prev_90d > 0;
CREATE INDEX supplier_cap_summary_recent_idx
  ON supplier_capability_summary (most_recent_award_date DESC);
```

Refresh nightly per the existing pattern. **`CONCURRENTLY` requires the unique index, which is preserved.**

#### `packages/db/src/schema/entity-news-events.ts`

```ts
import {
  pgTable,
  uuid,
  text,
  date,
  timestamp,
  jsonb,
  numeric,
  index,
} from 'drizzle-orm/pg-core';
import { knownEntities } from './known-entities';
import { externalSuppliers } from './external-suppliers';

/**
 * Discrete public-source events relevant to a counterparty's motivation
 * to deal. Distinct from supplier_signals (which is private behavioral
 * data captured during VTC interactions) — this is observation of
 * publicly-disclosed events.
 *
 * Event types (free-text vocabulary):
 *   - 'sec_filing_offtake_change' (10-K, 10-Q, 8-K mentions)
 *   - 'sedar_filing_offtake_change' (Canadian equivalents)
 *   - 'bankruptcy_filing' (PACER alerts on petroleum/metals SIC codes)
 *   - 'leadership_change' (LinkedIn-detected role changes at producers)
 *   - 'turnaround_announced' (refinery maintenance disclosures)
 *   - 'sanctions_action' (OFAC SDN list updates, EU sanctions)
 *   - 'press_distress_signal' (RSS-monitored trade-press articles
 *      mentioning surplus, delays, force majeure, etc.)
 *
 * Linked to either a known_entity (preferred) or an external_supplier
 * (when it's a public-procurement winner). Both nullable — some events
 * pertain to entities not in either table; we still capture them and
 * resolve later.
 *
 * `relevanceScore` is set by an LLM extraction step (0.0-1.0). Below
 * 0.5 = noise (mention without substantive content); above 0.8 = high
 * signal.
 *
 * Public-domain. No tenant scoping.
 */
export const entityNewsEvents = pgTable(
  'entity_news_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** Either or both populated — NULL when extraction couldn't
        resolve to a known entity. */
    knownEntityId: uuid('known_entity_id').references(() => knownEntities.id),
    externalSupplierId: uuid('external_supplier_id').references(
      () => externalSuppliers.id,
    ),

    /** Verbatim entity name from source — used for retroactive
        linking when entities get added later. */
    sourceEntityName: text('source_entity_name').notNull(),
    sourceEntityCountry: text('source_entity_country'),

    eventType: text('event_type').notNull(),
    eventDate: date('event_date').notNull(),

    /** 1-2 sentence summary the LLM extracted from the source. */
    summary: text('summary').notNull(),
    /** Full source payload for re-extraction. */
    rawPayload: jsonb('raw_payload'),

    /** Source identifiers. */
    source: text('source').notNull(),         // 'sec-edgar' | 'sedar' | 'pacer' | 'linkedin' | 'rss-trade-press'
    sourceUrl: text('source_url'),
    sourceDocId: text('source_doc_id'),

    /** Set by extraction step. */
    relevanceScore: numeric('relevance_score', { precision: 3, scale: 2 }),

    ingestedAt: timestamp('ingested_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    entityIdx: index('entity_news_events_entity_idx').on(table.knownEntityId),
    supplierIdx: index('entity_news_events_supplier_idx').on(table.externalSupplierId),
    eventTypeIdx: index('entity_news_events_type_idx').on(table.eventType),
    eventDateIdx: index('entity_news_events_date_idx').on(table.eventDate),
    sourceEntityNameIdx: index('entity_news_events_name_trgm_idx').using(
      'gin',
      sql`${table.sourceEntityName} gin_trgm_ops`,
    ),
  }),
);

export type EntityNewsEvent = typeof entityNewsEvents.$inferSelect;
export type NewEntityNewsEvent = typeof entityNewsEvents.$inferInsert;
```

### 6.3 Migration

`packages/db/drizzle/0041_supplier_velocity_signals.sql` (the MV recreate, above)
`packages/db/drizzle/0042_entity_news_events.sql` (the new table)

Both hand-authored, journal entries added.

### 6.4 Ingestion workers

Five workers, ranging from cheap-and-easy to expensive-and-fragile:

#### `packages/db/src/ingest-sec-edgar.ts` — daily

```ts
/**
 * SEC EDGAR full-text search for U.S.-listed petroleum and metals
 * producers. No API key required; rate-limited at 10 req/sec.
 *
 * Strategy:
 *   1. Maintain a watchlist of CIK numbers (companies of interest)
 *      seeded from known_entities where role IN ('producer', 'refiner',
 *      'trader') AND country='US'
 *   2. Daily, poll EDGAR for new 10-K/10-Q/8-K filings from watchlist
 *   3. For each new filing, use full-text search for keywords:
 *      'offtake', 'marketing agreement', 'force majeure', 'turnaround',
 *      'capacity reduction', 'asset sale', 'restructuring'
 *   4. When a hit, extract surrounding paragraph and submit to LLM
 *      extraction step → entity_news_events row
 *
 * EDGAR endpoints:
 *   - Full-text search: efts.sec.gov/LATEST/search-index
 *   - Submission filings: data.sec.gov/submissions/CIK{cik}.json
 *   - Filing content: www.sec.gov/Archives/edgar/data/{cik}/...
 *
 * Free, no auth, public domain.
 */
```

#### `packages/db/src/ingest-sedar.ts` — daily

```ts
/**
 * SEDAR+ — Canadian equivalent of EDGAR. Required for LatAm-active
 * Canadian-listed mining majors (Antofagasta, First Quantum,
 * Lundin, Hudbay, etc.) and Canadian-listed petroleum players
 * (Parkland, Cenovus).
 *
 * SEDAR+ has NO public API. Scraping required, rate-limited politely.
 * Endpoint: https://www.sedarplus.ca
 *
 * Same extraction strategy as EDGAR — keyword search across new
 * filings, LLM extraction for relevance.
 *
 * If scraping breaks (UI changes), defer; SEDAR is lower priority
 * than EDGAR for Stage-1 brokerage.
 */
```

#### `packages/db/src/ingest-pacer-bankruptcy.ts` — daily

```ts
/**
 * PACER bankruptcy filings filtered to petroleum/metals SIC codes.
 *
 * Cost: $0.10/page; effectively free at our query volume (<$50/mo).
 * Free PACER account required (PACER_USERNAME, PACER_PASSWORD env).
 *
 * Strategy:
 *   1. Daily, query PACER's case search for NEW Chapter 11/7/15
 *      filings in the last 24h
 *   2. Filter to debtor industries matching SIC codes 1311 (crude
 *      petroleum), 2911 (petroleum refining), 5172 (petroleum
 *      products wholesale), 1041 (gold mining), 1044 (silver),
 *      1031 (lead/zinc), 1021 (copper)
 *   3. For each match, create an entity_news_events row with
 *      event_type='bankruptcy_filing'
 *
 * Bankruptcy filings are HIGH SIGNAL for distressed sellers —
 * Chapter 11 typically means inventory to liquidate.
 */
```

#### `packages/db/src/ingest-trade-press-rss.ts` — hourly

```ts
/**
 * RSS monitoring of trade press for distress signals.
 *
 * Source list (free RSS):
 *   - Reuters Energy
 *   - Bloomberg Commodities (limited free RSS)
 *   - S&P Global Commodity Insights public articles
 *   - Hellenic Shipping News
 *   - Mining.com
 *   - Argus Media public news (the public-facing portion)
 *   - Platts public news
 *   - OilPrice.com
 *
 * Strategy:
 *   1. Poll each RSS feed hourly
 *   2. For each new article, run LLM extraction to identify:
 *      - Named entities (refineries, producers, traders, ports)
 *      - Distress keywords (force majeure, surplus, glut, delay,
 *        outage, turnaround, layoff, restructuring)
 *      - Price-relevant mentions (differentials, deals at $X)
 *   3. When entity + distress keyword co-occur, create
 *      entity_news_events row with event_type='press_distress_signal'
 *      and relevance_score from LLM
 *   4. When price mention extracted, add to a future price_observations
 *      table (NOT in this brief)
 *
 * Run rate ~50-100 articles/day across all sources. LLM extraction
 * via existing AI infrastructure in @procur/ai. Cost: <$5/mo at this
 * volume.
 */
```

#### `packages/db/src/ingest-linkedin-leadership.ts` — weekly

```ts
/**
 * LinkedIn Sales Navigator-based monitoring of leadership changes
 * at watchlist entities.
 *
 * REQUIRES LINKEDIN SALES NAVIGATOR SUBSCRIPTION (~$1K/yr, optional
 * for v1). If absent, this worker is a no-op.
 *
 * Strategy when subscription present:
 *   1. Maintain a saved-search list per entity (e.g.,
 *      "Director Commercial at Eni Trading & Shipping")
 *   2. Weekly, diff the result set against last week
 *   3. New names → 'leadership_change' events
 *   4. Departed names → optional follow-up event
 *
 * Note: LinkedIn TOS — automated scraping is forbidden. Sales
 * Navigator's saved-search API is permitted and avoids TOS issues.
 * If we ever scrape outside that, reassess.
 */
```

### 6.5 Query module

`packages/catalog/src/queries.ts` — add:

```ts
export interface DistressedSuppliersSpec {
  categoryTag?: string;
  /** ISO-2 country (or array). */
  countries?: string[];
  /** Minimum prior-period awards count (filters out suppliers who
      never won much anyway). Default 3. */
  minPrevAwards?: number;
  /** Velocity drop threshold. -0.5 = "awards dropped 50%+ vs prior
      period". Default -0.5. */
  velocityChangeMax?: number;
  /** Include suppliers with recent news events (bankruptcy, etc).
      Default true. */
  includeNewsEvents?: boolean;
  limit?: number;
}

export interface DistressedSupplier {
  supplierId: string;
  organisationName: string;
  country: string;
  awardsLast90d: number;
  awardsPrev90d: number;
  velocityChangePct: number;            // negative = distress
  valueUsdLast90d: number | null;
  valueUsdPrev90d: number | null;
  mostRecentAwardDate: Date;
  /** Recent news events (last 90 days, relevance_score > 0.5). */
  recentNewsEvents: Array<{
    eventType: string;
    eventDate: Date;
    summary: string;
    relevanceScore: number;
    sourceUrl: string | null;
  }>;
  /** Plain-text reasons this supplier is on the list. */
  distressReasons: string[];
}

export async function findDistressedSuppliers(
  spec: DistressedSuppliersSpec,
): Promise<DistressedSupplier[]> {
  /* Implementation:
   *   1. SELECT from supplier_capability_summary where
   *      awards_prev_90d >= minPrevAwards
   *      AND (awards_last_90d / awards_prev_90d - 1) <= velocityChangeMax
   *   2. Optional category/country filter
   *   3. JOIN entity_news_events for last-90d events with
   *      relevance >= 0.5 (NULL-tolerant — many suppliers won't
   *      have news)
   *   4. Compose distressReasons array from the data:
   *      e.g. "Awards down 78% in last 90 days vs prior period",
   *      "PACER bankruptcy filing 2026-03-15"
   */
}
```

### 6.6 Assistant tool

`packages/catalog/src/tools.ts` — add:

```ts
export const findDistressedSuppliersTool = defineTool({
  name: 'find_distressed_suppliers',
  description:
    "Find suppliers showing distress signals — sharp drops in award velocity, " +
    "recent bankruptcy filings, leadership changes at parent companies, " +
    "trade-press mentions of force majeure or surplus. Use this when the user " +
    "asks 'who's motivated to deal' / 'which suppliers are under pressure' / " +
    "'who has inventory they need to clear'. Returns supplier details PLUS " +
    "recent news events that triggered the distress flag, so the LLM can " +
    "explain WHY each supplier is on the list. This is the highest-leverage " +
    "sell-side discovery tool — distressed suppliers are most receptive to " +
    "back-to-back arrangements, alternative buyers, and price flexibility.",
  kind: 'read',
  schema: z.object({
    categoryTag: z.string().optional(),
    countries: z.array(z.string().length(2)).optional(),
    minPrevAwards: z.number().min(1).default(3),
    velocityChangeMax: z.number().min(-1).max(0).default(-0.5),
    includeNewsEvents: z.boolean().default(true),
    limit: z.number().min(1).max(50).default(20),
  }),
  handler: async (ctx, args) => {
    /* Call findDistressedSuppliers, return as structured. */
  },
});
```

### 6.7 What this layer cannot do

- **It cannot replicate private deal-flow signals.** RFQ response time, price-vs-index, decline reasons — all of these only emerge from your own outreach. Layer 3 surfaces *candidates likely to be motivated*; the actual confirmation of motivation comes from running RFQs and logging outcomes in `supplier_signals`.
- **News extraction is noisy.** LLM extraction at <0.5 relevance is mostly false positives. The query module filters at 0.5; consumers can filter higher for precision. Tune over time as the dataset grows.
- **Bankruptcy is a US/Canada signal.** Equivalent processes in other jurisdictions (EU insolvency, UK administration) have less consistent public databases. PACER covers the US; SEDAR partially covers Canada; everything else is press-coverage-only via the RSS layer.

---

## 7. Order of operations within this brief

Schema → migrations → ingestion workers → queries → tools → registry. Within layers:

1. **Layer 1 first** (vessel intelligence). Highest deal-flow leverage, builds on `known_entities` lat/lng infrastructure already deployed.
2. **Layer 2 second** (pricing). Cheap to build, immediately useful in every reverse-search response.
3. **Layer 3 third** (distress). Most complex (5 ingestion workers, LLM extraction); biggest payoff but largest surface area.

Each layer is independently shippable. If time runs out, ship Layer 1 and stop — that alone closes the largest of the three intelligence gaps.

**Within Layer 3, ship the schema additions first** (the velocity signals on `supplier_capability_summary` + `entity_news_events` table), then build ingestion workers in this order:

1. `ingest-sec-edgar.ts` — most reliable source, biggest signal
2. `ingest-pacer-bankruptcy.ts` — second-highest signal-to-noise
3. `ingest-trade-press-rss.ts` — broad coverage, requires LLM extraction
4. `ingest-sedar.ts` — Canadian, fragile (scraping)
5. `ingest-linkedin-leadership.ts` — DEFER unless Sales Navigator subscription is in place

---

## 8. What we're explicitly NOT building yet

These belong in v2 or later. Listed so they don't get scope-crept into this brief:

1. **Paid AIS subscription integration** (Datalastic, Kpler/MarineTraffic). The brief uses free AIS only. Datalastic at €99/month is the natural next step when free coverage hits its limits — *and that step is triggered by an actual deal demanding it, not by general capability ambition.*
2. **Argus or Platts paid subscriptions** for grade-specific differentials. Brief uses free benchmarks only. Argus Caribbean Petroleum Letter (~$12-15K/yr) is the natural next step *when Caribbean fuel deal volume justifies it*.
3. **Vessel-position rollup / partitioning** for `vessel_positions` time-series. Add when row count exceeds ~50M.
4. **Voyage-level joining** (load → discharge pair as a single voyage entity). Useful but defers cleanly to v2.
5. **Cargo composition prediction** beyond simple origin × vessel-category × destination heuristics. ML-based prediction would need training data we don't yet have.
6. **Real-time price differentials extraction** from RSS articles. Layer 3's RSS worker tags price mentions but doesn't store them in a structured price-observations table. Add that table in v2.
7. **`price_observations` table** for storing extracted differential mentions from press. Defer.
8. **Cross-tenant signal aggregation** for `supplier_signals` (private behavioral data). Currently empty; private when populated. Schema is ready; don't build aggregation yet.

---

## 9. Definition of done

A reasonable Claude Code session ships when:

1. Three new schema files for Layer 1 (`vessels.ts`, `vessel-positions.ts`, `port-calls.ts`) exist with relations() exports.
2. One new schema file for Layer 2 (`commodity-prices.ts`) with relations() exports.
3. One new schema file for Layer 3 (`entity-news-events.ts`) with relations() exports.
4. Migrations 0039 through 0042 are hand-authored, the journal is updated, `pnpm db:push` applies cleanly to a fresh Neon DB.
5. The materialized view recreate (0041) preserves all existing 0033 columns and adds the new velocity signals.
6. Ingestion workers exist for: `ingest-aisstream.ts`, `infer-port-calls.ts`, `ingest-eia-prices.ts`, `ingest-fred-prices.ts`, `ingest-oilpriceapi.ts`, `ingest-sec-edgar.ts`, `ingest-pacer-bankruptcy.ts`, `ingest-trade-press-rss.ts`. (Sedar + LinkedIn are deferrable.)
7. Three new query module functions exist in `packages/catalog/src/queries.ts`:
   - `findRecentCargoes`
   - `getCommodityPriceContext`
   - `findDistressedSuppliers`
8. Three new assistant tools registered in `packages/catalog/src/tools.ts`:
   - `find_recent_cargoes`
   - `get_commodity_price_context`
   - `find_distressed_suppliers`
9. System prompt block in `packages/ai/src/assistant/` is updated to describe when to use each new tool.
10. Smoke tests pass:
    - Insert one fake vessel + position + port-call → `find_recent_cargoes` returns the row
    - With seeded `commodity_prices` rows → `get_commodity_price_context({categoryTag:'crude-oil'})` returns Brent context
    - With seeded velocity signals → `find_distressed_suppliers` returns suppliers with negative velocity

---

## 10. Environment variables to add

```
# Layer 1 — Vessel
AISSTREAM_API_KEY=          # free at https://aisstream.io

# Layer 2 — Pricing
EIA_API_KEY=                # free at https://www.eia.gov/opendata/register.php
FRED_API_KEY=               # free at https://fred.stlouisfed.org/docs/api/api_key.html
OILPRICEAPI_KEY=            # free trial at https://www.oilpriceapi.com

# Layer 3 — Distress
PACER_USERNAME=             # free at pacer.uscourts.gov
PACER_PASSWORD=

# Optional (defer)
LINKEDIN_SN_API_TOKEN=      # only needed if Sales Navigator subscription is active
DATALASTIC_API_KEY=         # only needed if upgrading from free AIS — €99/mo
```

---

## 11. Source notes — why this brief looks the way it does

These are the design assumptions encoded in the brief. Reading them is optional but worthwhile if you want to challenge specific decisions:

- **Free-data-first.** Stage-1 brokerage doesn't need precision; it needs directionality. The Datalastic/Kpler upgrade path exists and is documented but is deliberately deferred to per-deal triggering.
- **Probabilistic attribution as a feature, not a bug.** The `port_calls.attributionConfidence` column is exposed all the way up to the assistant tool's response shape so the LLM can communicate uncertainty to the user. This prevents over-trust of free-AIS-derived flows.
- **Distress signals from public sources only.** Private behavioral data (`supplier_signals`) is intentionally NOT in scope here — that table fills as VTC actually runs deals. This brief gives you the *candidate identification* layer; deal flow gives you the confirmation layer.
- **All public-domain, no tenant scoping.** Same pattern as `awards`, `customs_imports`, `known_entities`. The first private-data table in this codebase will be `supplier_signals` when it stops being empty; that's a separate brief when it happens.
- **Bounded geographic scope for Layer 1.** AIS bounding boxes match VTC's market (Med + Caribbean + West Africa + Black Sea). Expanding to global coverage 5x's the message volume; defer until a deal demands it.

---

End of brief.
