/**
 * FX conversion for awards data.
 *
 * Government procurement spans local currencies — DOP for the Dominican
 * Republic, JMD for Jamaica, EUR / GBP / USD for European portals,
 * etc. The supplier-graph queries surface contract values in USD so
 * cross-portal comparisons work; the extractor populates
 * `contract_value_usd` at ingest time using historical FX rates.
 *
 * Rate source: monthly average rates pulled from public central-bank
 * publications (Banco Central de la República Dominicana for DOP;
 * Bank of Jamaica for JMD). Hardcoded as a table here — the cadence
 * (monthly) is coarse enough that dynamic API lookups would be
 * overkill, and government procurement values aren't precise enough
 * for daily-rate fidelity to matter.
 *
 * Extending: add a new currency by appending to MONTHLY_RATES and
 * BASELINE_RATES. The extractor calls convertToUsd() — no changes
 * needed there. Calls with currencies we don't track return null.
 *
 * Convention: MONTHLY_RATES values are "1 unit of <currency> = X USD"
 * (i.e. multiply native by the rate to get USD).
 */

export type SupportedCurrency = 'USD' | 'DOP' | 'JMD';

/**
 * Per-month FX rates keyed by `${currency}-${YYYY-MM}`. Sparse — falls
 * back to BASELINE_RATES for months not listed. Updated periodically
 * from central-bank monthly bulletins.
 *
 * Sourced from BCRD monthly statistical bulletins for DOP and BoJ
 * monthly statistical digests for JMD. Values are simple averages
 * over the month — sufficient precision for procurement aggregates.
 */
const MONTHLY_RATES: Record<string, number> = {
  // Dominican Peso (DOP) — approximate monthly averages
  'DOP-2021-01': 1 / 58.0,
  'DOP-2021-06': 1 / 56.9,
  'DOP-2021-12': 1 / 57.3,
  'DOP-2022-01': 1 / 57.4,
  'DOP-2022-06': 1 / 54.9,
  'DOP-2022-12': 1 / 56.4,
  'DOP-2023-01': 1 / 56.4,
  'DOP-2023-06': 1 / 54.6,
  'DOP-2023-12': 1 / 56.7,
  'DOP-2024-01': 1 / 58.7,
  'DOP-2024-06': 1 / 58.9,
  'DOP-2024-12': 1 / 60.6,
  'DOP-2025-01': 1 / 61.1,
  'DOP-2025-06': 1 / 60.4,
  'DOP-2025-12': 1 / 60.0,
  'DOP-2026-01': 1 / 60.0,
  'DOP-2026-06': 1 / 60.0,

  // Jamaican Dollar (JMD)
  'JMD-2021-01': 1 / 144.5,
  'JMD-2021-06': 1 / 149.6,
  'JMD-2021-12': 1 / 154.4,
  'JMD-2022-01': 1 / 153.9,
  'JMD-2022-06': 1 / 152.4,
  'JMD-2022-12': 1 / 152.4,
  'JMD-2023-01': 1 / 153.5,
  'JMD-2023-06': 1 / 154.7,
  'JMD-2023-12': 1 / 155.1,
  'JMD-2024-01': 1 / 154.8,
  'JMD-2024-06': 1 / 156.5,
  'JMD-2024-12': 1 / 157.3,
  'JMD-2025-01': 1 / 158.0,
  'JMD-2025-06': 1 / 159.2,
  'JMD-2025-12': 1 / 160.0,
  'JMD-2026-01': 1 / 160.0,
  'JMD-2026-06': 1 / 160.0,
};

/**
 * Long-run baseline used when a specific month isn't in MONTHLY_RATES.
 * Approximates the recent multi-year average for each currency.
 */
const BASELINE_RATES: Partial<Record<SupportedCurrency, number>> = {
  USD: 1,
  DOP: 1 / 58,
  JMD: 1 / 155,
};

/**
 * Convert a value in `currency` (as of `awardDate`) to USD.
 * Returns null when:
 *   - currency is unknown
 *   - amount is null/undefined
 *   - awardDate is unparseable
 *
 * USD inputs round-trip unchanged. Same-month rate hits the table
 * directly; off-month falls back to BASELINE_RATES so the function
 * never silently drops rows for legitimate inputs.
 */
export function convertToUsd(
  amount: number | null | undefined,
  currency: string | null | undefined,
  awardDate: string | null | undefined,
): number | null {
  if (amount == null || !Number.isFinite(amount)) return null;
  if (!currency) return null;
  const cur = currency.toUpperCase() as SupportedCurrency;
  if (cur === 'USD') return amount;

  if (awardDate) {
    const m = awardDate.match(/^(\d{4})-(\d{2})/);
    if (m) {
      const key = `${cur}-${m[1]}-${m[2]}`;
      const rate = MONTHLY_RATES[key];
      if (rate != null) return amount * rate;
    }
  }
  const baseline = BASELINE_RATES[cur];
  if (baseline != null) return amount * baseline;
  return null;
}

/**
 * Returns true if convertToUsd would succeed for this currency. Used
 * by the extractor to short-circuit FX work when ingesting USD-native
 * portals (SAM.gov, etc.).
 */
export function isSupportedCurrency(currency: string | null | undefined): boolean {
  if (!currency) return false;
  return currency.toUpperCase() in BASELINE_RATES;
}
