/**
 * Country → trade-region buckets used for ranking
 * `findSuppliersForTender` results by geographic relevance.
 *
 * Why this exists: a real chat trace asked the bot to source a Polish
 * (PL) strategic-reserve diesel tender. The bot called
 * find_suppliers_for_tender and got back five Honduran (HN) gas
 * stations as "candidate suppliers" — they were the most-recent
 * diesel awardees globally, ranked above any plausible NWE refiner
 * because no supplier had a buyer-country match (PL was empty in the
 * supplier graph). The fix is to add a "supplier in same trade region
 * as buyer" boost so the SQL ORDER BY can prefer regional fits even
 * when no exact-country match exists.
 *
 * Buckets are deliberately coarse (continent / sub-continent
 * granularity). Finer granularity would require harder ground truth
 * about commercial trade flows (e.g. is Spain a "Med" or "Atlantic"
 * supplier for a UK buyer?). The current buckets answer the most
 * common false-positive pattern — Latam supplier for an EU buyer,
 * West African supplier for a Caspian buyer, etc.
 */

export type TradeRegion =
  | 'north-america'
  | 'caribbean'
  | 'central-america'
  | 'south-america'
  | 'europe-west'
  | 'europe-east'
  | 'africa-north'
  | 'africa-west'
  | 'africa-east'
  | 'africa-south'
  | 'mideast'
  | 'caspian'
  | 'asia-south'
  | 'asia-east'
  | 'asia-southeast'
  | 'oceania'
  | 'russia';

/** ISO-2 → region. Countries not in this map return null from
 *  `tradeRegionForCountry`; they're treated as "region unknown" and
 *  bypassed by the boost (no demotion either). */
