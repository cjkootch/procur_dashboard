/**
 * Best-effort fuzzy match of a free-form crude name (as published in
 * a producer's assay sheet) to a `crude_grades.slug`. Returns the
 * matched slug or null when no high-confidence match exists.
 *
 * Strategy:
 *   1. Normalise: lowercase, strip vintage suffixes ("2015 06"),
 *      strip blend/condensate descriptors that aren't part of the
 *      canonical name, fold whitespace/punctuation.
 *   2. Try exact match on (normalised assay name) → grade.
 *   3. Try "grade name is a prefix of assay name" — handles
 *      "Brent Blend" → 'brent', "Forties Blend" → 'brent' is wrong
 *      so we ALSO check grade.aliases (we only have a few).
 *   4. Try assay first-word match against grade name's first word.
 *   5. Otherwise null — caller leaves grade_slug NULL.
 *
 * Scope: deliberately conservative. False positives downstream
 * pollute `crude_grades` with the wrong assay's properties; better
 * to leave the slug NULL and let a follow-up curate.
 */

export type GradeIndex = ReadonlyArray<{ slug: string; name: string }>;

/** Known aliases that appear in producer assays but not in crude_grades.name.
 *  Keys are the producer's assay name (lowercased + folded), values are the
 *  crude_grades.slug to match. Add as real chat traces surface mismatches. */
const ASSAY_NAME_ALIASES: Record<string, string> = {
  'brent blend': 'brent',
  'wti light': 'wti',
  'wti': 'wti',
  'arab light crude': 'arab-light',
  'azeri btc': 'azeri-light',
  'azeri ceyhan': 'azeri-light',
  'azeri-btc': 'azeri-light',
  'es sider': 'es-sider',
  'es-sider': 'es-sider',
  'forties bl': 'forties-blend', // not in seed today; will resolve null until added
  'al-shaheen': 'al-shaheen',
  'al-jurf': 'al-jurf',
  'cpc blend': 'cpc-blend',
  'qua iboe': 'qua-iboe',
  'qua-iboe': 'qua-iboe',
  'bonny light': 'bonny-light',
  'bonny-light': 'bonny-light',
  'algerian condensate': 'algerian-condensate',
  'saharan blend': 'saharan-blend',
  'upper zakum': 'upper-zakum',
  'upper-zakhum': 'upper-zakum',
  'oman export': 'oman',
  'iran heavy': 'iran-heavy',
  'basrah light': 'basrah-light',
  'basrah heavy': 'basrah-heavy',
  'basrah medium': 'basrah-medium',
  // Already-canonical assay names that exactly match a slug.
  'cabinda': 'cabinda',
  'mars': 'mars',
  'kirkuk': 'kirkuk',
  'urals': 'urals',
  'dubai': 'dubai',
  'maya': 'maya',
  'merey': 'merey',
  'wcs': 'wcs',
  'western canadian select': 'wcs',
};

export function matchCrudeGrade(
  assayName: string,
  grades: GradeIndex,
): string | null {
  const folded = foldName(assayName);
  if (!folded) return null;

  // 1. Direct alias hit
  if (ASSAY_NAME_ALIASES[folded]) return ASSAY_NAME_ALIASES[folded]!;

  // Build a lookup: folded grade name → slug.
  const byFoldedName: Record<string, string> = {};
  const byFoldedSlug: Record<string, string> = {};
  for (const g of grades) {
    byFoldedName[foldName(g.name)] = g.slug;
    byFoldedSlug[foldName(g.slug)] = g.slug;
  }

  // 2. Exact normalised name match
  if (byFoldedName[folded]) return byFoldedName[folded]!;
  if (byFoldedSlug[folded]) return byFoldedSlug[folded]!;

  // 3. Grade name is the leading prefix of assay name (handles
  //    "Forties BL" → 'forties' if 'forties' is in seed).
  for (const [foldedGrade, slug] of Object.entries(byFoldedName)) {
    if (folded.startsWith(foldedGrade + ' ') || folded === foldedGrade) {
      return slug;
    }
  }

  // 4. Assay first-word matches grade first-word AND no other grade
  //    starts with the same word (avoid ambiguity: "azeri btc" vs
  //    "azeri light" both start with "azeri" — both candidates,
  //    so don't auto-resolve).
  const assayHead = folded.split(' ')[0]!;
  const candidates = Object.entries(byFoldedName).filter(([fg]) =>
    fg.split(' ')[0] === assayHead,
  );
  if (candidates.length === 1) return candidates[0]![1];

  return null;
}

/**
 * Strip vintage / descriptor suffixes from producer-published names so
 * "EKOFISK 2015 06" → "ekofisk", "Crude Light Sweet 2024" → "crude
 * light sweet", "AZERI BTC 2022 12" → "azeri btc", etc.
 *
 * Removed suffixes: 4-digit year, 4-digit year + 2-digit month,
 * trailing date ranges. Vintage stripping happens BEFORE token
 * folding so the resulting string is comparable to crude_grades names.
 */
export function foldName(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics
    .replace(/[_–—]/g, ' ') // underscores + dashes → space (keep hyphens for now)
    .replace(/\s+\d{4}\s*\d{0,2}\s*$/g, '') // trailing "2015 06"
    .replace(/\s+v\d+(\.\d+)?$/g, '') // trailing version "v-2"
    .replace(/[.()\[\]]/g, '') // strip parens/dots/brackets
    .replace(/\s+/g, ' ')
    .trim();
}
