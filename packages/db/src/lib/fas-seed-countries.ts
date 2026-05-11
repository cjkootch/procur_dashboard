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
  /** GENC alpha-3. FAS publishes gencCode in the 3-letter form for
   *  most countries, so this is the primary join key. */
  genc3: string;
  /** Canonical name (preferred form). */
  name: string;
  /** Alternative spellings / aliases the FAS API might use. FAS often
   *  truncates names ("TRINID", "COLOMB", "VENEZ", "SURINAM"); these
   *  aliases catch them when gencCode is null (territories, historical
   *  entries — Suriname is a known case). */
  aliases: string[];
}

export const FAS_SEED_COUNTRIES: ReadonlyArray<FasSeedCountry> = [
  { iso2: 'VE', genc3: 'VEN', name: 'Venezuela',          aliases: ['Venezuela (Bolivarian Republic of)', 'VENEZ'] },
  { iso2: 'JM', genc3: 'JAM', name: 'Jamaica',            aliases: [] },
  { iso2: 'DO', genc3: 'DOM', name: 'Dominican Republic', aliases: ['Dominican Rep', 'Dom Rep', 'DOM REP', 'DOMINI REP', 'DR'] },
  { iso2: 'TT', genc3: 'TTO', name: 'Trinidad and Tobago', aliases: ['Trinidad & Tobago', 'TRINID', 'TRIN', 'TRIN & TOB'] },
  { iso2: 'GY', genc3: 'GUY', name: 'Guyana',             aliases: [] },
  { iso2: 'SR', genc3: 'SUR', name: 'Suriname',           aliases: ['SURINAM', 'Surinam'] },
  { iso2: 'HT', genc3: 'HTI', name: 'Haiti',              aliases: [] },
  { iso2: 'CO', genc3: 'COL', name: 'Colombia',           aliases: ['COLOMB'] },
  { iso2: 'PA', genc3: 'PAN', name: 'Panama',             aliases: [] },
  { iso2: 'CU', genc3: 'CUB', name: 'Cuba',               aliases: [] },
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
 * Resolve a seed entry against a list of FAS country records.
 *
 * Resolution order, falling through on miss:
 *   1. gencCode === seed.genc3   (FAS publishes 3-letter GENC codes —
 *      TTO, COL, VEN — for most sovereign entries, this is the
 *      stable join key with zero alias maintenance)
 *   2. gencCode === seed.iso2    (defensive: in case FAS ever switches
 *      sub-API to publish 2-letter GENC, or for entries that happen
 *      to use 2-letter)
 *   3. Name + alias match        (catches records where gencCode is
 *      null — Suriname is a known case; FAS also truncates names like
 *      "VENEZ", "TRINID", "SURINAM" so aliases handle those)
 */
export function resolveFasCountry<
  T extends {
    countryName?: string;
    name?: string;
    gencCode?: string | null;
  },
>(records: T[], seed: FasSeedCountry): T | null {
  const seedGenc3 = seed.genc3.toUpperCase();
  const seedIso2 = seed.iso2.toUpperCase();
  for (const r of records) {
    const g = r.gencCode?.toUpperCase();
    if (g && (g === seedGenc3 || g === seedIso2)) return r;
  }
  // Name fallback for records without gencCode (or with stale ones).
  const wanted = new Set(
    [seed.name, ...seed.aliases].map(normalizeCountryName),
  );
  for (const r of records) {
    const recordName = r.countryName ?? r.name ?? '';
    if (wanted.has(normalizeCountryName(recordName))) return r;
  }
  return null;
}
