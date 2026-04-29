> **IMPLEMENTATION STATUS — refreshed 2026-04-29**
>
> **Status: shipped + extended.** The award delta-vs-spot analytics engine is live.
>
> Shipped per spec:
> - Migration 0042 (`pricing_analytics_foundation`) — `commodity_benchmark_mappings`, `country_default_currencies`, `fx_rates`
> - Migration 0044 (`award_price_deltas`) — the materialized view with confidence scoring (7 KB SQL)
> - Migration 0043 (`award_quantity_bbl`) — added as bbl-normalized quantity column for cross-grade comparison (not in brief; needed for the analytics to work)
> - Migrations 0045 + 0046 — OCDS jurisdiction expansion (10 publishers seeded: Mexico, Colombia, Paraguay, Honduras, plus 6 more)
> - ECB FX daily cron live
> - All three tools live: `analyze_supplier_pricing`, `analyze_buyer_pricing`, `evaluate_offer_against_history`
>
> **Divergence from brief:** OCDS expansion was scoped wider than this brief anticipated. The benchmark coverage now spans far more LatAm publishers than originally specced — Mexico, Colombia, Paraguay, Honduras among others. This expanded the practical universe of comparable awards substantially.
>
> The currency handling went with the "best-effort backfill" choice you made (assumed currency where missing, FX-converted, confidence-scored). Working as designed.
>
> ---

# Pricing Analytics Addendum — Award Delta-vs-Spot Intelligence

**Status:** spec, not yet implemented
**Owner:** Cole
**Last updated:** 2026-04-28
**Prerequisite:** `docs/intelligence-layers-brief.md` Section 5 (commodity_prices schema and EIA/FRED ingestion) must be implemented first. This brief depends on `commodity_prices` rows existing.

---

## 1. What we're building, in one paragraph

For every award in the supplier graph, compute the delta between the realized contract price and the prevailing spot benchmark on the award date. Aggregate these deltas per supplier, per buyer, per category, per country to surface pricing patterns: who's pricing high vs market, which buyers are getting squeezed, what's the typical Caribbean fuel premium over US Gulf benchmark, which awards are statistical outliers (sole-source pricing, emergency procurement, distress sales). Then surface this intelligence through three new assistant tools that let the chat answer "is this offer competitive" with empirical history rather than guesses. **Free data only** — EIA + FRED + ECB historical FX, no paid subscriptions.

The strategic goal is empirical price discovery. Mediterranean diesel benchmarks aren't free; Caribbean diesel benchmarks don't exist. But your own award history *is* a price discovery layer once you compute the delta-over-NY-Harbor-ULSD pattern. Every new supplier offer gets evaluated against that empirical distribution.

---

## 2. Why this approach works

There's no free Mediterranean diesel benchmark. There's no free Caribbean LPG benchmark. Argus and Platts charge real money specifically because grade-and-region-specific benchmarks have value. **But the goal here is not to replicate Argus.** It's to extract a usable pricing signal from data we already have.

The insight: **if 200 DR diesel awards over 5 years averaged $0.23/L over NY Harbor ULSD on the award date, that $0.23 is empirically the all-in Caribbean delivery + handling + margin premium.** Computing it is free. The empirically-derived premium is the analytical output. Once we have it, evaluating a new offer becomes deterministic — does the supplier's quoted differential land inside our historical distribution, or is it an outlier?

This works for our purposes (Stage-1 brokerage, deal evaluation, supplier credibility scoring) without requiring grade-specific benchmark feeds. The implicit assumption — that the Caribbean premium is roughly stable over time and across awards — is empirically verifiable from the data itself once we plot the distribution.

---

## 3. Architecture summary

| Component | Purpose | Build cost |
|---|---|---|
| `commodity_benchmark_mappings` table | Lookup mapping (category × country × grade) → EIA/FRED series ID | 1 hour to seed |
| `country_default_currencies` table | Best-effort currency backfill for awards with NULL currency | 30 min to seed |
| `fx_rates` table + ECB ingestion worker | Historical daily FX rates for currency conversion | 1 day |
| `award_price_deltas` materialized view | Per-award delta-vs-benchmark with confidence score | 2 days |
| Outlier detection logic | Z-score-based flagging on deltas | embedded in MV |
| Three query modules | analytics for supplier / buyer / offer evaluation | 1-2 days |
| Three assistant tools | conversational surface | 1 day |

Total: ~1 week of Claude Code work. All free-data, no new subscriptions.

---

## 4. Schema additions

### 4.1 `packages/db/src/schema/commodity-benchmark-mappings.ts`

