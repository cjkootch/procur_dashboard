/**
 * Country-name → ISO-3166-1 alpha-2 normalization for chat-tool inputs.
 *
 * The plain ISO-2 regex (`/^[A-Z]{2}$/`) was making the model retry
 * country params 2-3× per call: it kept passing "United States",
 * "Poland", "USA", "U.K.", etc. The schema rejected, the model
 * adjusted, the user waited. This helper accepts any of those forms
 * and returns the canonical ISO-2.
 *
 * Scope: countries that show up in procur's tender / award data, plus
 * the major energy traders. ~190 countries — close to the full
 * ISO-3166-1 set, with a focus on names the model actually emits.
 *
 * Resolution order:
 *   1. Already a valid ISO-2 code (after upper-casing)? Return it.
 *   2. Known alias / common short form ("USA", "UK", "UAE", "DRC")?
 *      Return the canonical ISO-2.
 *   3. Common-name lookup (case-insensitive, accent-tolerant) against
 *      the canonical English short names + frequent variants
 *      ("United States", "Russia", "South Korea"). Return ISO-2.
 *   4. Otherwise null — caller surfaces a readable error.
 *
 * NOT a full ISO-3166 implementation. Excluded: territories, sub-
 * national entities, historic codes (SU/CS/YU). Add as needed when
 * a real chat trace hits an unsupported value.
 */

/**
 * Canonical English short name → ISO-2. Source: ISO 3166-1 alpha-2
 * names, normalised to lowercase here; the lookup folds whitespace
 * + diacritics. Add common aliases inline ("United States of America"
 * resolves to US via the alias table, not this map).
 */
