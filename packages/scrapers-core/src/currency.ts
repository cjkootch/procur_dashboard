/**
 * Approximate FX rates against USD. Coarse — fine for surfacing tender
 * value order-of-magnitude and filter ranges. For precise accounting we
 * should later replace this with a daily-refreshed rates table keyed on
 * the opportunity's publishedAt date.
 *
 * Last manually refreshed: 2026-04 · source: typical published rates.
 */
const USD_RATES: Record<string, number> = {
  USD: 1,
  // Caribbean
  JMD: 0.0065, // Jamaican Dollar
  GYD: 0.00478, // Guyanese Dollar
  TTD: 0.147, // Trinidad & Tobago Dollar
  BBD: 0.5, // Barbadian Dollar (fixed 2:1)
  BSD: 1, // Bahamian Dollar (fixed 1:1)
  DOP: 0.0165, // Dominican Peso
  XCD: 0.37, // East Caribbean Dollar (fixed)
  // LatAm
  COP: 0.00025, // Colombian Peso
  PEN: 0.27, // Peruvian Sol
  BRL: 0.2, // Brazilian Real
  MXN: 0.058, // Mexican Peso
  // Africa
  KES: 0.0077, // Kenyan Shilling
  GHS: 0.067, // Ghanaian Cedi
  RWF: 0.00072, // Rwandan Franc
  ZAR: 0.055, // South African Rand
  NGN: 0.00066, // Nigerian Naira
  // Multilateral
  EUR: 1.08,
  GBP: 1.27,
};

const DIGITS_ONLY = /[^0-9.,-]/g;

export function parseMoney(input: string | number | null | undefined): number | null {
  if (input == null) return null;
  if (typeof input === 'number') return Number.isFinite(input) ? input : null;

  const cleaned = input.replace(DIGITS_ONLY, '').trim();
  if (!cleaned) return null;

  // Heuristic: if we see a comma before a dot, comma is thousands; otherwise
  // comma is decimal (LatAm / Caribbean French conventions).
  let normalized = cleaned;
  const lastDot = cleaned.lastIndexOf('.');
  const lastComma = cleaned.lastIndexOf(',');
  if (lastComma > lastDot) {
    normalized = cleaned.replace(/\./g, '').replace(',', '.');
  } else {
    normalized = cleaned.replace(/,/g, '');
  }

  const n = Number.parseFloat(normalized);
  return Number.isFinite(n) ? n : null;
}

export function toUsd(amount: number, currency: string | null | undefined): number | null {
  if (!Number.isFinite(amount)) return null;
  const code = (currency ?? 'USD').toUpperCase();
  const rate = USD_RATES[code];
  if (!rate) return null;
  return amount * rate;
}