```ts
import {
  pgTable,
  uuid,
  text,
  numeric,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';

/**
 * Maps internal taxonomy (category × country × grade) to a specific
 * commodity_prices series. Used by award_price_deltas materialized
 * view to find the right benchmark for each award.
 *
 * Granularity: category + country + grade. Multiple rows per category
 * are common (one per country, one per grade variant). When the
 * award's grade is unknown, the resolution falls back through:
 *   1. exact match (category + country + grade)
 *   2. category + country + NULL grade (country default)
 *   3. category + 'GLOBAL' + NULL grade (global default)
 *
 * Public-domain. No tenant scoping.
 */
export const commodityBenchmarkMappings = pgTable(
  'commodity_benchmark_mappings',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** Internal category tag — matches awards.category_tags vocabulary. */
    categoryTag: text('category_tag').notNull(),
    /** ISO-2 country code, or 'GLOBAL' for catch-all. */
    countryCode: text('country_code').notNull(),
    /** Grade specifier. NULL = country default for the category.
        Examples: 'ulsd_50ppm', 'ulsd_500ppm', 'rbob_87', 'rbob_93',
        'jet_a1', 'hfo_380cst', 'lpg_propane'. */
    grade: text('grade'),

    /** Reference to commodity_prices.commodity_code. */
    benchmarkCode: text('benchmark_code').notNull(),
    /** The commodity_prices.source that owns this code, for clarity. */
    benchmarkSource: text('benchmark_source').notNull(),  // 'eia' | 'fred' | 'oilpriceapi'

    /** Optional adjustment factor — for cases where the benchmark is
        a known proxy with a stable offset. E.g. RBOB 87 vs 93 has a
        stable ~$0.10-0.20/gal premium for 93. NULL = no adjustment. */
    benchmarkAdjustmentUsdBbl: numeric('benchmark_adjustment_usd_bbl', {
      precision: 8,
      scale: 4,
    }),

    /** Free-text rationale for why this benchmark was chosen. Useful
        when revisiting mappings later. */
    notes: text('notes'),

    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    lookupUniq: uniqueIndex('commodity_benchmark_mappings_uniq_idx').on(
      table.categoryTag,
      table.countryCode,
      table.grade,
    ),
    categoryIdx: index('commodity_benchmark_mappings_category_idx').on(
      table.categoryTag,
    ),
  }),
);

export type CommodityBenchmarkMapping = typeof commodityBenchmarkMappings.$inferSelect;
export type NewCommodityBenchmarkMapping = typeof commodityBenchmarkMappings.$inferInsert;
```

### 4.2 `packages/db/src/schema/country-default-currencies.ts`

```ts
import {
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

/**
 * Best-effort currency assumption for awards with NULL currency.
 * Loaded once from a static seed. Updated rarely.
 *
 * Caveat: some Caribbean countries trade fuel in USD even though
 * their local currency exists (BS, BB, JM partially). The defaults
 * reflect what's most common for the public-procurement category.
 *
 * Public-domain. No tenant scoping.
 */
export const countryDefaultCurrencies = pgTable(
  'country_default_currencies',
  {
    countryCode: text('country_code').primaryKey(),  // ISO-2
    defaultCurrency: text('default_currency').notNull(),  // ISO-4217
    notes: text('notes'),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
);

export type CountryDefaultCurrency = typeof countryDefaultCurrencies.$inferSelect;
```

### 4.3 `packages/db/src/schema/fx-rates.ts`

```ts
import {
  pgTable,
  uuid,
  text,
  numeric,
  date,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';

/**
 * Daily FX rates against USD. Sourced from ECB historical reference
 * rates (free, daily, going back to 1999). For currencies not on ECB,
 * a fallback ingestion via FRED's foreign exchange series fills gaps.
 *
 * Convention: rate_to_usd = (1 unit of currency) -> USD. So if 60 DOP
 * = 1 USD, the row stores rate_to_usd = 0.01667.
 *
 * Use for converting award contract values to USD when the source
 * data lacks an explicit USD value.
 *
 * Public-domain. No tenant scoping.
 */
export const fxRates = pgTable(
  'fx_rates',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    currencyCode: text('currency_code').notNull(),  // ISO-4217
    rateDate: date('rate_date').notNull(),
    /** USD per 1 unit of currency_code. */
    rateToUsd: numeric('rate_to_usd', { precision: 18, scale: 8 }).notNull(),

    source: text('source').notNull(),  // 'ecb' | 'fred' | 'manual'

    ingestedAt: timestamp('ingested_at').defaultNow().notNull(),
  },
  (table) => ({
    currencyDateUniq: uniqueIndex('fx_rates_currency_date_uniq_idx').on(
      table.currencyCode,
      table.rateDate,
    ),
    dateIdx: index('fx_rates_date_idx').on(table.rateDate),
  }),
);

export type FxRate = typeof fxRates.$inferSelect;
export type NewFxRate = typeof fxRates.$inferInsert;
```

### 4.4 Materialized view: `award_price_deltas`

This is the analytical engine. Hand-authored as `packages/db/drizzle/0043_award_price_deltas.sql`:

