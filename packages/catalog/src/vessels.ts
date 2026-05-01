import 'server-only';
import { BBL_PER_MT, type ProductSlug } from './plausibility';

/**
 * Tanker vessel classes — DWT brackets, typical cargo capacity, and
 * usage notes. Synthesized from EIA's AFRA reference, TankerTrackers'
 * vessel-size FAQ, and Primo Nautic's industry-fleet data. The MR1 /
 * MR2 split mirrors the freight-market vocabulary the existing
 * `get_freight_estimate` tool already uses.
 *
 * Sources:
 *   - https://www.eia.gov/todayinenergy/detail.php?id=17991
 *   - https://tankertrackers.com/faq/entry/vessel-size-classification
 *   - https://primonautic.com/blog/oil-tankers-classes-sizes-and-global-fleet-data
 *
 * The bbl capacities below assume refined-product loading
 * (~0.84 SG); crude cargoes load at lower bbl counts because crude
 * is denser. The calculator uses per-product BBL_PER_MT to convert
 * cargo volume back to MT — class brackets stay product-agnostic.
 *
 * Aframax + LR2 share the 80-120k DWT bracket but differ in tank
 * coatings (LR2 has product-grade epoxy; Aframax usually doesn't).
 * Treat them as one class for sizing decisions; raise the
 * coating distinction when the cargo is jet / ULSD.
 */

export type VesselClassSlug =
  | 'coastal'
  | 'mr1'
  | 'mr2'
  | 'lr1'
  | 'lr2-aframax'
  | 'suezmax'
  | 'vlcc'
  | 'ulcc';

export interface VesselClass {
  slug: VesselClassSlug;
  /** Display name used in chat surfaces. */
  label: string;
  /** Aliases the freight market uses interchangeably. */
  aliases: readonly string[];
  /** DWT (deadweight tons) range. Inclusive low, exclusive high. */
  dwtMin: number;
  dwtMax: number;
  /** Typical refined-product cargo capacity (~0.84 SG). For crude
   *  cargoes the capacity in bbl is roughly 10-15% lower because
   *  crude is denser. */
  cargoBblMin: number;
  cargoBblMax: number;
  /** Approximate length overall in meters — useful for the visual
   *  comparison card. */
  loaMetersTypical: number;
  /** What this class actually moves. */
  primaryUse: string;
  /** Notable port / canal / draft constraints. */
  constraints: string;
}

