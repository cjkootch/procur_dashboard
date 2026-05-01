/**
 * Static freight-rate reference data — analyst-curated typical
 * lump-sum + $/MT bands for product/crude routes that show up in
 * West/East Africa and Med/Caribbean deal flows. Refresh quarterly
 * by editing this file.
 *
 * Why a static array and not a DB table:
 *   - Tiny dataset (~30-40 routes). Updates are quarterly, not
 *     daily — no operational write traffic.
 *   - Cleaner review for analyst tweaks (PR diff vs. SQL update).
 *   - Avoids a migration and a seed pipeline for data that's
 *     genuinely static.
 *
 * If the dataset grows past ~200 rows or starts taking real-time
 * updates, promote to a DB table.
 */
export const FREIGHT_ORIGIN_REGIONS = [
  'med', // Mediterranean (Italy, France, Spain, Greece, Turkey, NAfrica)
  'nwe', // NW Europe / ARA (Rotterdam, Antwerp, Amsterdam, UK)
  'usgc', // US Gulf Coast (Houston, NOLA)
  'singapore', // Singapore + Far East product hubs
  'mideast', // AG product / crude (Fujairah, Jubail, Sikka)
  'india', // Indian export refineries (Sikka, Vadinar)
  'west-africa', // intra-West-Africa (Lagos, Lomé, Tema reshipping)
  'east-africa', // intra-East-Africa (Mombasa, Dar)
  'black-sea', // Novorossiysk, Constanța
] as const;

export type FreightOriginRegion = (typeof FREIGHT_ORIGIN_REGIONS)[number];

/** Type-guard for narrowing free-text columns (e.g. companies.default_sourcing_region). */
export function isFreightOriginRegion(s: string | null | undefined): s is FreightOriginRegion {
  return s != null && (FREIGHT_ORIGIN_REGIONS as readonly string[]).includes(s);
}

export type FreightVesselClass =
  | 'mr1' // ~25-37k DWT, smallest clean
  | 'mr2' // ~37-50k DWT, workhorse for clean
  | 'lr1' // ~50-80k DWT
  | 'lr2' // ~80-120k DWT
  | 'aframax' // ~80-120k DWT (crude)
  | 'suezmax' // ~120-200k DWT (crude)
  | 'vlcc'; // 200k+ DWT (crude)

export type FreightProductType = 'clean' | 'crude';

export type FreightRoute = {
  originRegion: FreightOriginRegion;
  /** Port slug as seeded in `ports` table (e.g. 'lome-port'). */
  destPortSlug: string;
  destCountry: string; // ISO-2
  productType: FreightProductType;
  vesselClassTypical: FreightVesselClass;
  usdPerMtLow: number;
  usdPerMtHigh: number;
  notes?: string;
};

/**
 * Typical recent (2025-2026) freight bands. Source: blend of
 * Worldscale/lump-sum publications (Argus / Baltic Exchange / S&P
 * Global) and broker reports. Bands cover the typical-week range,
 * not extremes.
 *
 * Refresh cadence: quarterly. As-of: 2026-Q2.
 */
