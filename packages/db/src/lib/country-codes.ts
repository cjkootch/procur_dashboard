/**
 * UN M49 numeric country codes ↔ ISO 3166-1 alpha-2 mapping.
 *
 * Used by the UN Comtrade ingest (which publishes data keyed by M49)
 * to land rows under the same ISO-2 reporter codes Eurostat uses.
 * Without this mapping, Italy-from-Eurostat (`IT`) and Italy-from-
 * Comtrade (`380`) would be different rows in `customs_imports` and
 * the cross-source dedup queries would silently fail.
 *
 * Coverage: ~120 countries with material trade volume in petroleum +
 * food + metals. The full M49 list is ~250 codes; missing rows from
 * the ingest fall back to the M49 numeric string (logged so we can
 * extend this table when something useful drops).
 *
 * Sourced from the ISO + UN crosswalk; verify against
 * https://unstats.un.org/unsd/methodology/m49/ if extending.
 */

/** UN M49 numeric → ISO-3166-1 alpha-2. */
export const M49_TO_ISO2: Record<string, string> = {
  // Africa
  '012': 'DZ', // Algeria
  '024': 'AO', // Angola
  '072': 'BW', // Botswana
  '108': 'BI', // Burundi
  '120': 'CM', // Cameroon
  '180': 'CD', // DR Congo
  '178': 'CG', // Congo
  '262': 'DJ', // Djibouti
  '818': 'EG', // Egypt
  '226': 'GQ', // Equatorial Guinea
  '231': 'ET', // Ethiopia
  '288': 'GH', // Ghana
  '404': 'KE', // Kenya
  '434': 'LY', // Libya
  '450': 'MG', // Madagascar
  '454': 'MW', // Malawi
  '480': 'MU', // Mauritius
  '504': 'MA', // Morocco
  '508': 'MZ', // Mozambique
  '566': 'NG', // Nigeria
  '710': 'ZA', // South Africa
  '728': 'SS', // South Sudan
  '729': 'SD', // Sudan
  '834': 'TZ', // Tanzania
  '788': 'TN', // Tunisia
  '800': 'UG', // Uganda
  '894': 'ZM', // Zambia
  '716': 'ZW', // Zimbabwe
  '384': 'CI', // Côte d'Ivoire
  '686': 'SN', // Senegal

  // Americas
  '032': 'AR', // Argentina
  '068': 'BO', // Bolivia
  '076': 'BR', // Brazil
  '124': 'CA', // Canada
  '152': 'CL', // Chile
  '170': 'CO', // Colombia
  '188': 'CR', // Costa Rica
  '192': 'CU', // Cuba
  '214': 'DO', // Dominican Republic
  '218': 'EC', // Ecuador
  '222': 'SV', // El Salvador
  '320': 'GT', // Guatemala
  '328': 'GY', // Guyana
  '332': 'HT', // Haiti
  '340': 'HN', // Honduras
  '388': 'JM', // Jamaica
  '484': 'MX', // Mexico
  '558': 'NI', // Nicaragua
  '591': 'PA', // Panama
  '600': 'PY', // Paraguay
  '604': 'PE', // Peru
  '780': 'TT', // Trinidad & Tobago
  '858': 'UY', // Uruguay
  '840': 'US', // United States
  '862': 'VE', // Venezuela

  // Europe
  '008': 'AL', // Albania
  '040': 'AT', // Austria
  '056': 'BE', // Belgium
  '100': 'BG', // Bulgaria
  '191': 'HR', // Croatia
  '196': 'CY', // Cyprus
  '203': 'CZ', // Czechia
  '208': 'DK', // Denmark
  '233': 'EE', // Estonia
  '246': 'FI', // Finland
  '250': 'FR', // France
  '276': 'DE', // Germany
  '300': 'GR', // Greece
  '348': 'HU', // Hungary
  '352': 'IS', // Iceland
  '372': 'IE', // Ireland
  '380': 'IT', // Italy
  '428': 'LV', // Latvia
  '440': 'LT', // Lithuania
  '442': 'LU', // Luxembourg
  '470': 'MT', // Malta
  '498': 'MD', // Moldova
  '528': 'NL', // Netherlands
  '578': 'NO', // Norway
  '616': 'PL', // Poland
  '620': 'PT', // Portugal
  '642': 'RO', // Romania
  '643': 'RU', // Russia
  '688': 'RS', // Serbia
  '703': 'SK', // Slovakia
  '705': 'SI', // Slovenia
  '724': 'ES', // Spain
  '752': 'SE', // Sweden
  '756': 'CH', // Switzerland
  '792': 'TR', // Turkey
  '804': 'UA', // Ukraine
  '826': 'GB', // United Kingdom

  // Asia
  '004': 'AF', // Afghanistan
  '050': 'BD', // Bangladesh
  '064': 'BT', // Bhutan
  '096': 'BN', // Brunei
  '116': 'KH', // Cambodia
  '156': 'CN', // China
  '344': 'HK', // Hong Kong
  '356': 'IN', // India
  '360': 'ID', // Indonesia
  '364': 'IR', // Iran
  '368': 'IQ', // Iraq
  '376': 'IL', // Israel
  '392': 'JP', // Japan
  '400': 'JO', // Jordan
  '398': 'KZ', // Kazakhstan
  '410': 'KR', // South Korea
  '414': 'KW', // Kuwait
  '417': 'KG', // Kyrgyzstan
  '418': 'LA', // Laos
  '422': 'LB', // Lebanon
  '458': 'MY', // Malaysia
  '462': 'MV', // Maldives
  '496': 'MN', // Mongolia
  '104': 'MM', // Myanmar
  '524': 'NP', // Nepal
  '512': 'OM', // Oman
  '586': 'PK', // Pakistan
  '608': 'PH', // Philippines
  '634': 'QA', // Qatar
  '682': 'SA', // Saudi Arabia
  '702': 'SG', // Singapore
  '144': 'LK', // Sri Lanka
  '760': 'SY', // Syria
  '158': 'TW', // Taiwan
  '762': 'TJ', // Tajikistan
  '764': 'TH', // Thailand
  '795': 'TM', // Turkmenistan
  '784': 'AE', // UAE
  '860': 'UZ', // Uzbekistan
  '704': 'VN', // Vietnam
  '887': 'YE', // Yemen

  // Oceania
  '036': 'AU', // Australia
  '554': 'NZ', // New Zealand
};

/**
 * EU-27 ISO-2 set. Used by the customs-flow queries to prefer Eurostat
 * over UN Comtrade for reporters that appear in both (Eurostat is more
 * granular and less lagged for EU members).
 */
export const EU27_ISO2: ReadonlySet<string> = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR',
  'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK',
  'SI', 'ES', 'SE',
]);

/** Convert M49 numeric (with or without leading zero) to ISO-2, or null if unknown. */
export function m49ToIso2(m49: string | number): string | null {
  const padded = String(m49).padStart(3, '0');
  return M49_TO_ISO2[padded] ?? null;
}