const NAME_TO_ISO2: Record<string, string> = {
  // North America
  'united states': 'US',
  'canada': 'CA',
  'mexico': 'MX',

  // Caribbean
  'cuba': 'CU',
  'dominican republic': 'DO',
  'jamaica': 'JM',
  'haiti': 'HT',
  'puerto rico': 'PR',
  'bahamas': 'BS',
  'barbados': 'BB',
  'trinidad and tobago': 'TT',
  'antigua and barbuda': 'AG',
  'saint lucia': 'LC',
  'saint vincent and the grenadines': 'VC',
  'grenada': 'GD',
  'saint kitts and nevis': 'KN',
  'dominica': 'DM',

  // Central America
  'honduras': 'HN',
  'guatemala': 'GT',
  'nicaragua': 'NI',
  'costa rica': 'CR',
  'panama': 'PA',
  'el salvador': 'SV',
  'belize': 'BZ',

  // South America
  'colombia': 'CO',
  'venezuela': 'VE',
  'ecuador': 'EC',
  'peru': 'PE',
  'bolivia': 'BO',
  'brazil': 'BR',
  'argentina': 'AR',
  'chile': 'CL',
  'uruguay': 'UY',
  'paraguay': 'PY',
  'guyana': 'GY',
  'suriname': 'SR',
  'french guiana': 'GF',

  // Europe — West / Central / Nordic / Baltic
  'united kingdom': 'GB',
  'ireland': 'IE',
  'france': 'FR',
  'germany': 'DE',
  'netherlands': 'NL',
  'belgium': 'BE',
  'luxembourg': 'LU',
  'denmark': 'DK',
  'norway': 'NO',
  'sweden': 'SE',
  'finland': 'FI',
  'iceland': 'IS',
  'spain': 'ES',
  'portugal': 'PT',
  'italy': 'IT',
  'greece': 'GR',
  'malta': 'MT',
  'cyprus': 'CY',
  'austria': 'AT',
  'switzerland': 'CH',
  'liechtenstein': 'LI',
  'poland': 'PL',
  'czech republic': 'CZ',
  'czechia': 'CZ',
  'slovakia': 'SK',
  'hungary': 'HU',
  'slovenia': 'SI',
  'croatia': 'HR',
  'estonia': 'EE',
  'latvia': 'LV',
  'lithuania': 'LT',

  // Europe — East
  'romania': 'RO',
  'bulgaria': 'BG',
  'serbia': 'RS',
  'bosnia and herzegovina': 'BA',
  'north macedonia': 'MK',
  'macedonia': 'MK',
  'montenegro': 'ME',
  'albania': 'AL',
  'moldova': 'MD',
  'ukraine': 'UA',

  // Russia / Belarus
  'russia': 'RU',
  'russian federation': 'RU',
  'belarus': 'BY',

  // Africa — North
  'morocco': 'MA',
  'algeria': 'DZ',
  'tunisia': 'TN',
  'libya': 'LY',
  'egypt': 'EG',
  'sudan': 'SD',

  // Africa — West
  'senegal': 'SN',
  'gambia': 'GM',
  'guinea': 'GN',
  'guinea-bissau': 'GW',
  'sierra leone': 'SL',
  'liberia': 'LR',
  'ivory coast': 'CI',
  "cote d'ivoire": 'CI',
  "côte d'ivoire": 'CI',
  'ghana': 'GH',
  'togo': 'TG',
  'benin': 'BJ',
  'nigeria': 'NG',
  'cameroon': 'CM',
  'gabon': 'GA',
  'congo': 'CG',
  'republic of the congo': 'CG',
  'democratic republic of the congo': 'CD',
  'dr congo': 'CD',
  'angola': 'AO',
  'mali': 'ML',
  'burkina faso': 'BF',
  'niger': 'NE',
  'chad': 'TD',
  'mauritania': 'MR',
  'equatorial guinea': 'GQ',
  'sao tome and principe': 'ST',
  'são tomé and príncipe': 'ST',
  'cape verde': 'CV',
  'cabo verde': 'CV',

  // Africa — East / South
  'kenya': 'KE',
  'tanzania': 'TZ',
  'uganda': 'UG',
  'rwanda': 'RW',
  'burundi': 'BI',
  'ethiopia': 'ET',
  'somalia': 'SO',
  'djibouti': 'DJ',
  'eritrea': 'ER',
  'south sudan': 'SS',
  'madagascar': 'MG',
  'malawi': 'MW',
  'zambia': 'ZM',
  'zimbabwe': 'ZW',
  'south africa': 'ZA',
  'namibia': 'NA',
  'botswana': 'BW',
  'lesotho': 'LS',
  'eswatini': 'SZ',
  'swaziland': 'SZ',
  'mozambique': 'MZ',

  // Middle East
  'saudi arabia': 'SA',
  'united arab emirates': 'AE',
  'qatar': 'QA',
  'kuwait': 'KW',
  'bahrain': 'BH',
  'oman': 'OM',
  'yemen': 'YE',
  'iran': 'IR',
  'iraq': 'IQ',
  'jordan': 'JO',
  'israel': 'IL',
  'lebanon': 'LB',
  'syria': 'SY',
  'turkey': 'TR',
  'türkiye': 'TR',
  'turkiye': 'TR',

  // Caspian / Caucasus
  'azerbaijan': 'AZ',
  'kazakhstan': 'KZ',
  'turkmenistan': 'TM',
  'uzbekistan': 'UZ',
  'kyrgyzstan': 'KG',
  'tajikistan': 'TJ',
  'armenia': 'AM',
  'georgia': 'GE',

  // Asia — South
  'india': 'IN',
  'pakistan': 'PK',
  'bangladesh': 'BD',
  'sri lanka': 'LK',
  'nepal': 'NP',
  'bhutan': 'BT',
  'maldives': 'MV',
  'afghanistan': 'AF',

  // Asia — East
  'china': 'CN',
  "people's republic of china": 'CN',
  'japan': 'JP',
  'south korea': 'KR',
  'korea': 'KR',
  'taiwan': 'TW',
  'hong kong': 'HK',
  'mongolia': 'MN',
  'north korea': 'KP',
  'macao': 'MO',
  'macau': 'MO',

  // Asia — Southeast
  'singapore': 'SG',
  'malaysia': 'MY',
  'indonesia': 'ID',
  'thailand': 'TH',
  'vietnam': 'VN',
  'viet nam': 'VN',
  'philippines': 'PH',
  'myanmar': 'MM',
  'burma': 'MM',
  'cambodia': 'KH',
  'laos': 'LA',
  'brunei': 'BN',
  'timor-leste': 'TL',
  'east timor': 'TL',

  // Oceania
  'australia': 'AU',
  'new zealand': 'NZ',
  'papua new guinea': 'PG',
  'fiji': 'FJ',
  'solomon islands': 'SB',
  'vanuatu': 'VU',
  'new caledonia': 'NC',
  'french polynesia': 'PF',
};