```sql
-- Resolves benchmark, FX-converts award value, computes delta with confidence score
CREATE MATERIALIZED VIEW award_price_deltas AS
WITH
-- Step 1: Resolve effective currency (explicit -> country default -> 'USD')
awards_with_currency AS (
  SELECT
    a.id AS award_id,
    a.buyer_country,
    a.beneficiary_country,
    a.award_date,
    a.commodity_description,
    a.category_tags,
    a.contract_value_native,
    a.contract_value_usd,
    a.contract_currency,
    -- Effective currency: explicit if present, else country default, else USD
    COALESCE(
      a.contract_currency,
      cdc.default_currency,
      'USD'
    ) AS effective_currency,
    -- Confidence: was currency explicit?
    CASE
      WHEN a.contract_currency IS NOT NULL THEN 1.0
      WHEN cdc.default_currency IS NOT NULL THEN 0.6
      ELSE 0.3
    END AS currency_confidence,
    a.unspsc_codes,
    aa.supplier_id
  FROM awards a
  LEFT JOIN country_default_currencies cdc ON cdc.country_code = a.buyer_country
  LEFT JOIN award_awardees aa ON aa.award_id = a.id
  WHERE a.award_date IS NOT NULL
),
-- Step 2: Resolve USD value (use explicit; else FX-convert from native)
awards_in_usd AS (
  SELECT
    awc.*,
    CASE
      -- explicit USD value present and currency matches
      WHEN awc.contract_value_usd IS NOT NULL THEN awc.contract_value_usd
      -- USD currency, use native value
      WHEN awc.effective_currency = 'USD' THEN awc.contract_value_native
      -- non-USD: FX-convert at award_date
      WHEN fx.rate_to_usd IS NOT NULL THEN awc.contract_value_native * fx.rate_to_usd
      ELSE NULL
    END AS computed_value_usd,
    CASE
      WHEN awc.contract_value_usd IS NOT NULL THEN 1.0
      WHEN awc.effective_currency = 'USD' THEN 1.0
      WHEN fx.rate_to_usd IS NOT NULL THEN 0.85
      ELSE 0.0
    END AS value_confidence
  FROM awards_with_currency awc
  LEFT JOIN fx_rates fx
    ON fx.currency_code = awc.effective_currency
    AND fx.rate_date = awc.award_date
),
-- Step 3: Resolve grade from commodity_description (regex extraction).
-- This is necessarily approximate. Common patterns:
--   '15 ppm' / 'ulsd' / 'low sulphur' -> ulsd_50ppm
--   '500 ppm' -> ulsd_500ppm
--   '87 octane' / 'regular' -> rbob_87
--   '93 octane' / 'premium' / 'super' -> rbob_93
-- For awards where grade can't be inferred, leave NULL and let the
-- benchmark mapping fall through to country default.
awards_with_grade AS (
  SELECT
    *,
    CASE
      WHEN commodity_description ~* 'ulsd|ultra.?low|15.?ppm|10.?ppm' THEN 'ulsd_50ppm'
      WHEN commodity_description ~* '500.?ppm|low.?sulphur|low.?sulfur' THEN 'ulsd_500ppm'
      WHEN commodity_description ~* '93.?octane|premium|super|optimo' THEN 'rbob_93'
      WHEN commodity_description ~* '87.?octane|regular' THEN 'rbob_87'
      WHEN commodity_description ~* 'jet.?a' THEN 'jet_a1'
      WHEN commodity_description ~* '380.?cst|hfo|heavy.?fuel|residual' THEN 'hfo_380cst'
      WHEN commodity_description ~* 'lpg|propane|butane' THEN 'lpg_propane'
      ELSE NULL
    END AS inferred_grade
  FROM awards_in_usd
),
-- Step 4: Resolve benchmark via 3-tier fallback (specific -> country default -> global)
awards_with_benchmark AS (
  SELECT
    awg.*,
    -- Most-specific match available
    COALESCE(
      cbm_specific.benchmark_code,
      cbm_country.benchmark_code,
      cbm_global.benchmark_code
    ) AS benchmark_code,
    COALESCE(
      cbm_specific.benchmark_adjustment_usd_bbl,
      cbm_country.benchmark_adjustment_usd_bbl,
      cbm_global.benchmark_adjustment_usd_bbl,
      0
    ) AS benchmark_adjustment,
    -- Mapping confidence: more specific = higher confidence
    CASE
      WHEN cbm_specific.benchmark_code IS NOT NULL THEN 1.0
      WHEN cbm_country.benchmark_code IS NOT NULL THEN 0.8
      WHEN cbm_global.benchmark_code IS NOT NULL THEN 0.5
      ELSE 0.0
    END AS benchmark_confidence
  FROM awards_with_grade awg
  -- Most specific: category + country + grade
  LEFT JOIN commodity_benchmark_mappings cbm_specific
    ON cbm_specific.category_tag = ANY(awg.category_tags)
    AND cbm_specific.country_code = awg.buyer_country
    AND cbm_specific.grade = awg.inferred_grade
  -- Country default: category + country + NULL grade
  LEFT JOIN commodity_benchmark_mappings cbm_country
    ON cbm_country.category_tag = ANY(awg.category_tags)
    AND cbm_country.country_code = awg.buyer_country
    AND cbm_country.grade IS NULL
  -- Global default: category + 'GLOBAL'
  LEFT JOIN commodity_benchmark_mappings cbm_global
    ON cbm_global.category_tag = ANY(awg.category_tags)
    AND cbm_global.country_code = 'GLOBAL'
    AND cbm_global.grade IS NULL
),
-- Step 5: Look up benchmark spot price on award_date
awards_with_spot AS (
  SELECT
    awb.*,
    cp.price_usd AS benchmark_price_usd,
    cp.price_unit AS benchmark_price_unit
  FROM awards_with_benchmark awb
  LEFT JOIN commodity_prices cp
    ON cp.commodity_code = awb.benchmark_code
    AND cp.period = awb.award_date
    -- If exact-date benchmark missing, fall back to most recent prior 7 days.
    -- (Implemented via a LATERAL join in production for simplicity here.)
)
-- Final select: compute delta and overall confidence
SELECT
  award_id,
  supplier_id,
  buyer_country,
  beneficiary_country,
  award_date,
  category_tags,
  inferred_grade,
  effective_currency,
  computed_value_usd,
  benchmark_code,
  benchmark_price_usd,
  benchmark_price_unit,
  benchmark_adjustment,
  -- Effective benchmark = published price + grade adjustment
  (benchmark_price_usd + benchmark_adjustment) AS effective_benchmark_usd,
  -- Delta in absolute USD/bbl-or-unit terms
  CASE
    WHEN computed_value_usd IS NOT NULL AND benchmark_price_usd IS NOT NULL
      THEN computed_value_usd - (benchmark_price_usd + benchmark_adjustment)
    ELSE NULL
  END AS delta_usd,
  -- Delta as % over benchmark
  CASE
    WHEN computed_value_usd IS NOT NULL
      AND benchmark_price_usd IS NOT NULL
      AND (benchmark_price_usd + benchmark_adjustment) > 0
      THEN ((computed_value_usd - (benchmark_price_usd + benchmark_adjustment))
            / (benchmark_price_usd + benchmark_adjustment)) * 100.0
    ELSE NULL
  END AS delta_pct,
  -- Overall confidence: minimum of currency, value, benchmark confidences
  LEAST(currency_confidence, value_confidence, benchmark_confidence) AS overall_confidence
FROM awards_with_spot;

CREATE UNIQUE INDEX award_price_deltas_award_idx
  ON award_price_deltas (award_id);
CREATE INDEX award_price_deltas_supplier_idx
  ON award_price_deltas (supplier_id);
CREATE INDEX award_price_deltas_country_category_idx
  ON award_price_deltas (buyer_country, (category_tags));
CREATE INDEX award_price_deltas_confidence_idx
  ON award_price_deltas (overall_confidence)
  WHERE overall_confidence >= 0.7;
```

