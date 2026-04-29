/**
 * Seed the crude_grades reference table.
 *
 * Property figures are analyst-curated from public assays (Argus,
 * Platts, NOC published specs, USGS, OPEC bulletins). Where ranges are
 * published, we use the typical/median value for the active stream.
 *
 * Coverage priority: Libyan grades (the active deal) + the major
 * benchmarks every quote references (Brent / WTI / Dubai / Urals) +
 * the comparable Mediterranean / West-African sweets that compete with
 * Libyan barrels in the same buyer pool.
 *
 * Re-seed-safe (ON CONFLICT). Add a grade by appending here + opening
 * a PR — this is a curated reference table, not a scrape.
 *
 * Run: pnpm --filter @procur/db seed-crude-grades
 */
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { sql } from 'drizzle-orm';
import * as schema from './schema';

loadEnv({ path: '../../.env.local' });
loadEnv({ path: '../../.env' });

type GradeSeed = {
  slug: string;
  name: string;
  originCountry: string | null;
  region: string | null;
  apiGravity: number | null;
  sulfurPct: number | null;
  tan: number | null;
  characterization: string | null;
  isMarker: boolean;
  loadingCountry?: string | null;
  /** Pricing marker this grade trades against. NULL on markers
      themselves. */
  markerSlug?: string | null;
  /** Structural premium (+) or discount (-) vs markerSlug, USD/bbl.
      Hand-curated; refresh quarterly. */
  differentialUsdPerBbl?: number | null;
  notes: string;
};

/**
 * Basis differentials per non-marker grade. Hand-curated from
 * recent Platts / Argus / Reuters published assessments — refresh
 * quarterly as supply/demand dynamics shift. Sign convention:
 * positive = premium over marker; negative = discount.
 *
 * Values populate crude_grades.marker_slug + .differential_usd_per_bbl
 * via the upsert below. Marker grades themselves (brent, wti, dubai,
 * urals) keep both columns NULL — they ARE the markers.
 */
const BASIS: Record<string, { marker: string; differential: number }> = {
  // Libyan light sweets vs Brent — Es Sider is the regional flagship;
  // Sharara prices a dollar above as it's lighter + sweeter.
  'es-sider':       { marker: 'brent', differential:  1.5 },
  'sharara':        { marker: 'brent', differential:  2.5 },
  'sirtica':        { marker: 'brent', differential:  1.0 },
  'brega':          { marker: 'brent', differential:  1.0 },
  'bouri':          { marker: 'brent', differential: -2.0 }, // medium sour
  // West African vs Brent
  'bonny-light':    { marker: 'brent', differential:  1.5 },
  'qua-iboe':       { marker: 'brent', differential:  1.5 },
  'cabinda':        { marker: 'brent', differential: -1.0 }, // heavier sweet
  // Algerian super-light
  'saharan-blend':  { marker: 'brent', differential:  2.5 },
  // Caspian
  'azeri-light':    { marker: 'brent', differential:  2.0 }, // BTC-light premium
  'cpc-blend':      { marker: 'brent', differential: -2.0 }, // longer-haul, slight sour
  'kirkuk':         { marker: 'brent', differential: -3.0 }, // medium sour
  // Middle East vs Dubai
  'arab-light':     { marker: 'dubai', differential: -0.5 },
  'arab-medium':    { marker: 'dubai', differential: -2.5 },
  'arab-heavy':     { marker: 'dubai', differential: -5.0 },
  'iran-heavy':     { marker: 'dubai', differential: -4.0 }, // sanctions-discount
  'basrah-light':   { marker: 'dubai', differential: -1.5 },
  // Americas heavies vs WTI
  'maya':           { marker: 'wti',   differential: -8.0 },
  'wcs':            { marker: 'wti',   differential: -15.0 },
  'merey':          { marker: 'wti',   differential: -10.0 }, // Venezuelan sanctions-impacted
};

