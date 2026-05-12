/**
 * Country centroids for the map fallback at `/suppliers/known-entities`.
 *
 * When an entity has no lat/lng (Nominatim geocoding missed, or the
 * source wasn't a physical asset), we render an "approximate" marker
 * at the country centroid so the entity stays visible on the map
 * rather than silently disappearing. The marker style differs from
 * geocoded pins (see MapView.tsx) so the operator can tell at a
 * glance which entities have precise locations vs. country-only.
 *
 * Scope: FAS seed list + neighboring Caribbean / LATAM countries that
 * commonly appear as origins or co-counterparties. Extend when new
 * countries surface in the rolodex.
 *
 * Source: country geographic centers from publicly-available
 * cartographic data (CIA World Factbook + Natural Earth). Rounded to
 * 2 decimals — precision past that is meaningless at country scale.
 */

export interface Centroid {
  latitude: number;
  longitude: number;
}

export const COUNTRY_CENTROIDS: Record<string, Centroid> = {
  // FAS seed list
  VE: { latitude: 8.0, longitude: -66.0 }, // Venezuela
  JM: { latitude: 18.11, longitude: -77.3 }, // Jamaica
  DO: { latitude: 18.74, longitude: -70.16 }, // Dominican Republic
  TT: { latitude: 10.69, longitude: -61.22 }, // Trinidad and Tobago
  GY: { latitude: 4.86, longitude: -58.93 }, // Guyana
  SR: { latitude: 3.92, longitude: -56.03 }, // Suriname
  HT: { latitude: 18.97, longitude: -72.29 }, // Haiti
  CO: { latitude: 4.57, longitude: -74.3 }, // Colombia
  PA: { latitude: 8.54, longitude: -80.78 }, // Panama
  CU: { latitude: 21.52, longitude: -77.78 }, // Cuba
  // Other Caribbean (CDB mandate countries + frequent co-counterparties)
  BS: { latitude: 25.03, longitude: -77.4 }, // Bahamas
  BB: { latitude: 13.19, longitude: -59.54 }, // Barbados
  AG: { latitude: 17.06, longitude: -61.8 }, // Antigua and Barbuda
  GD: { latitude: 12.12, longitude: -61.68 }, // Grenada
  DM: { latitude: 15.42, longitude: -61.37 }, // Dominica
  KN: { latitude: 17.36, longitude: -62.78 }, // St Kitts and Nevis
  LC: { latitude: 13.91, longitude: -60.98 }, // St Lucia
  VC: { latitude: 12.98, longitude: -61.29 }, // St Vincent and the Grenadines
  BZ: { latitude: 17.19, longitude: -88.49 }, // Belize
  AI: { latitude: 18.22, longitude: -63.07 }, // Anguilla
  MS: { latitude: 16.74, longitude: -62.19 }, // Montserrat
  KY: { latitude: 19.31, longitude: -81.25 }, // Cayman Islands
  TC: { latitude: 21.69, longitude: -71.8 }, // Turks and Caicos
  VG: { latitude: 18.43, longitude: -64.62 }, // British Virgin Islands
  // LATAM neighbors that commonly appear as origin / partner countries
  MX: { latitude: 23.63, longitude: -102.55 }, // Mexico
  BR: { latitude: -14.24, longitude: -51.93 }, // Brazil
  AR: { latitude: -38.42, longitude: -63.62 }, // Argentina
  CL: { latitude: -35.68, longitude: -71.54 }, // Chile
  EC: { latitude: -1.83, longitude: -78.18 }, // Ecuador
  PE: { latitude: -9.19, longitude: -75.02 }, // Peru
  UY: { latitude: -32.52, longitude: -55.77 }, // Uruguay
  PY: { latitude: -23.44, longitude: -58.44 }, // Paraguay
  BO: { latitude: -16.29, longitude: -63.59 }, // Bolivia
  CR: { latitude: 9.75, longitude: -83.75 }, // Costa Rica
  NI: { latitude: 12.87, longitude: -85.21 }, // Nicaragua
  HN: { latitude: 15.2, longitude: -86.24 }, // Honduras
  SV: { latitude: 13.79, longitude: -88.9 }, // El Salvador
  GT: { latitude: 15.78, longitude: -90.23 }, // Guatemala
  // Global trade-partner anchors (US is the biggest origin in FAS / MDB data)
  US: { latitude: 39.5, longitude: -98.35 },
  CA: { latitude: 56.13, longitude: -106.35 },
  GB: { latitude: 55.38, longitude: -3.44 },
  ES: { latitude: 40.46, longitude: -3.75 },
  PT: { latitude: 39.4, longitude: -8.22 },
  NL: { latitude: 52.13, longitude: 5.29 },
  DE: { latitude: 51.17, longitude: 10.45 },
  CN: { latitude: 35.86, longitude: 104.2 },
  IN: { latitude: 20.59, longitude: 78.96 },
  RU: { latitude: 61.52, longitude: 105.32 },
  NG: { latitude: 9.08, longitude: 8.68 },
  LY: { latitude: 26.34, longitude: 17.23 },
  DZ: { latitude: 28.03, longitude: 1.66 },
  AE: { latitude: 23.42, longitude: 53.85 },
  SA: { latitude: 23.89, longitude: 45.08 },
  ZA: { latitude: -30.56, longitude: 22.94 },
  AU: { latitude: -25.27, longitude: 133.78 },
};

export function lookupCountryCentroid(iso2: string | null | undefined): Centroid | null {
  if (!iso2) return null;
  return COUNTRY_CENTROIDS[iso2.toUpperCase()] ?? null;
}