/**
 * Common short forms / aliases the LLM emits that aren't the
 * canonical ISO short name. Keys are already lowercased + folded.
 * Values are ISO-2 codes.
 */
const ALIASES: Record<string, string> = {
  // United States variants
  'usa': 'US',
  'us': 'US', // (also matches the regex; here for clarity)
  'u.s.': 'US',
  'u.s.a.': 'US',
  'united states of america': 'US',
  'america': 'US',

  // United Kingdom variants
  'uk': 'GB',
  'u.k.': 'GB',
  'great britain': 'GB',
  'britain': 'GB',
  'england': 'GB', // pragmatic — country lookups for England return GB

  // UAE variants
  'uae': 'AE',
  'u.a.e.': 'AE',
  'emirates': 'AE',

  // DR Congo variants
  'drc': 'CD',
  'd.r.c.': 'CD',
  'democratic republic of congo': 'CD',
  'congo-kinshasa': 'CD',
  'congo (kinshasa)': 'CD',

  // Republic of Congo
  'congo-brazzaville': 'CG',
  'congo (brazzaville)': 'CG',

  // PRC
  'prc': 'CN',
  'p.r.c.': 'CN',
  'mainland china': 'CN',

  // ROC / Taiwan
  'roc': 'TW',
  'chinese taipei': 'TW',
  'republic of china': 'TW',

  // Korea variants
  'rok': 'KR',
  'republic of korea': 'KR',
  'dprk': 'KP',
  "democratic people's republic of korea": 'KP',

  // Saudi Arabia
  'ksa': 'SA',
  'kingdom of saudi arabia': 'SA',

  // Russia
  'russian fed': 'RU',
  'rf': 'RU',

  // Czech / Slovak variants
  'czech': 'CZ',

  // Vatican / Holy See — edge case, but the model has emitted it
  'holy see': 'VA',
  'vatican': 'VA',
  'vatican city': 'VA',
};

/**
 * The full set of valid ISO-2 codes we accept passthrough. Built from
 * NAME_TO_ISO2 + ALIASES values. Anything not in this set fails the
 * normalize step even if it matches the [A-Z]{2} regex shape — guards
 * against the model passing made-up codes ("XX", "ZZ").
 */
const VALID_ISO2 = new Set<string>([
  ...Object.values(NAME_TO_ISO2),
  ...Object.values(ALIASES),
  // A few additional ISO-2 codes that don't appear as values in the
  // maps above but show up in procur data (microstates, territories
  // that occasionally tender).
  'AD', 'MC', 'SM', 'AW', 'BM', 'KY', 'TC', 'AI', 'VG', 'GI', 'FO',
  'GL', 'PS', 'XK', // XK = Kosovo (user-assigned, widely used)
]);

/**
 * Normalize a free-form country input to its ISO-2 code, or return
 * null when the input doesn't resolve to any known country.
 *
 * Folding rules:
 *   - Strip diacritics (NFD + combining-mark removal).
 *   - Collapse whitespace, lowercase.
 *   - Strip the trailing comma + region prefix some catalogs emit
 *     ("Korea, Republic of" → "republic of korea").
 */
export function normalizeCountryCode(input: string | null | undefined): string | null {
  if (input == null) return null;
  const raw = input.trim();
  if (raw.length === 0) return null;

  // Fast path: already a 2-letter code in our valid set.
  if (raw.length === 2) {
    const upper = raw.toUpperCase();
    if (VALID_ISO2.has(upper)) return upper;
  }

  const folded = fold(raw);

  // Direct match against canonical names + aliases.
  if (NAME_TO_ISO2[folded]) return NAME_TO_ISO2[folded];
  if (ALIASES[folded]) return ALIASES[folded];

  // Handle "Korea, Republic of" / "Congo, Democratic Republic of"
  // shape — flip the comma-prefixed phrase to canonical word order.
  if (folded.includes(', ')) {
    const flipped = folded.split(', ').reverse().join(' ');
    if (NAME_TO_ISO2[flipped]) return NAME_TO_ISO2[flipped];
    if (ALIASES[flipped]) return ALIASES[flipped];
  }

  return null;
}