export const FREIGHT_ROUTES: FreightRoute[] = [
  // ── Clean products → West Africa (the active deal flow) ──────
  {
    originRegion: 'med',
    destPortSlug: 'lome-port',
    destCountry: 'TG',
    productType: 'clean',
    vesselClassTypical: 'mr1',
    usdPerMtLow: 30,
    usdPerMtHigh: 45,
    notes: 'Common spot route for Nigerian/Togolese product imports from Med refineries.',
  },
  {
    originRegion: 'med',
    destPortSlug: 'tema-port',
    destCountry: 'GH',
    productType: 'clean',
    vesselClassTypical: 'mr1',
    usdPerMtLow: 30,
    usdPerMtHigh: 45,
  },
  {
    originRegion: 'med',
    destPortSlug: 'lagos-apapa-port',
    destCountry: 'NG',
    productType: 'clean',
    vesselClassTypical: 'mr2',
    usdPerMtLow: 28,
    usdPerMtHigh: 42,
    notes: 'Larger discharge volumes favour MR2 over MR1.',
  },
  {
    originRegion: 'med',
    destPortSlug: 'dakar-port',
    destCountry: 'SN',
    productType: 'clean',
    vesselClassTypical: 'mr1',
    usdPerMtLow: 28,
    usdPerMtHigh: 40,
  },
  {
    originRegion: 'nwe',
    destPortSlug: 'lome-port',
    destCountry: 'TG',
    productType: 'clean',
    vesselClassTypical: 'mr1',
    usdPerMtLow: 35,
    usdPerMtHigh: 50,
  },
  {
    originRegion: 'nwe',
    destPortSlug: 'tema-port',
    destCountry: 'GH',
    productType: 'clean',
    vesselClassTypical: 'mr1',
    usdPerMtLow: 35,
    usdPerMtHigh: 50,
  },
  {
    originRegion: 'nwe',
    destPortSlug: 'lagos-apapa-port',
    destCountry: 'NG',
    productType: 'clean',
    vesselClassTypical: 'mr2',
    usdPerMtLow: 32,
    usdPerMtHigh: 48,
  },
  {
    originRegion: 'nwe',
    destPortSlug: 'dakar-port',
    destCountry: 'SN',
    productType: 'clean',
    vesselClassTypical: 'mr1',
    usdPerMtLow: 32,
    usdPerMtHigh: 46,
  },
  {
    originRegion: 'usgc',
    destPortSlug: 'lome-port',
    destCountry: 'TG',
    productType: 'clean',
    vesselClassTypical: 'mr2',
    usdPerMtLow: 45,
    usdPerMtHigh: 65,
    notes: 'Trans-Atlantic product haul; less common than Med-origin.',
  },
  {
    originRegion: 'usgc',
    destPortSlug: 'tema-port',
    destCountry: 'GH',
    productType: 'clean',
    vesselClassTypical: 'mr2',
    usdPerMtLow: 45,
    usdPerMtHigh: 65,
  },
  {
    originRegion: 'usgc',
    destPortSlug: 'lagos-apapa-port',
    destCountry: 'NG',
    productType: 'clean',
    vesselClassTypical: 'mr2',
    usdPerMtLow: 42,
    usdPerMtHigh: 62,
  },

  // ── Clean products → East Africa ─────────────────────────────
  {
    originRegion: 'med',
    destPortSlug: 'mombasa-port',
    destCountry: 'KE',
    productType: 'clean',
    vesselClassTypical: 'mr1',
    usdPerMtLow: 50,
    usdPerMtHigh: 70,
    notes: 'Suez transit. Watch canal disruption events for premium spikes.',
  },
  {
    originRegion: 'med',
    destPortSlug: 'dar-es-salaam-port',
    destCountry: 'TZ',
    productType: 'clean',
    vesselClassTypical: 'mr1',
    usdPerMtLow: 52,
    usdPerMtHigh: 72,
  },
  {
    originRegion: 'mideast',
    destPortSlug: 'mombasa-port',
    destCountry: 'KE',
    productType: 'clean',
    vesselClassTypical: 'mr1',
    usdPerMtLow: 38,
    usdPerMtHigh: 55,
    notes: "Common AG → E. Africa route. Typical for Indian/AG product into Kenya.",
  },
  {
    originRegion: 'mideast',
    destPortSlug: 'dar-es-salaam-port',
    destCountry: 'TZ',
    productType: 'clean',
    vesselClassTypical: 'mr1',
    usdPerMtLow: 40,
    usdPerMtHigh: 58,
  },
  {
    originRegion: 'india',
    destPortSlug: 'mombasa-port',
    destCountry: 'KE',
    productType: 'clean',
    vesselClassTypical: 'mr1',
    usdPerMtLow: 32,
    usdPerMtHigh: 48,
    notes: 'Sikka/Vadinar → Mombasa is the dominant E. Africa product flow.',
  },
  {
    originRegion: 'india',
    destPortSlug: 'dar-es-salaam-port',
    destCountry: 'TZ',
    productType: 'clean',
    vesselClassTypical: 'mr1',
    usdPerMtLow: 34,
    usdPerMtHigh: 50,
  },
  {
    originRegion: 'singapore',
    destPortSlug: 'mombasa-port',
    destCountry: 'KE',
    productType: 'clean',
    vesselClassTypical: 'lr1',
    usdPerMtLow: 50,
    usdPerMtHigh: 68,
  },
  {
    originRegion: 'singapore',
    destPortSlug: 'dar-es-salaam-port',
    destCountry: 'TZ',
    productType: 'clean',
    vesselClassTypical: 'lr1',
    usdPerMtLow: 52,
    usdPerMtHigh: 70,
  },
  // USGC → E. Africa is a long haul (US Gulf or Cartagena → Cape of
  // Good Hope, or via Suez when not disrupted). Bands reflect LR1
  // economics — MR is uneconomic at these distances. Premium vs
  // mideast/india routes is the structural cost of using a Western-
  // hemisphere refinery for E. African product. Relevant for traders
  // with a Latin-American (esp. Colombian / Venezuelan) supply leg.
  {
    originRegion: 'usgc',
    destPortSlug: 'mombasa-port',
    destCountry: 'KE',
    productType: 'clean',
    vesselClassTypical: 'lr1',
    usdPerMtLow: 78,
    usdPerMtHigh: 105,
    notes:
      'Long-haul (US Gulf / Caribbean → E. Africa via Cape or Suez). LR1 economics; MR is uneconomic. Premium vs Med/AG/India sourcing is the structural cost of Western-hemisphere supply into Kenya.',
  },
  {
    originRegion: 'usgc',
    destPortSlug: 'dar-es-salaam-port',
    destCountry: 'TZ',
    productType: 'clean',
    vesselClassTypical: 'lr1',
    usdPerMtLow: 80,
    usdPerMtHigh: 108,
  },

  // ── Clean products → Caribbean (other active region) ─────────
  {
    originRegion: 'usgc',
    destPortSlug: 'kingston-port',
    destCountry: 'JM',
    productType: 'clean',
    vesselClassTypical: 'mr1',
    usdPerMtLow: 18,
    usdPerMtHigh: 30,
    notes: 'Short USGC → Caribbean haul; common for DR/Jamaica/Bahamas product.',
  },
  {
    originRegion: 'usgc',
    destPortSlug: 'sd-haina-port',
    destCountry: 'DO',
    productType: 'clean',
    vesselClassTypical: 'mr1',
    usdPerMtLow: 18,
    usdPerMtHigh: 30,
  },
  {
    originRegion: 'usgc',
    destPortSlug: 'port-au-prince-varreux',
    destCountry: 'HT',
    productType: 'clean',
    vesselClassTypical: 'mr1',
    usdPerMtLow: 20,
    usdPerMtHigh: 32,
    notes:
      'USGC → Port-au-Prince (Varreux Terminal). Slightly longer haul than ' +
      'Kingston/Haina; small premium for the Windward Passage routing. ' +
      'Often loaded ex-Houston or ex-Santa Marta (Colombia) — Santa Marta ' +
      'origin is ~$18-25/MT.',
  },
  {
    originRegion: 'med',
    destPortSlug: 'kingston-port',
    destCountry: 'JM',
    productType: 'clean',
    vesselClassTypical: 'mr1',
    usdPerMtLow: 35,
    usdPerMtHigh: 50,
  },
  {
    originRegion: 'med',
    destPortSlug: 'port-au-prince-varreux',
    destCountry: 'HT',
    productType: 'clean',
    vesselClassTypical: 'mr1',
    usdPerMtLow: 38,
    usdPerMtHigh: 55,
    notes:
      'Med → Haiti via Atlantic. Brent-WTI spread usually makes USGC origin ' +
      'cheaper for Caribbean destinations — consult get_market_snapshot ' +
      'sourcingHint before quoting Med-origin Caribbean lifts.',
  },

  // ── Crude → Med refineries (existing deal context) ───────────
  {
    originRegion: 'west-africa', // Bonny Light / Qua Iboe origin
    destPortSlug: 'genoa-port',
    destCountry: 'IT',
    productType: 'crude',
    vesselClassTypical: 'suezmax',
    usdPerMtLow: 22,
    usdPerMtHigh: 35,
  },
  {
    originRegion: 'west-africa',
    destPortSlug: 'augusta-port',
    destCountry: 'IT',
    productType: 'crude',
    vesselClassTypical: 'suezmax',
    usdPerMtLow: 20,
    usdPerMtHigh: 32,
  },
  {
    originRegion: 'med', // Saharan Blend / Es Sider
    destPortSlug: 'sannazzaro-refinery',
    destCountry: 'IT',
    productType: 'crude',
    vesselClassTypical: 'aframax',
    usdPerMtLow: 8,
    usdPerMtHigh: 15,
    notes: 'Short-haul Med crude; via Genoa pipeline.',
  },
  {
    originRegion: 'black-sea', // CPC, Azeri Light from Novorossiysk
    destPortSlug: 'augusta-port',
    destCountry: 'IT',
    productType: 'crude',
    vesselClassTypical: 'suezmax',
    usdPerMtLow: 15,
    usdPerMtHigh: 26,
  },
];

export type FreightLookupFilters = {
  originRegion?: FreightOriginRegion;
  destPortSlug?: string;
  destCountry?: string;
  productType?: FreightProductType;
};

/**
 * Look up freight bands matching the filter. Returns ALL matches —
 * the assistant can compare alternative routes (different origin
 * regions) to advise on the cheapest sourcing geography. If no
 * filter is supplied, returns the whole table.
 */
export function lookupFreightEstimate(
  filters: FreightLookupFilters = {},
): FreightRoute[] {
  return FREIGHT_ROUTES.filter((r) => {
    if (filters.originRegion && r.originRegion !== filters.originRegion) return false;
    if (filters.destPortSlug && r.destPortSlug !== filters.destPortSlug) return false;
    if (filters.destCountry && r.destCountry !== filters.destCountry) return false;
    if (filters.productType && r.productType !== filters.productType) return false;
    return true;
  });
}