export const VESSEL_CLASSES: readonly VesselClass[] = [
  {
    slug: 'coastal',
    label: 'Coastal / GP',
    aliases: ['general purpose', 'gp', 'small tanker'],
    dwtMin: 1_000,
    dwtMax: 25_000,
    cargoBblMin: 50_000,
    cargoBblMax: 200_000,
    loaMetersTypical: 130,
    primaryUse:
      'Coastal product distribution, bunker barging, short-haul lifts to small ports.',
    constraints: 'Limited open-ocean range; rarely used for trans-ocean cargoes.',
  },
  {
    slug: 'mr1',
    label: 'MR1',
    aliases: ['handysize', 'mr'],
    dwtMin: 25_000,
    dwtMax: 40_000,
    cargoBblMin: 200_000,
    cargoBblMax: 300_000,
    loaMetersTypical: 175,
    primaryUse:
      'Regional refined-product lifts (Med→WAF, USGC→Caribbean, NWE→UK Atlantic).',
    constraints: 'Fits most African and Caribbean discharge ports without restriction.',
  },
  {
    slug: 'mr2',
    label: 'MR2',
    aliases: ['handymax', 'medium range 2'],
    dwtMin: 40_000,
    dwtMax: 55_000,
    cargoBblMin: 300_000,
    cargoBblMax: 400_000,
    loaMetersTypical: 185,
    primaryUse:
      'Workhorse for Atlantic-basin product trade. Most Med→WAF and USGC→WAF clean cargoes are MR2 lifts.',
    constraints:
      'Some smaller discharge ports (e.g. parts of inland West Africa) cap at MR1; check port draft.',
  },
  {
    slug: 'lr1',
    label: 'LR1 (Panamax)',
    aliases: ['panamax', 'long range 1'],
    dwtMin: 55_000,
    dwtMax: 80_000,
    cargoBblMin: 400_000,
    cargoBblMax: 600_000,
    loaMetersTypical: 230,
    primaryUse:
      'Long-haul refined product (Mideast→East Africa, India→Latam) and some crude. Panama Canal compliant pre-2016 expansion.',
    constraints:
      'Suez transit fine; some smaller WAF / EAF ports require lightering.',
  },
  {
    slug: 'lr2-aframax',
    label: 'LR2 / Aframax',
    aliases: ['aframax', 'long range 2'],
    dwtMin: 80_000,
    dwtMax: 120_000,
    cargoBblMin: 600_000,
    cargoBblMax: 900_000,
    loaMetersTypical: 250,
    primaryUse:
      'Crude (Aframax framing) or product (LR2 framing) on Caribbean / Med / North Sea routes. Coatings differ: LR2 carries clean product (jet, ULSD); plain Aframax handles crude / dirty product.',
    constraints:
      'Suez transit fine; many smaller refinery jetties cap at this size.',
  },
  {
    slug: 'suezmax',
    label: 'Suezmax',
    aliases: ['lr3'],
    dwtMin: 120_000,
    dwtMax: 200_000,
    cargoBblMin: 900_000,
    cargoBblMax: 1_200_000,
    loaMetersTypical: 275,
    primaryUse:
      'Crude trades sized for full-loaded Suez Canal transit (Med↔Asia, WAF↔Asia).',
    constraints: 'Suez-compliant by definition; some VLCC ports too shallow.',
  },
  {
    slug: 'vlcc',
    label: 'VLCC',
    aliases: ['very large crude carrier'],
    dwtMin: 200_000,
    dwtMax: 320_000,
    cargoBblMin: 1_800_000,
    cargoBblMax: 2_200_000,
    loaMetersTypical: 330,
    primaryUse:
      'Long-haul crude (Mideast→Asia, WAF→US/Asia). Cape of Good Hope routing when fully laden.',
    constraints: 'Cannot transit Suez fully laden; needs deep-water ports / SBMs.',
  },
  {
    slug: 'ulcc',
    label: 'ULCC',
    aliases: ['ultra large crude carrier'],
    dwtMin: 320_000,
    dwtMax: 550_000,
    cargoBblMin: 2_200_000,
    cargoBblMax: 4_000_000,
    loaMetersTypical: 380,
    primaryUse:
      'Niche long-haul crude. Most ULCCs retired or in storage role; very few trading today.',
    constraints:
      'Only a handful of ports worldwide can berth a fully-laden ULCC (LOOP, Rotterdam, a few Asian terminals).',
  },
];

export interface VesselClassFit {
  vesselClass: VesselClass;
  /** Cargo volume as a percentage of the class's mid-range capacity.
   *  100% = perfect fit at the bracket midpoint; <50% = under-utilized
   *  (uneconomic freight); >100% = doesn't fit, would need lightering. */
  fillPctOfMid: number;
  /** True when the cargo fits within the class's max capacity. */
  fits: boolean;
  /** Cargo volume in MT this class can typically carry (mid). */
  classCapacityMt: number;
}

export interface VesselRecommendation {
  product: ProductSlug;
  volumeMt: number;
  cargoBbl: number;
  bblPerMt: number;
  /** The smallest class that fits the cargo. Null when cargo
   *  exceeds even ULCC capacity (truly unusual). */
  recommended: VesselClassFit | null;
  /** Up-to-three alternative classes (next-down, next-up, and one
   *  more) so the user can see the sizing band. */
  alternatives: VesselClassFit[];
  /** Render-ready chart payload — every class with normalized
   *  capacity + the cargo overlay percentage. Sorted small → large. */
  comparisonChart: Array<{
    classSlug: VesselClassSlug;
    label: string;
    /** Mid-bracket capacity in bbl, for bar-length scaling. */
    capacityBblMid: number;
    /** Cargo volume as a percentage of THIS class's mid capacity.
     *  Capped at 100 for visual sanity; `fits` carries the truth. */
    cargoFillPct: number;
    /** When false, cargo doesn't fit this class. Visual cue only. */
    fits: boolean;
    /** Highlight cue for the recommended class. */
    isRecommended: boolean;
  }>;
  /** One-line summary for the model to lead with. */
  narrative: string;
}

