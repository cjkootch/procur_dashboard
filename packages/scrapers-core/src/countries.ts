/**
 * UN Member State / common-territory country names. Used by scrapers
 * (currently UNGM) to detect a beneficiary country in flattened row
 * text by trailing-suffix match against this list.
 *
 * Names follow the form UNGM emits ("Côte d'Ivoire" with the
 * apostrophe, "Türkiye" with the modern spelling). Where a country
 * has multiple common names (e.g. UK / United Kingdom), both forms
 * are listed.
 *
 * Sorted by descending length so the matcher prefers the longest
 * substring match — "Sierra Leone" wins over "Leone" alone, "United
 * States" wins over "States".
 */
export const COUNTRY_NAMES: readonly string[] = [
  // Two-or-three-word names first so longest-match works without sorting.
  'Bosnia and Herzegovina',
  'Central African Republic',
  'Democratic Republic of the Congo',
  'Dominican Republic',
  'Equatorial Guinea',
  'Federated States of Micronesia',
  'Marshall Islands',
  'Papua New Guinea',
  'Saint Kitts and Nevis',
  'Saint Lucia',
  'Saint Vincent and the Grenadines',
  'Sao Tome and Principe',
  'Saudi Arabia',
  'Sierra Leone',
  'Solomon Islands',
  'South Africa',
  'South Sudan',
  'Sri Lanka',
  'Trinidad and Tobago',
  'United Arab Emirates',
  'United Kingdom',
  'United States',
  'Burkina Faso',
  'Cabo Verde',
  'Cape Verde',
  'Costa Rica',
  'Czech Republic',
  'East Timor',
  'El Salvador',
  'Hong Kong',
  'Ivory Coast',
  'New Zealand',
  'North Korea',
  'North Macedonia',
  'Puerto Rico',
  'San Marino',
  'South Korea',
  'Timor-Leste',
  // Single-word names.
  'Afghanistan',
  'Albania',
  'Algeria',
  'Andorra',
  'Angola',
  'Argentina',
  'Armenia',
  'Australia',
  'Austria',
  'Azerbaijan',
  'Bahamas',
  'Bahrain',
  'Bangladesh',
  'Barbados',
  'Belarus',
  'Belgium',
  'Belize',
  'Benin',
  'Bhutan',
  'Bolivia',
  'Botswana',
  'Brazil',
  'Brunei',
  'Bulgaria',
  'Burundi',
  'Cambodia',
  'Cameroon',
  'Canada',
  'Chad',
  'Chile',
  'China',
  'Colombia',
  'Comoros',
  'Congo',
  "Côte d'Ivoire",
  'Croatia',
  'Cuba',
  'Cyprus',
  'Denmark',
  'Djibouti',
  'Dominica',
  'Ecuador',
  'Egypt',
  'Eritrea',
  'Estonia',
  'Eswatini',
  'Ethiopia',
  'Fiji',
  'Finland',
  'France',
  'Gabon',
  'Gambia',
  'Georgia',
  'Germany',
  'Ghana',
  'Greece',
  'Grenada',
  'Guatemala',
  'Guinea',
  'Guinea-Bissau',
  'Guyana',
  'Haiti',
  'Honduras',
  'Hungary',
  'Iceland',
  'India',
  'Indonesia',
  'Iran',
  'Iraq',
  'Ireland',
  'Israel',
  'Italy',
  'Jamaica',
  'Japan',
  'Jordan',
  'Kazakhstan',
  'Kenya',
  'Kiribati',
  'Kosovo',
  'Kuwait',
  'Kyrgyzstan',
  'Laos',
  'Latvia',
  'Lebanon',
  'Lesotho',
  'Liberia',
  'Libya',
  'Liechtenstein',
  'Lithuania',
  'Luxembourg',
  'Madagascar',
  'Malawi',
  'Malaysia',
  'Maldives',
  'Mali',
  'Malta',
  'Mauritania',
  'Mauritius',
  'Mexico',
  'Moldova',
  'Monaco',
  'Mongolia',
  'Montenegro',
  'Morocco',
  'Mozambique',
  'Myanmar',
  'Namibia',
  'Nauru',
  'Nepal',
  'Netherlands',
  'Nicaragua',
  'Niger',
  'Nigeria',
  'Norway',
  'Oman',
  'Pakistan',
  'Palau',
  'Palestine',
  'Panama',
  'Paraguay',
  'Peru',
  'Philippines',
  'Poland',
  'Portugal',
  'Qatar',
  'Romania',
  'Russia',
  'Rwanda',
  'Samoa',
  'Senegal',
  'Serbia',
  'Seychelles',
  'Singapore',
  'Slovakia',
  'Slovenia',
  'Somalia',
  'Spain',
  'Sudan',
  'Suriname',
  'Sweden',
  'Switzerland',
  'Syria',
  'Taiwan',
  'Tajikistan',
  'Tanzania',
  'Thailand',
  'Togo',
  'Tonga',
  'Tunisia',
  'Türkiye',
  'Turkey',
  'Turkmenistan',
  'Tuvalu',
  'Uganda',
  'Ukraine',
  'Uruguay',
  'Uzbekistan',
  'Vanuatu',
  'Venezuela',
  'Vietnam',
  'Yemen',
  'Zambia',
  'Zimbabwe',
] as const;

const NAME_SET = new Set(COUNTRY_NAMES.map((c) => c.toLowerCase()));

/**
 * Detect a known country name appearing as the trailing token(s) of
 * a string. Tries longest-match first (3 words → 2 words → 1 word) so
 * "Sierra Leone" beats "Leone", "United States" beats "States".
 *
 * Returns the matched country in its canonical casing (from COUNTRY_NAMES)
 * along with the index where it starts in the input — caller can splice
 * it out if needed. Returns null if no match.
 */
export function findTrailingCountry(s: string): { name: string; startIndex: number } | null {
  const trimmed = s.trim();
  if (!trimmed) return null;

  const tokens = trimmed.split(/\s+/);
  for (const wordCount of [3, 2, 1] as const) {
    if (tokens.length < wordCount) continue;
    const candidate = tokens.slice(-wordCount).join(' ');
    if (NAME_SET.has(candidate.toLowerCase())) {
      // Find canonical casing.
      const canonical = COUNTRY_NAMES.find(
        (c) => c.toLowerCase() === candidate.toLowerCase(),
      );
      if (!canonical) continue;
      // Compute the start index of the matched suffix in the original
      // string by counting back wordCount whitespace boundaries.
      const startIndex = trimmed.length - candidate.length;
      return { name: canonical, startIndex };
    }
  }
  return null;
}
