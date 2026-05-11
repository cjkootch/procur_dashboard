/**
 * Seed country list for FAS Open Data ingestion. Aligns with the
 * GAIN-extraction brief's Caribbean / LATAM focus
 * (`docs/gain-extraction-brief.md`).
 *
 * Resolution is done by NAME, not by code. FAS uses an internal code
 * system that doesn't match ISO-2 (and on /esr/countries doesn't
 * even line up between sub-APIs cleanly). Name matching is stable —
 * the resolver does case-insensitive + accent-folded comparison and
 * accepts a list of aliases per country.
 */

export interface FasSeedCountry {
  iso2: string;
  /** Canonical name (preferred form). */
  name: string;
  /** Alternative spellings / aliases the FAS API might use. */
  aliases: string[];
}

export const FAS_SEED_COUNTRIES: ReadonlyArray<FasSeedCountry> = [
  { iso2: 'VE', name: 'Venezuela',          aliases: ['Venezuela (Bolivarian Republic of)', 'Venezuela, Bolivarian Republic of'] },
  { iso2: 'JM', name: 'Jamaica',            aliases: [] },
  { iso2: 'DO', name: 'Dominican Republic', aliases: ['Dominican Rep'] },
  { iso2: 'TT', name: 'Trinidad and Tobago', aliases: ['Trinidad & Tobago'] },
  { iso2: 'GY', name: 'Guyana',             aliases: [] },
  { iso2: 'SR', name: 'Suriname',           aliases: [] },
  { iso2: 'HT', name: 'Haiti',              aliases: [] },
  { iso2: 'CO', name: 'Colombia',           aliases: [] },
  { iso2: 'PA', name: 'Panama',             aliases: [] },
  { iso2: 'CU', name: 'Cuba',               aliases: [] },
];

/** Normalize a country name for matching: lowercase, strip accents,
 *  collapse whitespace, strip common punctuation. */
export function normalizeCountryName(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip accents
    .toLowerCase()
    .replace(/[.,'"`]/g, '')
    .replace(/\band\b/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Resolve a seed entry against a list of FAS country records. Tries
 * the canonical name first, then each alias. Returns the matched
 * record (with whatever code shape FAS uses) or null on miss.
 *
 * The fas record shape varies across sub-APIs; this helper only
 * relies on a `countryName` field being present.
 */
export function resolveFasCountry<
  T extends { countryName?: string; name?: string },
>(records: T[], seed: FasSeedCountry): T | null {
  const wanted = new Set(
    [seed.name, ...seed.aliases].map(normalizeCountryName),
  );
  for (const r of records) {
    const recordName = r.countryName ?? r.name ?? '';
    if (wanted.has(normalizeCountryName(recordName))) return r;
  }
  return null;
}