/**
 * Pick the smallest vessel class that fits a cargo, plus contextual
 * alternatives. Returns `recommended=null` only when cargo exceeds
 * ULCC max — extremely rare in commercial trading.
 */
export function recommendVesselClass(
  product: ProductSlug,
  volumeMt: number,
): VesselRecommendation {
  if (volumeMt <= 0) {
    throw new Error(`recommendVesselClass: volumeMt must be positive (got ${volumeMt})`);
  }
  const bblPerMt = BBL_PER_MT[product];
  if (!bblPerMt) {
    throw new Error(`recommendVesselClass: unknown product slug ${product}`);
  }
  const cargoBbl = volumeMt * bblPerMt;

  const fits: VesselClassFit[] = VESSEL_CLASSES.map((vc) => {
    const midBbl = (vc.cargoBblMin + vc.cargoBblMax) / 2;
    const classCapacityMt = midBbl / bblPerMt;
    return {
      vesselClass: vc,
      fillPctOfMid: (cargoBbl / midBbl) * 100,
      fits: cargoBbl <= vc.cargoBblMax,
      classCapacityMt,
    };
  });

  // Smallest class whose max accommodates the cargo.
  const recommended = fits.find((f) => f.fits) ?? null;

  // Alternatives: previous (under-sized, reference for "won't fit"),
  // next (one-up, headroom), and the one after that — bounded.
  const recIndex = recommended
    ? fits.findIndex((f) => f.vesselClass.slug === recommended.vesselClass.slug)
    : fits.length - 1;
  const alternatives: VesselClassFit[] = [];
  if (recIndex > 0) alternatives.push(fits[recIndex - 1]!);
  if (recIndex + 1 < fits.length) alternatives.push(fits[recIndex + 1]!);
  if (recIndex + 2 < fits.length) alternatives.push(fits[recIndex + 2]!);

  const comparisonChart = fits.map((f) => ({
    classSlug: f.vesselClass.slug,
    label: f.vesselClass.label,
    capacityBblMid: (f.vesselClass.cargoBblMin + f.vesselClass.cargoBblMax) / 2,
    cargoFillPct: Math.min(f.fillPctOfMid, 100),
    fits: f.fits,
    isRecommended: recommended?.vesselClass.slug === f.vesselClass.slug,
  }));

  const narrative = buildNarrative(product, volumeMt, cargoBbl, recommended);

  return {
    product,
    volumeMt,
    cargoBbl,
    bblPerMt,
    recommended,
    alternatives,
    comparisonChart,
    narrative,
  };
}

function buildNarrative(
  product: ProductSlug,
  volumeMt: number,
  cargoBbl: number,
  recommended: VesselClassFit | null,
): string {
  const volStr = `${Math.round(volumeMt).toLocaleString()} MT`;
  const bblStr = `${Math.round(cargoBbl).toLocaleString()} bbl`;
  if (!recommended) {
    return `${volStr} of ${product} (~${bblStr}) exceeds ULCC capacity. Either split the cargo across multiple lifts or use FSO storage transfer.`;
  }
  const fillRoundedToFive = Math.round(recommended.fillPctOfMid / 5) * 5;
  return (
    `${volStr} of ${product} (~${bblStr}) sits in the ${recommended.vesselClass.label} ` +
    `bracket (${recommended.vesselClass.dwtMin.toLocaleString()}-${recommended.vesselClass.dwtMax.toLocaleString()} DWT, ` +
    `~${recommended.vesselClass.cargoBblMin.toLocaleString()}-${recommended.vesselClass.cargoBblMax.toLocaleString()} bbl). ` +
    `Cargo fills ~${fillRoundedToFive}% of typical mid capacity.`
  );
}

/**
 * Map a vessel's DWT to its inferred class. Used by future
 * fleet-linkage features (`vessels` table augmentation) so a tanker's
 * AIS-broadcast DWT can be bucketed without an extra column. Returns
 * null only for DWT below 1k (likely AIS data error).
 */
export function inferVesselClass(dwt: number): VesselClass | null {
  if (!Number.isFinite(dwt) || dwt < 1_000) return null;
  return (
    VESSEL_CLASSES.find((vc) => dwt >= vc.dwtMin && dwt < vc.dwtMax) ??
    VESSEL_CLASSES[VESSEL_CLASSES.length - 1] ?? // ULCC catches everything > 320k
    null
  );
}