function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip combining marks (diacritics)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Read-only view of the canonical English-name table — exposed for
 *  the schema's error message to surface a few examples. */
export const COUNTRY_NAME_EXAMPLES: ReadonlyArray<{ name: string; code: string }> = [
  { name: 'Colombia', code: 'CO' },
  { name: 'Italy', code: 'IT' },
  { name: 'Nigeria', code: 'NG' },
  { name: 'United States', code: 'US' },
  { name: 'United Kingdom', code: 'GB' },
];

/**
 * Dominant business-language map for outreach drafting. ISO 3166-1 alpha-2
 * country code → ISO 639-1 language code. Used by the autopilot when a
 * probe has no probe-level `outreachLanguage` set — it falls back to
 * per-target language detection via this table so a multi-country probe
 * can email a Peru contact in Spanish and a Brazil contact in Portuguese
 * without the operator forking the probe.
 *
 * The map is intentionally conservative: only countries with a clearly
 * dominant business language. Multilingual / mixed-language markets
 * (Belgium, Switzerland, Canada, India, South Africa) are omitted —
 * lookup returns null and the drafter falls back to English, which is a
 * safer default than guessing wrong.
 *
 * Operator can always force a specific language by setting
 * `probe.outreachLanguage` explicitly.
 */
const COUNTRY_TO_LANGUAGE: Record<string, string> = {
  // Spanish-language Latin America
  AR: 'es', BO: 'es', CL: 'es', CO: 'es', CR: 'es', CU: 'es', DO: 'es',
  EC: 'es', SV: 'es', GT: 'es', HN: 'es', MX: 'es', NI: 'es', PA: 'es',
  PY: 'es', PE: 'es', UY: 'es', VE: 'es',
  // Portuguese-language
  BR: 'pt', PT: 'pt', AO: 'pt', MZ: 'pt',
  // French-language Europe + North Africa + Francophone Africa
  FR: 'fr', MC: 'fr', SN: 'fr', CI: 'fr', ML: 'fr', BF: 'fr', NE: 'fr',
  TG: 'fr', BJ: 'fr', GA: 'fr', CG: 'fr', CD: 'fr', MG: 'fr', DZ: 'fr',
  TN: 'fr',
  // German-language
  DE: 'de', AT: 'de',
  // Dutch
  NL: 'nl',
  // Italian
  IT: 'it',
  // Spanish-language Europe
  ES: 'es',
  // East Asia
  JP: 'ja', KR: 'ko', CN: 'zh', TW: 'zh', HK: 'zh',
  // Southeast Asia
  TH: 'th', VN: 'vi', ID: 'id',
  // Slavic
  PL: 'pl', CZ: 'cs', SK: 'sk', RU: 'ru', UA: 'uk', BG: 'bg', RS: 'sr',
  HR: 'hr',
  // Nordic
  SE: 'sv', NO: 'no', DK: 'da', FI: 'fi', IS: 'is',
  // Other Europe
  GR: 'el', HU: 'hu', RO: 'ro', TR: 'tr', AL: 'sq', LT: 'lt', LV: 'lv',
  EE: 'et', SI: 'sl',
  // Middle East / Arabic-language (when dominant)
  SA: 'ar', AE: 'ar', EG: 'ar', JO: 'ar', LB: 'ar', KW: 'ar', QA: 'ar',
  OM: 'ar', BH: 'ar', IQ: 'ar', LY: 'ar', SY: 'ar', YE: 'ar',
  // Persian
  IR: 'fa',
  // Hebrew
  IL: 'he',
};

/**
 * Resolve a target country to its dominant business language for
 * outreach drafting. Returns null for English-speaking markets +
 * unmapped / multilingual countries — caller treats null as "fall
 * back to English / drafter default". Per the drafter's own guidance,
 * 'en' returns null too (the drafter has no special STEERING block
 * for English; it's the base case).
 */
export function countryToOutreachLanguage(
  countryIso2: string | null | undefined,
): string | null {
  if (!countryIso2) return null;
  const code = countryIso2.trim().toUpperCase();
  return COUNTRY_TO_LANGUAGE[code] ?? null;
}
