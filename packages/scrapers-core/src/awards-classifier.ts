/**
 * Map UNSPSC commodity codes to the supplier-graph `category_tags`
 * vocabulary used by `awards.category_tags` and the assistant tools
 * (`find_buyers_for_offer`, etc).
 *
 * Distinct from `classifyVtcCategory` (text-classifier for tender
 * titles): this operates on structured UNSPSC codes pulled from OCDS
 * award items. UNSPSC is a 4-segment hierarchy
 * (Segment.Family.Class.Commodity). For coarse tagging we match on
 * Family (first 2 digits) or Class (first 4 digits); for fine-grained
 * fuel sub-types we match on the full 8-digit Commodity code.
 *
 * Returned tags are deduplicated. An award covering both diesel and
 * gasoline emits `['diesel', 'gasoline']` so the per-supplier
 * roll-up correctly attributes both. There's deliberately no
 * "petroleum-fuels" umbrella tag — the supplier-graph queries operate
 * at the fine-grained level (a buyer of jet fuel is not necessarily
 * a buyer of marine bunker).
 *
 * Coverage: fuel (high confidence — codes ported from the
 * caribbean_fuel Python extractor), food (family-level), vehicles
 * (family-level), minerals/metals (family-level, conservative).
 *
 * Tags emitted:
 *   crude-oil · diesel · gasoline · jet-fuel · lpg · marine-bunker ·
 *   heating-oil · heavy-fuel-oil · food-commodities · vehicles ·
 *   minerals-metals
 */

/** UNSPSC commodity codes (8-digit) → fine-grained fuel sub-type. */
const FUEL_CODE_TO_TAG: Record<string, string> = {
  // Diesel
  '15101505': 'diesel', // Diesel fuel #2
  '15101506': 'diesel', // Biodiesel / blends (DR DGCP often tags both 05 and 06 for the same award)
  // Gasoline
  '15101502': 'gasoline', // Aviation gasoline (avgas) — small-aircraft, classed as gasoline
  '15101503': 'gasoline', // Aviation gasoline / motor gasoline
  // Jet fuel (kerosene-based aviation fuels)
  '15101504': 'jet-fuel', // Jet A
  '15101508': 'jet-fuel', // JP-4
  '15101509': 'jet-fuel', // JP-5
  '15101510': 'jet-fuel', // JP-7 / JP-8
  // Heavy/marine
  '15101512': 'heavy-fuel-oil', // Naphtha — borderline, but most procurement is for industrial/refinery feed
  '15101514': 'heavy-fuel-oil', // Industrial fuel oil
  '15101516': 'marine-bunker', // Marine fuel / bunker
  // LPG
  '15101517': 'lpg', // Liquefied petroleum gas / propane
  // Crude
  '15101701': 'crude-oil',
  '15101702': 'crude-oil', // Often bitumen/asphalt; treated as crude-stream byproduct here
};

/** UNSPSC family or class prefixes → coarse tag. */
const PREFIX_TO_TAG: Array<readonly [string, string]> = [
  // Food, Beverage and Tobacco Products (Segment 50)
  ['50', 'food-commodities'],
  // Live Plant and Animal Material and Accessories and Supplies (Segment 10)
  // — covers grains, livestock, raw food commodities
  ['10', 'food-commodities'],
  // Motor Vehicles (Segment 25.10) — passenger, commercial, military
  ['2510', 'vehicles'],
  // Mineral and Textile and Inedible Plant and Animal Materials (Segment 11)
  // — Family 11.10 covers minerals + ores. Conservative: only emit the
  // tag for the minerals/metals subset, not for the textile/plant
  // siblings within Segment 11.
  ['1110', 'minerals-metals'],
  // Structural Components and Basic Shapes (Segment 30) — Family 30.10
  // covers structural metal forms (sheet, bar, pipe). Most government
  // procurement here is downstream finished metal, not raw commodity.
  ['3010', 'minerals-metals'],
];

/**
 * Classify an award's UNSPSC codes into supplier-graph category tags.
 *
 * @param codes - array of UNSPSC codes (8-digit, but partial codes are tolerated)
 * @returns deduplicated category tags; empty array if no match
 */
export function classifyAwardByUnspsc(codes: readonly string[]): string[] {
  const tags = new Set<string>();
  for (const raw of codes) {
    const code = String(raw).replace(/\D/g, ''); // strip dots/dashes
    if (!code) continue;

    const fuelTag = FUEL_CODE_TO_TAG[code];
    if (fuelTag) {
      tags.add(fuelTag);
      continue;
    }

    for (const [prefix, tag] of PREFIX_TO_TAG) {
      if (code.startsWith(prefix)) {
        tags.add(tag);
        break;
      }
    }
  }
  return Array.from(tags);
}

/**
 * The set of fuel UNSPSC codes (Class 1510.15 + 1510.17). Re-exported
 * for ingestion-time pre-filtering: most portals publish thousands of
 * non-fuel awards and we only want to materialize fuel rows in v1.
 *
 * Mirrors the Python caribbean_fuel/dr_extractor.py constant.
 */
export const FUEL_UNSPSC_CODES: ReadonlySet<string> = new Set(Object.keys(FUEL_CODE_TO_TAG));

/**
 * True if any code in the array is a fuel UNSPSC. Hot-path filter
 * called per OCDS award before further parsing.
 */
export function hasFuelUnspsc(codes: readonly string[]): boolean {
  for (const raw of codes) {
    const code = String(raw).replace(/\D/g, '');
    if (FUEL_UNSPSC_CODES.has(code)) return true;
  }
  return false;
}

/**
 * True if any code matches a food UNSPSC family (10 or 50).
 */
export function hasFoodUnspsc(codes: readonly string[]): boolean {
  for (const raw of codes) {
    const code = String(raw).replace(/\D/g, '');
    if (code.startsWith('50') || code.startsWith('10')) return true;
  }
  return false;
}
