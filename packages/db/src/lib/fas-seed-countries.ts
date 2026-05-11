/**
 * Seed country list for FAS Open Data ingestion. Aligns with the
 * GAIN-extraction brief's Caribbean / LATAM focus
 * (`docs/gain-extraction-brief.md`).
 *
 * FAS uses 2-char country codes that overlap with ISO-2 for most
 * countries but diverge for a few (most famously CH = China rather
 * than Switzerland). The mappings here were verified against
 * /api/esr/countries + /api/gats/countries on first ingest; the
 * fas_countries table is the live source of truth and these
 * constants are the starting filter set.
 */

export interface FasSeedCountry {
  iso2: string;
  name: string;
  /** FAS ESR country code (used by /api/esr/* endpoints). */
  esrCode: string;
  /** FAS GATS country code (used by /api/gats/* — includes UN ComTrade). */
  gatsCode: string;
}

export const FAS_SEED_COUNTRIES: ReadonlyArray<FasSeedCountry> = [
  { iso2: 'VE', name: 'Venezuela',         esrCode: 'VE', gatsCode: 'VE' },
  { iso2: 'JM', name: 'Jamaica',           esrCode: 'JM', gatsCode: 'JM' },
  { iso2: 'DO', name: 'Dominican Republic', esrCode: 'DO', gatsCode: 'DO' },
  { iso2: 'TT', name: 'Trinidad & Tobago', esrCode: 'TD', gatsCode: 'TD' },
  { iso2: 'GY', name: 'Guyana',            esrCode: 'GY', gatsCode: 'GY' },
  { iso2: 'SR', name: 'Suriname',          esrCode: 'SR', gatsCode: 'SR' },
  { iso2: 'HT', name: 'Haiti',             esrCode: 'HA', gatsCode: 'HA' },
  { iso2: 'CO', name: 'Colombia',          esrCode: 'CO', gatsCode: 'CO' },
  { iso2: 'PA', name: 'Panama',            esrCode: 'PA', gatsCode: 'PA' },
  { iso2: 'CU', name: 'Cuba',              esrCode: 'CU', gatsCode: 'CU' },
];