**Refresh strategy:** nightly via Trigger.dev job, `REFRESH MATERIALIZED VIEW CONCURRENTLY award_price_deltas`. The unique index supports `CONCURRENTLY`. Refresh runs after the daily EIA/FRED ingestion completes, so each night's refresh incorporates the latest spot prices.

**Caveat for Claude Code:** the SQL above is illustrative; the production version needs a LATERAL join for the fallback-to-prior-7-days logic on benchmark prices (I've shown only exact-date matching above for readability). Implement the LATERAL fallback so that benchmark gaps don't kill delta computation for awards on weekends/holidays.

---

## 5. Seed data

Both `commodity_benchmark_mappings` and `country_default_currencies` are static lookup tables. Seed once via a migration or a Trigger.dev one-shot script.

### 5.1 `country_default_currencies` seed

A small CSV at `packages/db/src/seed/country-default-currencies.csv`. ~30 rows covering the realistic award universe:

```
country_code,default_currency,notes
DO,DOP,Dominican Republic — fuel awards routinely in DOP
JM,JMD,Jamaica — most public awards in JMD; private deals often USD
TT,TTD,Trinidad & Tobago
BB,USD,Barbados — most fuel deals invoiced in USD despite BBD existing
BS,USD,Bahamas — same pattern
HT,USD,Haiti — heavily dollarized fuel market
US,USD,
CA,CAD,
MX,MXN,
GT,GTQ,
HN,HNL,
SV,USD,El Salvador — uses USD officially
CO,COP,Colombia
EC,USD,Ecuador — uses USD officially
PE,PEN,Peru
CL,CLP,Chile
AR,ARS,Argentina
BR,BRL,Brazil
GB,GBP,
DE,EUR,
FR,EUR,
IT,EUR,
ES,EUR,
NL,EUR,
GR,EUR,
TR,TRY,
IL,ILS,
NG,NGN,
GH,GHS,
SN,XOF,Senegal — CFA franc West African
IN,INR,
SG,SGD,
JP,JPY,
KR,KRW,
CN,CNY,
```

### 5.2 `commodity_benchmark_mappings` seed

A larger CSV at `packages/db/src/seed/commodity-benchmark-mappings.csv`. Realistic seed of ~50 rules covering Caribbean + LatAm + Mediterranean + Asia fuel awards. Sample rows:

```
category_tag,country_code,grade,benchmark_code,benchmark_source,benchmark_adjustment_usd_bbl,notes
diesel,GLOBAL,ulsd_50ppm,eia_ulsd_ny_harbor,eia,0,NY Harbor ULSD as global default
diesel,GLOBAL,ulsd_500ppm,eia_no2_ny_harbor,eia,-3.5,No 2 distillate is ~$3.50/bbl below ULSD
diesel,DO,,eia_ulsd_ny_harbor,eia,0,DR diesel ULSD default
diesel,JM,,eia_ulsd_ny_harbor,eia,0,Jamaica diesel
diesel,TT,,eia_ulsd_ny_harbor,eia,0,Trinidad diesel
diesel,US,,eia_ulsd_ny_harbor,eia,0,US diesel direct
diesel,IT,,eia_ulsd_ny_harbor,eia,2,Italian diesel — small premium for transatlantic shipping & EU spec
diesel,IN,,eia_ulsd_ny_harbor,eia,-1,India diesel — slight discount, regional supply
gasoline,GLOBAL,rbob_87,eia_rbob_ny_harbor,eia,0,NY Harbor RBOB regular
gasoline,GLOBAL,rbob_93,eia_rbob_ny_harbor,eia,8,Premium 93-octane premium ~$8/bbl
gasoline,DO,,eia_rbob_ny_harbor,eia,0,DR gasoline default
gasoline,JM,,eia_rbob_ny_harbor,eia,0,Jamaica gasoline
gasoline,US,,eia_rbob_ny_harbor,eia,0,
jet-fuel,GLOBAL,jet_a1,eia_jet_gulf_coast,eia,0,Gulf Coast Jet
jet-fuel,DO,,eia_jet_gulf_coast,eia,0,
jet-fuel,JM,,eia_jet_gulf_coast,eia,0,
jet-fuel,US,,eia_jet_gulf_coast,eia,0,
heavy-fuel-oil,GLOBAL,hfo_380cst,oilpriceapi_hsfo_singapore,oilpriceapi,0,HSFO Singapore as global proxy
heavy-fuel-oil,DO,,oilpriceapi_hsfo_singapore,oilpriceapi,0,
crude-oil,GLOBAL,,fred_brent_eu,fred,0,Brent as global crude default
crude-oil,US,,fred_wti_cushing,fred,0,WTI for US-domestic awards
lpg,GLOBAL,lpg_propane,eia_propane_mont_belvieu,eia,0,Mont Belvieu propane
lpg,DO,,eia_propane_mont_belvieu,eia,0,
heating-oil,GLOBAL,,eia_no2_ny_harbor,eia,0,NY Harbor No 2 heating oil
marine-bunker,GLOBAL,vlsfo,oilpriceapi_vlsfo_singapore,oilpriceapi,0,
marine-bunker,GLOBAL,hsfo,oilpriceapi_hsfo_singapore,oilpriceapi,0,
```

Seed via a one-shot Trigger.dev job that reads the CSV and upserts. Idempotent (uniqueIndex prevents duplicates).

---

## 6. ECB FX rates ingestion

`packages/db/src/ingest-ecb-fx.ts` — daily worker:

```ts
/**
 * European Central Bank historical reference rates. Free, daily,
 * public domain. Coverage: ~30 currencies from 1999 onwards.
 *
 * Endpoint: https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.zip
 *   - Single zip with full history, refreshed daily ~16:00 CET
 *   - Format: CSV, one row per date, columns per currency
 *   - Rates are EUR-per-1-currency, must be converted to USD-per-1-currency
 *
 * Strategy:
 *   1. Daily, download the zip (small, ~500KB)
 *   2. Parse CSV, compute USD cross-rates via EUR/USD column
 *   3. Upsert into fx_rates with source='ecb'
 *   4. Idempotent on (currency_code, rate_date)
 *
 * Currencies on ECB (subset): USD, JPY, BGN, CZK, DKK, GBP, HUF, PLN,
 * RON, SEK, CHF, ISK, NOK, HRK, RUB, TRY, AUD, BRL, CAD, CNY, HKD,
 * IDR, ILS, INR, KRW, MXN, MYR, NZD, PHP, SGD, THB, ZAR.
 *
 * Run daily 17:00 UTC.
 */
```

`packages/db/src/ingest-fred-fx.ts` — daily worker:

```ts
/**
 * Fallback FX ingestion via FRED for currencies not on ECB:
 *   - DOP (Dominican Peso) — not on ECB; use FRED series
 *     'DEXBZUS' for example, or fall back to manual rate seed
 *   - JMD — same
 *   - GTQ, HNL, etc.
 *
 * For currencies on neither ECB nor FRED, manually seed a few key
 * rates (DOP/USD ≈ 60 throughout 2021-2026) as static defaults.
 * Mark these as source='manual' in fx_rates.
 *
 * Run daily 17:30 UTC, after ECB.
 */
```

**Pragmatic note:** FRED's coverage of LatAm and Caribbean currencies is patchy. For DOP, JMD, TTD specifically, Banco Central de la República Dominicana, Bank of Jamaica, and Central Bank of Trinidad publish daily rates. **For v1, hand-seed these three with monthly average rates from 2021-2026** as a static CSV — that's sufficient resolution for cross-year delta analysis. Build proper ingestion later if needed.

---

## 7. Query module

`packages/catalog/src/queries.ts` — add three functions:

### 7.1 `analyzeSupplierPricing`

```ts
export interface SupplierPricingAnalysis {
  supplierId: string;
  supplierName: string;
  totalAwardsAnalyzed: number;
  awardsWithDelta: number;     // not all awards resolve to a benchmark
  averageDeltaUsd: number;     // mean delta in USD/bbl (or unit)
  medianDeltaUsd: number;
  averageDeltaPct: number;     // mean delta as % over benchmark
  medianDeltaPct: number;
  stddevDeltaPct: number;
  /** Outliers: awards with |z-score| > 2 from this supplier's mean. */
  outlierAwards: Array<{
    awardId: string;
    awardDate: Date;
    deltaPct: number;
    zScore: number;
    direction: 'high' | 'low';
    title: string | null;
    confidence: number;
  }>;
  /** Time series: mean delta per quarter for trend visualization. */
  quarterlyDeltaTrend: Array<{
    quarter: string;     // 'YYYY-Q#'
    awardCount: number;
    meanDeltaPct: number;
  }>;
  /** Avg confidence across awards — caveats high-uncertainty results. */
  averageConfidence: number;
}

export async function analyzeSupplierPricing(
  supplierId: string,
  opts?: {
    minConfidence?: number;     // default 0.7
    yearsLookback?: number;     // default 5
    categoryFilter?: string;    // optional
  },
): Promise<SupplierPricingAnalysis>;
```

Implementation queries `award_price_deltas` filtered by `supplier_id` and confidence threshold, computes statistics. Quarterly trend aggregates into year-quarter buckets.

### 7.2 `analyzeBuyerPricing`

```ts
export interface BuyerPricingAnalysis {
  buyerName: string;
  buyerCountry: string;
  totalAwardsAnalyzed: number;
  awardsWithDelta: number;
  averageDeltaUsd: number;
  averageDeltaPct: number;
  medianDeltaPct: number;
  /** Per-supplier breakdown — who's giving this buyer good vs bad pricing. */
  perSupplierStats: Array<{
    supplierId: string;
    supplierName: string;
    awardCount: number;
    meanDeltaPct: number;
  }>;
  /** Outlier awards from this buyer's perspective. */
  outlierAwards: Array<{
    awardId: string;
    awardDate: Date;
    supplierName: string;
    deltaPct: number;
    direction: 'overpaid' | 'underpaid';
    title: string | null;
  }>;
  averageConfidence: number;
}

export async function analyzeBuyerPricing(
  buyerName: string,
  buyerCountry: string,
  opts?: {
    minConfidence?: number;
    yearsLookback?: number;
    categoryFilter?: string;
  },
): Promise<BuyerPricingAnalysis>;
```

### 7.3 `evaluateOfferAgainstHistory`

The key tool for using this analytics in conversation. Given a current offer, returns where it sits in the historical distribution.

```ts
export interface OfferEvaluationSpec {
  categoryTag: string;
  grade?: string;
  buyerCountry: string;          // target delivery country
  offeredPriceUsd: number;       // unit price
  offeredPriceUnit: string;      // 'USD/bbl', 'USD/L', 'USD/ton'
  /** When to evaluate against — defaults to today. */
  evaluationDate?: Date;
}

export interface OfferEvaluation {
  /** Resolved benchmark on evaluationDate. */
  benchmarkCode: string;
  benchmarkSpotUsd: number;
  benchmarkAdjustment: number;
  effectiveBenchmarkUsd: number;
  /** Offer relative to current spot. */
  offerDeltaUsd: number;
  offerDeltaPct: number;
  /** Historical context: what's the typical delta for this category × country? */
  historicalMeanDeltaPct: number;
  historicalMedianDeltaPct: number;
  historicalStddevDeltaPct: number;
  historicalSampleSize: number;
  /** Where does this offer sit in the historical distribution? */
  zScore: number;
  percentile: number;  // 0-100
  /** Verdict synthesis. */
  verdict: 'aggressive' | 'competitive' | 'fair' | 'high' | 'outlier_high';
  rationale: string;
}

export async function evaluateOfferAgainstHistory(
  spec: OfferEvaluationSpec,
): Promise<OfferEvaluation>;
```

The verdict synthesis logic:
- z-score ≤ -2: `'aggressive'` — supplier is pricing well below historical norm, likely competitive bid or distress sale
- -2 < z ≤ -0.5: `'competitive'` — better than typical
- -0.5 < z ≤ +0.5: `'fair'` — at historical norm
- +0.5 < z ≤ +2: `'high'` — above typical, worth negotiating
- z > +2: `'outlier_high'` — three sigmas over mean, likely sole-source or padded

---

## 8. Assistant tools

`packages/catalog/src/tools.ts` — add three:

### 8.1 `analyze_supplier_pricing`

```ts
export const analyzeSupplierPricingTool = defineTool({
  name: 'analyze_supplier_pricing',
  description:
    "Compute a supplier's historical pricing relative to public benchmarks. " +
    "Returns mean and median delta over benchmark spot price, distribution " +
    "stats, quarterly trend, and outlier awards. Use this when the user asks " +
    "'is supplier X pricing high' / 'how does X compare to market' / 'what's " +
    "X's typical premium'. The confidence score on results reflects how much " +
    "of the supplier's award data resolved cleanly to benchmarks — surface it " +
    "to the user when low. Powered entirely by free EIA/FRED/ECB data; not " +
    "as precise as Argus, but directionally correct for pattern detection.",
  kind: 'read',
  schema: z.object({
    supplierId: z.string().uuid().optional(),
    supplierName: z.string().optional(),
    minConfidence: z.number().min(0).max(1).default(0.7),
    yearsLookback: z.number().min(1).max(15).default(5),
    categoryFilter: z.string().optional(),
  }).refine(d => d.supplierId || d.supplierName, {
    message: 'Provide either supplierId or supplierName',
  }),
  handler: async (ctx, args) => {
    /* Resolve supplierName -> supplierId via supplier_aliases if needed,
       then call analyzeSupplierPricing. Return as structured. */
  },
});
```

### 8.2 `analyze_buyer_pricing`

```ts
export const analyzeBuyerPricingTool = defineTool({
  name: 'analyze_buyer_pricing',
  description:
    "Compute a public buyer's pricing patterns — are they getting good deals " +
    "or paying premiums? Returns per-supplier breakdown showing who gives " +
    "them best vs worst pricing, plus outlier awards (significantly over- " +
    "or under-paid relative to market). Use this when the user asks 'is " +
    "this agency overpaying' / 'who gives ministry X the best prices' / " +
    "'should we approach buyer Y'. Useful for outreach prioritization — a " +
    "buyer overpaying their incumbent is a warm opportunity for a competing " +
    "supplier offer.",
  kind: 'read',
  schema: z.object({
    buyerName: z.string(),
    buyerCountry: z.string().length(2),
    minConfidence: z.number().min(0).max(1).default(0.7),
    yearsLookback: z.number().min(1).max(15).default(5),
    categoryFilter: z.string().optional(),
  }),
  handler: async (ctx, args) => { /* call analyzeBuyerPricing */ },
});
```

### 8.3 `evaluate_offer_against_history`

```ts
export const evaluateOfferAgainstHistoryTool = defineTool({
  name: 'evaluate_offer_against_history',
  description:
    "Given a current supplier offer (commodity, price, target country), " +
    "evaluate where it sits in the historical distribution of public-procurement " +
    "deltas-vs-spot. Returns offer's z-score, percentile, and a verdict " +
    "(aggressive / competitive / fair / high / outlier_high) with rationale. " +
    "Use this when a user describes a supplier's offer and asks 'is this " +
    "competitive' / 'should I take this' / 'how does this compare'. ALWAYS " +
    "include the historicalSampleSize in the response narrative — small " +
    "samples (n<10) make the verdict unreliable.",
  kind: 'read',
  schema: z.object({
    categoryTag: z.string(),
    grade: z.string().optional(),
    buyerCountry: z.string().length(2),
    offeredPriceUsd: z.number().positive(),
    offeredPriceUnit: z.enum(['USD/bbl', 'USD/L', 'USD/ton', 'USD/gal', 'USD/MMBtu']),
    evaluationDate: z.string().date().optional(),  // ISO date
  }),
  handler: async (ctx, args) => { /* call evaluateOfferAgainstHistory */ },
});
```

---

## 9. System prompt additions

Add a new block to the assistant system prompt:

```
### Pricing analytics

You can analyze realized pricing in public procurement against benchmark
spot prices. The data is free-tier (EIA + FRED + ECB FX) so it covers
US benchmarks well, international less so. Always communicate confidence:

- analyze_supplier_pricing: surfaces a supplier's typical delta over
  benchmark + outlier awards. Use to answer "is X pricing high" /
  "how does X compare to market".

- analyze_buyer_pricing: surfaces a buyer's pricing patterns —
  per-supplier breakdown showing best vs worst. Use to answer
  "is agency Y overpaying" / "who gives them good prices".

- evaluate_offer_against_history: given a current offer, return its
  z-score and verdict against historical distribution. ALWAYS include
  sample size in the response — verdicts on n<10 are unreliable.

When the tool returns low overallConfidence (<0.7), say so explicitly.
The pricing data is empirical and directional, not precise. A "high"
verdict on small sample size means "worth investigating" not "definitely
overpriced". Don't oversell.

Use these tools alongside find_buyers_for_offer and analyze_supplier
for full deal context. Pricing analysis tells you where the market is;
the supplier graph tells you who plays in it.
```

---

## 10. Migration order

In a single Claude Code session executing this brief:

1. `0042_country_default_currencies.sql` (table + seed insert)
2. `0043_commodity_benchmark_mappings.sql` (table + seed insert)
3. `0044_fx_rates.sql` (table only)
4. `0045_award_price_deltas.sql` (materialized view + indexes)

Hand-author all four. Add journal entries.

**Note:** the existing intelligence-layers brief allocated 0039-0042. If those have already shipped, this brief starts at 0043. Adjust numbers to match repo state at execution time.

---

## 11. Definition of done

A reasonable Claude Code session ships when:

1. Three new schema files exist with relations() exports.
2. Migrations apply cleanly to a fresh Neon DB.
3. Both seed files (`country-default-currencies.csv`, `commodity-benchmark-mappings.csv`) exist and load via a one-shot script.
4. ECB FX ingestion worker runs successfully and populates fx_rates with at least 2021-2026 daily history for the 30 ECB currencies.
5. Manual test: pick a known DR award (DOP-denominated, NULL contract_value_usd), run `REFRESH MATERIALIZED VIEW award_price_deltas`, confirm a row exists for that award_id with non-null delta_usd and delta_pct.
6. Three query module functions exist in `packages/catalog/src/queries.ts`.
7. Three assistant tools registered.
8. System prompt updated.
9. Smoke test in chat: ask "evaluate this offer: 5,000 MT diesel CIF Caucedo at $0.85/L" — confirm `evaluate_offer_against_history` fires and returns a verdict with a rationale citing historical sample size.

---

## 12. What this brief deliberately doesn't do

- **No paid-data integration.** Argus, Kpler, OilPriceAPI paid tier — all explicitly out of scope. The existing `commodity_prices` table from the intelligence-layers brief uses only EIA/FRED free.
- **No grade-specific Mediterranean differentials.** Mediterranean diesel ≠ NY Harbor ULSD; we know that. The empirical Caribbean / EU / Asia premium is what `award_price_deltas` measures, and that *is* the analytical output.
- **No live spot prices.** Daily granularity only. Live (5-min) prices are a v2 upgrade requiring paid OilPriceAPI tier; not in scope here.
- **No predictive pricing model.** This is descriptive analytics on historical data. ML-based forecasting is v3+ once we have ~10K awards across 5+ years and demonstrable signal stability.
- **No buyer notification system.** When `evaluate_offer_against_history` returns 'aggressive' for an offer, we don't auto-notify candidate buyers. That's a propose-tool for v2.

---

## 13. The intelligence this unlocks

Concrete examples of what becomes possible once this ships:

**Example 1 — Sigma Petroleum diagnostic.**
Query: `analyze_supplier_pricing(supplier_name='Sigma Petroleum Corp')`
Expected output: Sigma's mean delta over NY Harbor ULSD across their 552 DR diesel awards. If it's, say, +28%, you know their typical Caribbean premium. If their newest awards are at +35%, they're getting more aggressive. If their oldest awards are at +20%, the market's moved.

**Example 2 — Outlier hunting.**
Query: `analyze_buyer_pricing(buyer_name='Programa Supérate', buyer_country='DO')`
Expected output: Per-supplier breakdown shows Coral pricing 18% over benchmark while three other suppliers in DR price diesel at 25%+ over benchmark. **Coral is giving Supérate a competitive deal** — useful intelligence about the relationship.

**Example 3 — Real-time offer evaluation.**
Mid-conversation, supplier offers 5,000 MT diesel CIF Caucedo at $0.85/L. Query: `evaluate_offer_against_history(category_tag='diesel', buyer_country='DO', offered_price_usd=0.85, offered_price_unit='USD/L')`.
Expected output: NY Harbor ULSD spot is currently $X, historical Caribbean diesel premium averages +25% (n=552), this offer is at +X%, z-score Y, verdict: `'competitive'` if z=-1, `'high'` if z=+1, etc. Sample size in the response so the LLM communicates confidence.

**Example 4 — Sole-source detection.**
Outlier awards with z-score > 2 are statistically anomalous — *significantly over the typical premium*. In jurisdictions with corruption issues, these are exactly the awards worth flagging. The materialized view computes this automatically; queries surface it.

---

End of brief.