const GRADES: GradeSeed[] = [
  // ── Libyan grades — the active deal context ─────────────────────
  {
    slug: 'es-sider',
    name: 'Es Sider',
    originCountry: 'LY',
    region: 'mediterranean',
    apiGravity: 37,
    sulfurPct: 0.4,
    tan: 0.1,
    characterization: 'paraffinic',
    isMarker: false,
    notes:
      "Light sweet. Loads from Es Sider terminal (Sirte basin). Eastern-Libya-controlled. NOC's flagship export grade for European refiners. Easy to run on most Med complex configurations.",
  },
  {
    slug: 'sharara',
    name: 'Sharara',
    originCountry: 'LY',
    region: 'mediterranean',
    apiGravity: 43,
    sulfurPct: 0.07,
    tan: 0.05,
    characterization: 'paraffinic',
    isMarker: false,
    notes:
      'Very light very sweet condensate-like. Sharara field, southwestern Libya. Loads from Zawiya. Premium grade — competes with Algerian Saharan Blend.',
  },
  {
    slug: 'sirtica',
    name: 'Sirtica',
    originCountry: 'LY',
    region: 'mediterranean',
    apiGravity: 41,
    sulfurPct: 0.45,
    tan: 0.1,
    characterization: 'paraffinic',
    isMarker: false,
    notes: 'Light sweet, Sirte basin blend. Often co-loaded with Es Sider.',
  },
  {
    slug: 'brega',
    name: 'Brega',
    originCountry: 'LY',
    region: 'mediterranean',
    apiGravity: 40,
    sulfurPct: 0.21,
    tan: 0.1,
    characterization: 'paraffinic',
    isMarker: false,
    notes: 'Light sweet. Loads from Brega terminal. Lower volume than Es Sider but similar slate.',
  },
  {
    slug: 'bouri',
    name: 'Bouri',
    originCountry: 'LY',
    region: 'mediterranean',
    apiGravity: 26,
    sulfurPct: 1.78,
    tan: 0.5,
    characterization: 'mixed',
    isMarker: false,
    notes:
      'Medium sour offshore Libyan crude — Bouri field, Eni-operated via Mellitah JV. Distinct slate from the Sirte sweets — needs hydrotreating capacity.',
  },

  // ── Benchmark / pricing markers ─────────────────────────────────
  {
    slug: 'brent',
    name: 'Brent',
    originCountry: 'GB',
    region: 'north-sea',
    apiGravity: 38,
    sulfurPct: 0.37,
    tan: 0.1,
    characterization: 'paraffinic',
    isMarker: true,
    notes: 'North Sea benchmark. Most non-US sweet crude prices as a Brent differential.',
  },
  {
    slug: 'wti',
    name: 'WTI',
    originCountry: 'US',
    region: 'americas',
    apiGravity: 39.6,
    sulfurPct: 0.24,
    tan: 0.05,
    characterization: 'paraffinic',
    isMarker: true,
    notes:
      'West Texas Intermediate. US benchmark — Cushing OK pricing point. Often discounted to Brent due to landlocked logistics.',
  },
  {
    slug: 'dubai',
    name: 'Dubai',
    originCountry: 'AE',
    region: 'gulf',
    apiGravity: 31,
    sulfurPct: 2.0,
    tan: 0.1,
    characterization: 'mixed',
    isMarker: true,
    notes:
      'Asian-market sour benchmark. Most Middle East crude prices off Dubai/Oman average. Heavier and more sour than Brent.',
  },
  {
    slug: 'urals',
    name: 'Urals',
    originCountry: 'RU',
    region: 'caspian',
    apiGravity: 31,
    sulfurPct: 1.7,
    tan: 0.4,
    characterization: 'mixed',
    isMarker: true,
    notes:
      'Russian medium sour benchmark — was the European pricing reference until sanctions. Now trades at significant discount, mostly to Indian + Turkish buyers. Watch the differential — when it tightens, Med refineries shift back toward Libyan/CPC sweets.',
  },

  // ── West African comparable sweets ──────────────────────────────
  {
    slug: 'bonny-light',
    name: 'Bonny Light',
    originCountry: 'NG',
    region: 'west-africa',
    apiGravity: 35,
    sulfurPct: 0.16,
    tan: 0.3,
    characterization: 'paraffinic',
    isMarker: false,
    notes: 'Nigerian benchmark. Premium light sweet. Direct competitor to Es Sider in Med + Indian buyer pool.',
  },
  {
    slug: 'qua-iboe',
    name: 'Qua Iboe',
    originCountry: 'NG',
    region: 'west-africa',
    apiGravity: 36,
    sulfurPct: 0.13,
    tan: 0.3,
    characterization: 'paraffinic',
    isMarker: false,
    notes: 'Nigerian light sweet — slightly lighter than Bonny Light. Same buyer pool.',
  },
  {
    slug: 'cabinda',
    name: 'Cabinda',
    originCountry: 'AO',
    region: 'west-africa',
    apiGravity: 32,
    sulfurPct: 0.13,
    tan: 0.3,
    characterization: 'naphthenic',
    isMarker: false,
    notes: 'Angolan medium sweet. Heavily contracted to Asian buyers (China especially). Less common in Med flow.',
  },

  // ── Mediterranean / North African comparables ──────────────────
  {
    slug: 'saharan-blend',
    name: 'Saharan Blend',
    originCountry: 'DZ',
    region: 'mediterranean',
    apiGravity: 45,
    sulfurPct: 0.09,
    tan: 0.05,
    characterization: 'paraffinic',
    isMarker: false,
    notes: 'Algerian super-light sweet — premium grade. Competes with Sharara and CPC Blend.',
  },
  {
    slug: 'azeri-light',
    name: 'Azeri Light',
    originCountry: 'AZ',
    region: 'caspian',
    apiGravity: 36,
    sulfurPct: 0.14,
    tan: 0.05,
    characterization: 'paraffinic',
    isMarker: false,
    loadingCountry: 'TR',
    notes: 'Azerbaijani light sweet. Loads BTC pipeline → Ceyhan, Turkey. Direct Med-pool competitor to Es Sider for Italian + Turkish refiners.',
  },
  {
    slug: 'cpc-blend',
    name: 'CPC Blend',
    originCountry: 'KZ',
    region: 'caspian',
    apiGravity: 45,
    sulfurPct: 0.55,
    tan: 0.1,
    characterization: 'paraffinic',
    isMarker: false,
    loadingCountry: 'RU',
    notes: 'Kazakh super-light, slightly sour. Loads CPC pipeline → Novorossiysk, Russia. Sanctions-adjacent loading risk but still flows. Med + Asian buyers.',
  },
  {
    slug: 'kirkuk',
    name: 'Kirkuk',
    originCountry: 'IQ',
    region: 'mediterranean',
    apiGravity: 36,
    sulfurPct: 1.97,
    tan: 0.4,
    characterization: 'mixed',
    isMarker: false,
    loadingCountry: 'TR',
    notes: 'Iraqi medium sour, loads via Turkey (Ceyhan) when Kurdish-Turkish pipeline is operating.',
  },

  // ── Middle East — primary Asia-Pacific feedstocks ─────────────
  {
    slug: 'arab-light',
    name: 'Arab Light',
    originCountry: 'SA',
    region: 'gulf',
    apiGravity: 33,
    sulfurPct: 1.97,
    tan: 0.1,
    characterization: 'mixed',
    isMarker: false,
    notes: 'Saudi medium sour. Largest single trade flow globally. Term-contract market — spot rare.',
  },
  {
    slug: 'arab-medium',
    name: 'Arab Medium',
    originCountry: 'SA',
    region: 'gulf',
    apiGravity: 30,
    sulfurPct: 2.85,
    tan: 0.1,
    characterization: 'mixed',
    isMarker: false,
    notes: 'Saudi medium sour, heavier than Arab Light. Asian + European complex refiners.',
  },
  {
    slug: 'arab-heavy',
    name: 'Arab Heavy',
    originCountry: 'SA',
    region: 'gulf',
    apiGravity: 27,
    sulfurPct: 2.94,
    tan: 0.1,
    characterization: 'mixed',
    isMarker: false,
    notes: 'Saudi heavy sour. Coker-equipped complex refineries only. Significant residue.',
  },
  {
    slug: 'iran-heavy',
    name: 'Iran Heavy',
    originCountry: 'IR',
    region: 'gulf',
    apiGravity: 29.5,
    sulfurPct: 1.99,
    tan: 0.2,
    characterization: 'mixed',
    isMarker: false,
    notes:
      'Iranian heavy sour — sanctions-restricted. Mostly flows to China at heavy discount via dark-fleet logistics.',
  },
  {
    slug: 'basrah-light',
    name: 'Basrah Light',
    originCountry: 'IQ',
    region: 'gulf',
    apiGravity: 31,
    sulfurPct: 2.85,
    tan: 0.1,
    characterization: 'mixed',
    isMarker: false,
    notes: 'Iraqi medium sour, primary southern export grade. Asian + European buyers.',
  },

  // ── Americas heavies ─────────────────────────────────────────
  {
    slug: 'maya',
    name: 'Maya',
    originCountry: 'MX',
    region: 'americas',
    apiGravity: 21,
    sulfurPct: 3.4,
    tan: 0.5,
    characterization: 'naphthenic',
    isMarker: false,
    notes: 'Mexican heavy sour. PEMEX flagship — US Gulf Coast coker refineries are the buyer pool.',
  },
  {
    slug: 'wcs',
    name: 'Western Canadian Select',
    originCountry: 'CA',
    region: 'americas',
    apiGravity: 21,
    sulfurPct: 3.51,
    tan: 0.7,
    characterization: 'mixed',
    isMarker: false,
    notes:
      'Canadian dilbit (heavy + bitumen + diluent). USGC + Midwest complex refineries; rail + pipeline logistics.',
  },
  {
    slug: 'merey',
    name: 'Merey',
    originCountry: 'VE',
    region: 'americas',
    apiGravity: 16,
    sulfurPct: 2.4,
    tan: 1.4,
    characterization: 'naphthenic',
    isMarker: false,
    notes:
      'Venezuelan extra-heavy. High TAN — needs corrosion-resistant metallurgy. Sanctions-affected; mostly to China + India via opaque logistics.',
  },
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');

  const client = neon(url);
  const db = drizzle(client, { schema, casing: 'snake_case' });

  console.log(`Seeding ${GRADES.length} crude grades...`);
  for (const g of GRADES) {
    await db
      .insert(schema.crudeGrades)
      .values({
        slug: g.slug,
        name: g.name,
        originCountry: g.originCountry,
        region: g.region,
        apiGravity: g.apiGravity == null ? null : String(g.apiGravity),
        sulfurPct: g.sulfurPct == null ? null : String(g.sulfurPct),
        tan: g.tan == null ? null : String(g.tan),
        characterization: g.characterization,
        isMarker: g.isMarker,
        loadingCountry: g.loadingCountry ?? null,
        // Resolve basis differential from the BASIS lookup (or
        // override per-row via g.markerSlug / g.differentialUsdPerBbl
        // on a future seed addition).
        markerSlug: g.markerSlug ?? BASIS[g.slug]?.marker ?? null,
        differentialUsdPerBbl:
          g.differentialUsdPerBbl != null
            ? String(g.differentialUsdPerBbl)
            : BASIS[g.slug] != null
              ? String(BASIS[g.slug]!.differential)
              : null,
        notes: g.notes,
        source: 'analyst-curated',
      })
      .onConflictDoUpdate({
        target: schema.crudeGrades.slug,
        set: {
          name: g.name,
          originCountry: g.originCountry,
          region: g.region,
          apiGravity: g.apiGravity == null ? null : String(g.apiGravity),
          sulfurPct: g.sulfurPct == null ? null : String(g.sulfurPct),
          tan: g.tan == null ? null : String(g.tan),
          characterization: g.characterization,
          isMarker: g.isMarker,
          loadingCountry: g.loadingCountry ?? null,
          markerSlug: g.markerSlug ?? BASIS[g.slug]?.marker ?? null,
          differentialUsdPerBbl:
            g.differentialUsdPerBbl != null
              ? String(g.differentialUsdPerBbl)
              : BASIS[g.slug] != null
                ? String(BASIS[g.slug]!.differential)
                : null,
          notes: g.notes,
          source: 'analyst-curated',
          updatedAt: new Date(),
        },
      });
  }
  // Touch the constant so the linter doesn't flag it as unused — sql is
  // imported for downstream callers who add raw queries.
  void sql;
  console.log(`Done. ${GRADES.length} grades upserted.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
