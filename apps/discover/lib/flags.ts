/**
 * ISO 3166-1 alpha-2 country code → regional indicator flag emoji.
 * Works in any browser/OS that supports Unicode 6.0+ (which is everything modern).
 */
export function flagFor(countryCode: string | null | undefined): string {
  if (!countryCode || countryCode.length !== 2) return '🏳️';
  const base = 0x1f1e6; // REGIONAL INDICATOR SYMBOL LETTER A
  const code = countryCode.toUpperCase();
  const a = code.charCodeAt(0) - 0x41;
  const b = code.charCodeAt(1) - 0x41;
  if (a < 0 || a > 25 || b < 0 || b > 25) return '🏳️';
  return String.fromCodePoint(base + a, base + b);
}
