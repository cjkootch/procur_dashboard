/**
 * VTC commodity-category classifier shared across all scrapers.
 *
 * Most government portals (UNGM, Jamaica GOJEP, Guyana NPTAB, Colombia
 * SECOP, etc) don't expose structured commodity codes in their public
 * feeds — they emit free-text titles + descriptions. To still let
 * Discover users filter by VTC's commodity buckets, we run a single
 * keyword regex over title + description and emit the matched
 * `taxonomy_categories.slug`.
 *
 * Word boundaries (`\b`) eliminate substring noise ("oil"→"boil",
 * "sand"→"Sandbox", "service"→"servicing"). The keyword list is
 * conservative — better to miss a borderline row than flood the filter
 * with false positives that the user has to mentally re-filter.
 *
 * Slugs match the seeded entries in `taxonomy_categories`:
 *   food-commodities  · petroleum-fuels  · vehicles-fleet  · minerals-metals
 *
 * For scrapers with structured codes (SAM via NAICS) prefer code-based
 * mapping and only fall back to this classifier when the code lookup
 * misses.
 */
const CATEGORY_REGEXES: Array<readonly [string, RegExp]> = [
  [
    'food-commodities',
    /\b(food|foodstuff|rice|sugar|flour|poultry|chicken|beef|pork|lamb|meat|bread|bakery|fruit|vegetable|frozen|ration|dairy|wheat|corn|maize|soybean|soy|legume|bean|lentil|oat|rye|grain|cereal|fertilizer|milk|cheese|egg|butter|coffee|tea|cocoa)\b/i,
  ],
  [
    'petroleum-fuels',
    /\b(fuel|fuels|diesel|gasoline|petrol|kerosene|jet a-1|jet fuel|propane|lubricant|lubrication|petroleum|lpg|lng|heating oil|marine fuel|aviation fuel|gas oil|crude oil)\b/i,
  ],
  [
    'vehicles-fleet',
    /\b(vehicle|vehicles|vehicular|automobile|truck|trucks|sedan|suv|minibus|bus|buses|motorcycle|fleet|tractor|forklift|ambulance|chassis)\b/i,
  ],
  [
    'minerals-metals',
    /\b(mineral|minerals|ore|ores|aggregate|aggregates|gravel|limestone|cement|iron ore|copper ore|zinc ore|steel beam|steel rebar|steel plate|bauxite|sandstone)\b/i,
  ],
];

/**
 * First-match wins. Order is food → fuel → vehicles → minerals so a
 * row mentioning both "diesel truck" tags as petroleum-fuels (stronger
 * commodity signal for VTC). Adjust here if empirical mis-categorization
 * surfaces.
 *
 * Returns null when nothing matches; caller should treat null as
 * "leave category unset" (not "skip the row").
 */
export function classifyVtcCategory(text: string | null | undefined): string | null {
  if (!text) return null;
  for (const [slug, re] of CATEGORY_REGEXES) {
    if (re.test(text)) return slug;
  }
  return null;
}