const COUNTRY_REGIONS: Record<string, TradeRegion> = {
  // North America
  US: 'north-america', CA: 'north-america', MX: 'north-america',

  // Caribbean
  CU: 'caribbean', DO: 'caribbean', JM: 'caribbean', HT: 'caribbean',
  PR: 'caribbean', BS: 'caribbean', BB: 'caribbean', TT: 'caribbean',
  AG: 'caribbean', LC: 'caribbean', VC: 'caribbean', GD: 'caribbean',
  KN: 'caribbean', DM: 'caribbean',

  // Central America
  HN: 'central-america', GT: 'central-america', NI: 'central-america',
  CR: 'central-america', PA: 'central-america', SV: 'central-america',
  BZ: 'central-america',

  // South America
  CO: 'south-america', VE: 'south-america', EC: 'south-america',
  PE: 'south-america', BO: 'south-america', BR: 'south-america',
  AR: 'south-america', CL: 'south-america', UY: 'south-america',
  PY: 'south-america', GY: 'south-america', SR: 'south-america',
  GF: 'south-america',

  // Europe — West (NW + Med + Central)
  GB: 'europe-west', IE: 'europe-west', FR: 'europe-west',
  DE: 'europe-west', NL: 'europe-west', BE: 'europe-west',
  LU: 'europe-west', DK: 'europe-west', NO: 'europe-west',
  SE: 'europe-west', FI: 'europe-west', IS: 'europe-west',
  ES: 'europe-west', PT: 'europe-west', IT: 'europe-west',
  GR: 'europe-west', MT: 'europe-west', CY: 'europe-west',
  AT: 'europe-west', CH: 'europe-west', LI: 'europe-west',
  PL: 'europe-west', CZ: 'europe-west', SK: 'europe-west',
  HU: 'europe-west', SI: 'europe-west', HR: 'europe-west',
  EE: 'europe-west', LV: 'europe-west', LT: 'europe-west',

  // Europe — East
  RO: 'europe-east', BG: 'europe-east', RS: 'europe-east',
  BA: 'europe-east', MK: 'europe-east', ME: 'europe-east',
  AL: 'europe-east', MD: 'europe-east', UA: 'europe-east',

  // Russia (separate bucket — historical Med/Baltic supplier; sanctions
  // regime makes EU trade flows discontinuous, but pre-2022 they
  // belong with europe-east. Keep separate so callers can include /
  // exclude based on policy.)
  RU: 'russia', BY: 'russia',

  // Africa — North
  MA: 'africa-north', DZ: 'africa-north', TN: 'africa-north',
  LY: 'africa-north', EG: 'africa-north', SD: 'africa-north',

  // Africa — West
  SN: 'africa-west', GM: 'africa-west', GN: 'africa-west',
  GW: 'africa-west', SL: 'africa-west', LR: 'africa-west',
  CI: 'africa-west', GH: 'africa-west', TG: 'africa-west',
  BJ: 'africa-west', NG: 'africa-west', CM: 'africa-west',
  GA: 'africa-west', CG: 'africa-west', CD: 'africa-west',
  AO: 'africa-west', ML: 'africa-west', BF: 'africa-west',
  NE: 'africa-west', TD: 'africa-west', MR: 'africa-west',
  GQ: 'africa-west', ST: 'africa-west', CV: 'africa-west',

  // Africa — East
  KE: 'africa-east', TZ: 'africa-east', UG: 'africa-east',
  RW: 'africa-east', BI: 'africa-east', ET: 'africa-east',
  SO: 'africa-east', DJ: 'africa-east', ER: 'africa-east',
  SS: 'africa-east', MG: 'africa-east', MW: 'africa-east',
  ZM: 'africa-east', ZW: 'africa-east',

  // Africa — South
  ZA: 'africa-south', NA: 'africa-south', BW: 'africa-south',
  LS: 'africa-south', SZ: 'africa-south', MZ: 'africa-south',

  // Middle East
  SA: 'mideast', AE: 'mideast', QA: 'mideast', KW: 'mideast',
  BH: 'mideast', OM: 'mideast', YE: 'mideast', IR: 'mideast',
  IQ: 'mideast', JO: 'mideast', IL: 'mideast', LB: 'mideast',
  SY: 'mideast', TR: 'mideast',

  // Caspian
  AZ: 'caspian', KZ: 'caspian', TM: 'caspian', UZ: 'caspian',
  KG: 'caspian', TJ: 'caspian', AM: 'caspian', GE: 'caspian',

  // Asia — South
  IN: 'asia-south', PK: 'asia-south', BD: 'asia-south',
  LK: 'asia-south', NP: 'asia-south', BT: 'asia-south',
  MV: 'asia-south', AF: 'asia-south',

  // Asia — East
  CN: 'asia-east', JP: 'asia-east', KR: 'asia-east',
  TW: 'asia-east', HK: 'asia-east', MN: 'asia-east',
  KP: 'asia-east', MO: 'asia-east',

  // Asia — Southeast
  SG: 'asia-southeast', MY: 'asia-southeast', ID: 'asia-southeast',
  TH: 'asia-southeast', VN: 'asia-southeast', PH: 'asia-southeast',
  MM: 'asia-southeast', KH: 'asia-southeast', LA: 'asia-southeast',
  BN: 'asia-southeast', TL: 'asia-southeast',

  // Oceania
  AU: 'oceania', NZ: 'oceania', PG: 'oceania', FJ: 'oceania',
  SB: 'oceania', VU: 'oceania', NC: 'oceania', PF: 'oceania',
};

/** Look up a country's trade region. Returns null when the country
 *  isn't in the map — caller treats null as "unknown" (no boost, no
 *  demotion). */
export function tradeRegionForCountry(iso2: string | null | undefined): TradeRegion | null {
  if (!iso2) return null;
  return COUNTRY_REGIONS[iso2.toUpperCase()] ?? null;
}

/** All countries in a given region. Used by `findSuppliersForTender`
 *  to add a region-match boost to its SQL ORDER BY. */
export function countriesInRegion(region: TradeRegion): string[] {
  return Object.entries(COUNTRY_REGIONS)
    .filter(([, r]) => r === region)
    .map(([iso2]) => iso2);
}
