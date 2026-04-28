/**
 * Maps fuel `ProductType` codes to the procur benchmark series we
 * actually ingest into `commodity_prices`. Plus an async lookup that
 * resolves a benchmark price for a given product on a given date.
 *
 * Note: vex's calculator originally targeted Platts USGC slugs
 * (`platts_usgc_ulsd`, …). We don't have a Platts feed — procur ingests
 * FRED (Brent/WTI) and EIA NY Harbor refined-product spot. The basis
 * differential between USGC and NYH for ULSD is typically 1–3¢/gal and
 * is something we may want to model later as a separate adjustment.
 *
 * Unit handling: `commodity_prices.unit` is 'usd-gal' for refined and
 * 'usd-bbl' for crude. We always normalise to per-USG and per-bbl in
 * the response. Per-MT requires the product's density (kg/L) and is
 * left to the caller — see `usgToMt` in `./domain`.
 */
import 'server-only';

import { and, desc, eq, lte } from 'drizzle-orm';
import { commodityPrices, type Db } from '@procur/db';

import { ProductType, USG_PER_BBL, type ProductType as Product } from './domain.js';

export type BenchmarkSource = 'fred' | 'eia';

export type BenchmarkRef = {
  /** `commodity_prices.series_slug`. */
  slug: string;
  /** `commodity_prices.source`. */
  source: BenchmarkSource;
  /** Native unit on the price feed. */
  nativeUnit: 'usd-gal' | 'usd-bbl';
};

/**
 * Pure mapping from a fuel product code to the procur benchmark series.
 * Returns `null` for products we don't yet have a price feed for
 * (jet, hfo, lng, lpg, food line).
 */
export function benchmarkFor(product: Product): BenchmarkRef | null {
  switch (product) {
    case ProductType.Ulsd:
      return { slug: 'nyh-diesel', source: 'eia', nativeUnit: 'usd-gal' };
    case ProductType.Gasoline87:
    case ProductType.Gasoline91:
      return { slug: 'nyh-gasoline', source: 'eia', nativeUnit: 'usd-gal' };
    case ProductType.Lfo:
      return { slug: 'nyh-heating-oil', source: 'eia', nativeUnit: 'usd-gal' };
    // No published spot for: jet, avgas, hfo, lng, lpg, biodiesel, food.
    // Caller falls back to a user-supplied or comparable-award price.
    default:
      return null;
  }
}

export type BenchmarkPrice = {
  product: Product;
  benchmark: BenchmarkRef;
  /** The actual `price_date` we used (≤ requested asOf). */
  asOf: string;
  pricePerUsg: number;
  pricePerBbl: number;
};

/**
 * Resolve the latest benchmark price for `product` on or before `asOf`.
 * Returns `null` when:
 *   - no benchmark mapping exists for the product, or
 *   - no price observation exists on or before `asOf`.
 *
 * "On or before" handles weekends/holidays (markets closed) by rolling
 * to the most recent trading day.
 */
export async function getBenchmarkPrice(
  db: Db,
  product: Product,
  asOf: Date | string,
): Promise<BenchmarkPrice | null> {
  const ref = benchmarkFor(product);
  if (!ref) return null;

  const asOfStr = typeof asOf === 'string' ? asOf : asOf.toISOString().slice(0, 10);

  const [row] = await db
    .select({
      priceDate: commodityPrices.priceDate,
      price: commodityPrices.price,
      unit: commodityPrices.unit,
    })
    .from(commodityPrices)
    .where(
      and(
        eq(commodityPrices.seriesSlug, ref.slug),
        eq(commodityPrices.contractType, 'spot'),
        lte(commodityPrices.priceDate, asOfStr),
      ),
    )
    .orderBy(desc(commodityPrices.priceDate))
    .limit(1);

  if (!row) return null;

  const price = Number(row.price);
  const { pricePerUsg, pricePerBbl } = normaliseUnits(price, row.unit);

  return {
    product,
    benchmark: ref,
    asOf: row.priceDate,
    pricePerUsg,
    pricePerBbl,
  };
}

function normaliseUnits(
  price: number,
  unit: string,
): { pricePerUsg: number; pricePerBbl: number } {
  if (unit === 'usd-gal') {
    return { pricePerUsg: price, pricePerBbl: price * USG_PER_BBL };
  }
  if (unit === 'usd-bbl') {
    return { pricePerUsg: price / USG_PER_BBL, pricePerBbl: price };
  }
  // 'usd-mt' would require a density and is not currently ingested.
  throw new Error(`Unsupported commodity_prices.unit for benchmark lookup: ${unit}`);
}
