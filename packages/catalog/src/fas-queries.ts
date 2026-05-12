import 'server-only';
import { db } from '@procur/db';
import { sql } from 'drizzle-orm';

/**
 * Catalog queries over the FAS Open Data tables (ingested via the
 * @procur/db scripts ingest-fas-esr + ingest-fas-un-comtrade).
 *
 * These helpers feed the lookup_fas_esr_exports +
 * lookup_fas_un_comtrade_partners chat tools. Country resolution uses
 * `fas_countries.iso2` to translate operator-facing ISO-2 input into
 * FAS's internal numeric country code at query time.
 *
 * Source: docs/gain-extraction-brief.md companion data layer.
 */

// ─── ESR weekly export rollup ────────────────────────────────────────

export interface FasEsrRecentExportRow {
  commodityCode: number;
  commodityName: string;
  /** Sum of weekly_exports over the lookback window (physical units —
   *  varies by commodity; see uomId on raw rows for the unit). */
  totalWeeklyExports: number | null;
  /** Most recent week's accumulated_exports_market_yr — running
   *  marketing-year total at the lookback's end. */
  latestAccumulatedExports: number | null;
  /** Most recent week's outstanding sales — open commitments not yet
   *  shipped. Operationally: what's in the pipeline. */
  latestOutstandingSales: number | null;
  weeksObserved: number;
  mostRecentWeek: string;
  marketYears: number[];
}

export async function getFasEsrRecentExportsForCountry(
  iso2: string,
  options: {
    commodityCode?: number;
    weeksLookback?: number;
    limit?: number;
  } = {},
): Promise<FasEsrRecentExportRow[]> {
  const weeks = options.weeksLookback ?? 26;
  const limit = options.limit ?? 25;
  const result = await db.execute(sql`
    WITH country_codes AS (
      SELECT fas_code FROM fas_countries
       WHERE api = 'esr' AND UPPER(iso2) = UPPER(${iso2})
    ),
    recent AS (
      SELECT w.*
        FROM fas_esr_weekly w
        JOIN country_codes cc ON cc.fas_code = w.country_code
       WHERE w.week_ending_date >= (NOW() - (${weeks}::int || ' weeks')::interval)::date
         ${options.commodityCode != null ? sql`AND w.commodity_code = ${options.commodityCode}` : sql``}
    ),
    latest_per_commodity AS (
      SELECT DISTINCT ON (commodity_code)
        commodity_code,
        accumulated_exports_market_yr,
        outstanding_sales,
        week_ending_date AS latest_week
        FROM recent
       ORDER BY commodity_code, week_ending_date DESC
    )
    SELECT
      r.commodity_code,
      c.commodity_name,
      SUM(r.weekly_exports)::numeric         AS total_weekly_exports,
      l.accumulated_exports_market_yr        AS latest_accumulated,
      l.outstanding_sales                    AS latest_outstanding,
      COUNT(DISTINCT r.week_ending_date)::int AS weeks_observed,
      MAX(r.week_ending_date)                AS most_recent_week,
      ARRAY_AGG(DISTINCT r.market_year ORDER BY r.market_year DESC) AS market_years
    FROM recent r
    LEFT JOIN latest_per_commodity l ON l.commodity_code = r.commodity_code
    LEFT JOIN fas_commodities c
      ON c.commodity_code = r.commodity_code AND c.api = 'esr'
    GROUP BY r.commodity_code, c.commodity_name,
             l.accumulated_exports_market_yr, l.outstanding_sales
    ORDER BY SUM(r.weekly_exports) DESC NULLS LAST
    LIMIT ${limit};
  `);
  return (result.rows as Array<Record<string, unknown>>).map((r) => ({
    commodityCode: Number(r.commodity_code),
    commodityName: String(r.commodity_name ?? `commodity ${r.commodity_code}`),
    totalWeeklyExports:
      r.total_weekly_exports != null
        ? Number.parseFloat(String(r.total_weekly_exports))
        : null,
    latestAccumulatedExports:
      r.latest_accumulated != null
        ? Number.parseFloat(String(r.latest_accumulated))
        : null,
    latestOutstandingSales:
      r.latest_outstanding != null
        ? Number.parseFloat(String(r.latest_outstanding))
        : null,
    weeksObserved: Number(r.weeks_observed ?? 0),
    mostRecentWeek:
      r.most_recent_week instanceof Date
        ? r.most_recent_week.toISOString().slice(0, 10)
        : String(r.most_recent_week).slice(0, 10),
    marketYears: Array.isArray(r.market_years)
      ? (r.market_years as unknown[]).map((y) => Number(y))
      : [],
  }));
}

// ─── UN ComTrade partner rollup ──────────────────────────────────────

export interface FasUNComtradePartnerRow {
  partnerCountry: string;
  /** Total annual value in USD across the lookback window. */
  totalValueUsd: number | null;
  /** Total net mass in kg across the lookback window (often null for
   *  some HS codes — UN ComTrade reports value more reliably than
   *  mass). */
  totalQuantityKg: number | null;
  yearsObserved: number;
  mostRecentYear: number;
  productCode: string;
}

export async function getFasUNComtradePartnersForCountry(
  iso2: string,
  options: {
    productCode?: string;
    direction?: 'import' | 'export';
    yearsLookback?: number;
    limit?: number;
  } = {},
): Promise<FasUNComtradePartnerRow[]> {
  const yearsBack = options.yearsLookback ?? 5;
  const direction = options.direction ?? 'import';
  const limit = options.limit ?? 25;
  const result = await db.execute(sql`
    SELECT
      partner_country,
      product_code,
      SUM(value_usd)                  AS total_value_usd,
      SUM(quantity_kg)                AS total_quantity_kg,
      COUNT(DISTINCT period)::int     AS years_observed,
      EXTRACT(YEAR FROM MAX(period))::int AS most_recent_year
    FROM customs_imports
    WHERE source = 'fas-un-comtrade'
      AND UPPER(reporter_country) = UPPER(${iso2})
      AND flow_direction = ${direction}
      AND period >= (NOW() - (${yearsBack}::int || ' years')::interval)::date
      ${options.productCode != null ? sql`AND product_code = ${options.productCode}` : sql``}
    GROUP BY partner_country, product_code
    ORDER BY SUM(value_usd) DESC NULLS LAST
    LIMIT ${limit};
  `);
  return (result.rows as Array<Record<string, unknown>>).map((r) => ({
    partnerCountry: String(r.partner_country),
    totalValueUsd:
      r.total_value_usd != null
        ? Number.parseFloat(String(r.total_value_usd))
        : null,
    totalQuantityKg:
      r.total_quantity_kg != null
        ? Number.parseFloat(String(r.total_quantity_kg))
        : null,
    yearsObserved: Number(r.years_observed ?? 0),
    mostRecentYear: Number(r.most_recent_year ?? 0),
    productCode: String(r.product_code),
  }));
}
