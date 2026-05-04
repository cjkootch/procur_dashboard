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
  'algerian-condensate': { marker: 'brent', differential: 1.0 },
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

  // ── North Sea (vs Brent) ────────────────────────────────────
  'forties-blend':   { marker: 'brent', differential:  0.0 }, // co-marker — included in Dated
  'ekofisk':         { marker: 'brent', differential:  0.5 }, // co-marker — included in Dated
  'oseberg':         { marker: 'brent', differential:  0.5 }, // co-marker — included in Dated
  'troll':           { marker: 'brent', differential:  0.5 }, // co-marker — included in Dated
  'statfjord':       { marker: 'brent', differential:  1.0 }, // light sweet
  'gullfaks':        { marker: 'brent', differential: -0.5 }, // medium sweet
  'johan-sverdrup':  { marker: 'brent', differential: -3.0 }, // medium sour, asia-bound
  'grane':           { marker: 'brent', differential: -3.0 }, // heavier sweet
  'alvheim-blend':   { marker: 'brent', differential:  1.5 }, // light sweet condensate
  'snohvit-condensate': { marker: 'brent', differential: 3.0 }, // very light condensate
  'flotta-gold':     { marker: 'brent', differential:  0.5 }, // light sweet
  'clair':           { marker: 'brent', differential: -3.0 }, // medium sour West of Shetland

  // ── West Africa (vs Brent) ──────────────────────────────────
  'forcados':        { marker: 'brent', differential:  1.0 }, // Nigerian light sweet
  'bonga':           { marker: 'brent', differential:  0.0 }, // Nigerian medium sweet (Shell)
  'erha':            { marker: 'brent', differential:  0.5 }, // Nigerian light sweet
  'brass-river':     { marker: 'brent', differential:  1.0 }, // Nigerian light sweet
  'akpo':            { marker: 'brent', differential:  2.5 }, // Nigerian condensate
  'usan':            { marker: 'brent', differential: -1.5 }, // Nigerian medium-heavy
  'agbami':          { marker: 'brent', differential:  1.5 }, // Nigerian light sweet
  'amenam-blend':    { marker: 'brent', differential:  1.0 }, // Nigerian light sweet
  'zafiro':          { marker: 'brent', differential:  1.0 }, // Equatorial Guinea light sweet
  'dalia':           { marker: 'brent', differential: -1.0 }, // Angolan medium
  'girassol':        { marker: 'brent', differential:  0.0 }, // Angolan medium sweet
  'pazflor':         { marker: 'brent', differential: -1.5 }, // Angolan medium sour
  'clov':            { marker: 'brent', differential:  0.0 }, // Angolan medium sweet
  'mondo':           { marker: 'brent', differential:  0.5 }, // Angolan light sweet
  'hungo':           { marker: 'brent', differential:  0.5 }, // Angolan light sweet
  'kissanje':        { marker: 'brent', differential:  0.5 }, // Angolan medium sweet
  'saturno':         { marker: 'brent', differential:  0.5 }, // Angolan medium sweet
  'saxi-batuque':    { marker: 'brent', differential:  0.5 }, // Angolan medium sweet
  'gindungo':        { marker: 'brent', differential:  1.5 }, // Angolan condensate
  'mostarda':        { marker: 'brent', differential:  1.5 }, // Angolan light sweet
  'nemba':           { marker: 'brent', differential:  0.0 }, // Angolan medium sweet
  'nkossa-blend':    { marker: 'brent', differential:  1.5 }, // Congo condensate
  'djeno':           { marker: 'brent', differential: -2.0 }, // Congo medium sour
  'mandji':          { marker: 'brent', differential: -1.5 }, // Gabon medium sweet

  // ── Brazil pre-salt (vs Brent) ──────────────────────────────
  'mero':            { marker: 'brent', differential: -0.5 }, // pre-salt medium sweet
  'atapu':           { marker: 'brent', differential: -0.5 }, // pre-salt medium sweet
  'sepia':           { marker: 'brent', differential: -0.5 }, // pre-salt medium sweet
  'sururu':          { marker: 'brent', differential:  0.0 }, // pre-salt medium sweet
  'bacalhau':        { marker: 'brent', differential:  0.0 }, // pre-salt medium sweet
  'lapa':            { marker: 'brent', differential:  0.0 }, // pre-salt
  'peregrino':       { marker: 'brent', differential: -8.0 }, // heavy sour
  'roncador':        { marker: 'brent', differential: -2.0 }, // medium sour

  // ── US GoM + onshore (vs WTI) ───────────────────────────────
  'mars-blend':      { marker: 'wti',   differential:  1.5 }, // GoM medium sour, marker-class
  'thunder-horse':   { marker: 'wti',   differential:  2.0 }, // GoM light sweet
  'southern-green-canyon': { marker: 'wti', differential: 0.0 }, // GoM medium
  'bakken':          { marker: 'wti',   differential:  1.0 }, // North Dakota light sweet
  'alaska-north-slope':{ marker: 'wti', differential:  0.0 }, // ANS medium sour
  'hls':             { marker: 'wti',   differential:  3.0 }, // Heavy Louisiana Sweet
  'lls':             { marker: 'wti',   differential:  3.0 }, // Light Louisiana Sweet
  'domestic-sweet':  { marker: 'wti',   differential:  1.0 }, // generic US light sweet

  // ── Canada (vs WCS as marker) ───────────────────────────────
  'cold-lake-blend': { marker: 'wti',   differential: -14.0 }, // dilbit
  'kearl':           { marker: 'wti',   differential: -14.0 }, // dilbit
  'fort-hills-dilbit':{ marker: 'wti',  differential: -14.0 }, // RCC dilbit
  'synbit':          { marker: 'wti',   differential: -10.0 }, // synthetic blend

  // ── Mideast (vs Dubai) ──────────────────────────────────────
  'murban':          { marker: 'dubai', differential:  2.0 }, // ADNOC light sweet
  'al-shaheen':      { marker: 'dubai', differential: -1.0 }, // Qatar medium sour
  'al-jurf':         { marker: 'dubai', differential:  0.0 }, // Tunisia/Med light sweet
  'das-blend':       { marker: 'dubai', differential:  0.5 }, // ADNOC condensate
  'qatar-marine':    { marker: 'dubai', differential:  0.5 }, // Qatar light sour
  'oman':            { marker: 'dubai', differential:  0.5 }, // co-marker — DME settles into Oman
  'upper-zakum':     { marker: 'dubai', differential:  0.0 }, // ADNOC medium sour
  'el-sharara':      { marker: 'brent', differential:  3.0 }, // Libyan light sweet (Sharara field)

  // ── Asia / Oceania (vs Tapis as own marker, or Brent) ───────
  'tapis':           { marker: 'brent', differential:  4.0 }, // own regional marker
  'minas':           { marker: 'tapis', differential: -2.0 }, // Indonesia heavy sweet
  'duri':            { marker: 'tapis', differential: -8.0 }, // Indonesia heavy sweet
  'handil-mix':      { marker: 'tapis', differential:  0.0 }, // Indonesia light sweet
  'gippsland':       { marker: 'brent', differential:  3.5 }, // Australian condensate
  'gorgon':          { marker: 'brent', differential:  2.5 }, // Australian light sweet
  'north-west-shelf-condensate': { marker: 'brent', differential: 3.5 }, // Australian
  'cossack':         { marker: 'brent', differential:  2.0 }, // Australian light sweet
  'kutubu':          { marker: 'brent', differential:  2.5 }, // PNG light sweet
  'banyu-urip':      { marker: 'brent', differential:  1.5 }, // Indonesia light sweet

  // ── Latam South America (vs Brent / WTI) ────────────────────
  'liza':            { marker: 'brent', differential: -0.5 }, // Guyana medium sweet
  'payara':          { marker: 'brent', differential: -1.5 }, // Guyana medium sweet
  'medanito':        { marker: 'brent', differential:  1.0 }, // Argentina light sweet
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
    slug: 'algerian-condensate',
    name: 'Algerian Condensate',
    originCountry: 'DZ',
    region: 'mediterranean',
    apiGravity: 52,
    sulfurPct: 0.05,
    tan: 0.03,
    characterization: 'paraffinic',
    isMarker: false,
    notes:
      "Sonatrach gas-field condensate (primarily Hassi R'Mel). Ultra-light paraffinic; loads at Skikda + Arzew alongside the LNG complex. Distinct from Saharan Blend (which is the field-crude blend pipelined out of Hassi Messaoud).",
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

  // ── North Sea ────────────────────────────────────────────────
  {
    slug: 'forties-blend',
    name: 'Forties Blend',
    originCountry: 'GB',
    region: 'north-sea',
    apiGravity: 38,
    sulfurPct: 0.55,
    tan: 0.1,
    characterization: 'paraffinic',
    isMarker: false,
    notes:
      'UK North Sea light sweet. Co-marker — included in the Brent BFOET basket that settles Dated Brent. Loads from Hound Point.',
  },
  {
    slug: 'ekofisk',
    name: 'Ekofisk',
    originCountry: 'NO',
    region: 'north-sea',
    apiGravity: 39,
    sulfurPct: 0.21,
    tan: 0.1,
    characterization: 'paraffinic',
    isMarker: false,
    notes:
      'Norwegian Ekofisk field. Light sweet. Co-marker in the Dated Brent BFOET basket. Pipelined to Teesside.',
  },
  {
    slug: 'oseberg',
    name: 'Oseberg',
    originCountry: 'NO',
    region: 'north-sea',
    apiGravity: 37,
    sulfurPct: 0.27,
    tan: 0.1,
    characterization: 'paraffinic',
    isMarker: false,
    notes:
      'Norwegian Oseberg field. Light sweet. Co-marker in the Dated Brent BFOET basket. Loads at Sture terminal.',
  },
  {
    slug: 'troll',
    name: 'Troll',
    originCountry: 'NO',
    region: 'north-sea',
    apiGravity: 36,
    sulfurPct: 0.10,
    tan: 0.1,
    characterization: 'paraffinic',
    isMarker: false,
    notes:
      'Norwegian Troll field. Light sweet. Co-marker in the Dated Brent BFOET basket. Loads at Mongstad.',
  },
  {
    slug: 'statfjord',
    name: 'Statfjord',
    originCountry: 'NO',
    region: 'north-sea',
    apiGravity: 38,
    sulfurPct: 0.25,
    tan: 0.1,
    characterization: 'paraffinic',
    isMarker: false,
    notes: 'Norwegian Statfjord field. Light sweet, loads at Mongstad.',
  },
  {
    slug: 'gullfaks',
    name: 'Gullfaks',
    originCountry: 'NO',
    region: 'north-sea',
    apiGravity: 32,
    sulfurPct: 0.45,
    tan: 0.2,
    characterization: 'paraffinic',
    isMarker: false,
    notes: 'Norwegian Gullfaks field. Medium sweet. Loads from FPSOs.',
  },
  {
    slug: 'johan-sverdrup',
    name: 'Johan Sverdrup',
    originCountry: 'NO',
    region: 'north-sea',
    apiGravity: 28,
    sulfurPct: 0.85,
    tan: 0.3,
    characterization: 'naphthenic',
    isMarker: false,
    notes:
      'Norwegian Johan Sverdrup field — medium sour, large volume. Mostly destined for Asian (esp. Chinese) refiners; competes with Urals + ME mediums.',
  },
  {
    slug: 'grane',
    name: 'Grane',
    originCountry: 'NO',
    region: 'north-sea',
    apiGravity: 28,
    sulfurPct: 0.55,
    tan: 0.4,
    characterization: 'naphthenic',
    isMarker: false,
    notes: 'Norwegian Grane — heavier sweet. Common feed for Med + NWE coker complexes.',
  },
  {
    slug: 'alvheim-blend',
    name: 'Alvheim Blend',
    originCountry: 'NO',
    region: 'north-sea',
    apiGravity: 38,
    sulfurPct: 0.13,
    tan: 0.1,
    characterization: 'paraffinic',
    isMarker: false,
    notes: 'Norwegian Alvheim field — light sweet, condensate-like. AkerBP-operated.',
  },
  {
    slug: 'snohvit-condensate',
    name: 'Snøhvit Condensate',
    originCountry: 'NO',
    region: 'north-sea',
    apiGravity: 60,
    sulfurPct: 0.02,
    tan: 0.05,
    characterization: 'paraffinic',
    isMarker: false,
    notes: 'Norwegian Arctic field. Very light condensate — feeds Hammerfest LNG; spot exports.',
  },
  {
    slug: 'flotta-gold',
    name: 'Flotta Gold',
    originCountry: 'GB',
    region: 'north-sea',
    apiGravity: 38,
    sulfurPct: 0.30,
    tan: 0.1,
    characterization: 'paraffinic',
    isMarker: false,
    notes: 'UK North Sea light sweet, loads at Flotta (Orkney).',
  },
  {
    slug: 'clair',
    name: 'Clair',
    originCountry: 'GB',
    region: 'north-sea',
    apiGravity: 24,
    sulfurPct: 1.0,
    tan: 0.2,
    characterization: 'naphthenic',
    isMarker: false,
    notes: 'UK West-of-Shetland medium sour. BP-operated, loads via FPSO.',
  },

  // ── West Africa ──────────────────────────────────────────────
  {
    slug: 'forcados',
    name: 'Forcados',
    originCountry: 'NG',
    region: 'west-africa',
    apiGravity: 30,
    sulfurPct: 0.18,
    tan: 0.3,
    characterization: 'paraffinic',
    isMarker: false,
    notes: 'Nigerian Niger Delta light sweet, loads from Forcados terminal.',
  },
  {
    slug: 'bonga',
    name: 'Bonga',
    originCountry: 'NG',
    region: 'west-africa',
    apiGravity: 29,
    sulfurPct: 0.30,
    tan: 0.4,
    characterization: 'paraffinic',
    isMarker: false,
    notes: 'Nigerian deepwater medium sweet. Shell-operated FPSO offshore.',
  },
  {
    slug: 'erha',
    name: 'Erha',
    originCountry: 'NG',
    region: 'west-africa',
    apiGravity: 31,
    sulfurPct: 0.21,
    tan: 0.3,
    characterization: 'paraffinic',
    isMarker: false,
    notes: 'Nigerian deepwater light sweet. ExxonMobil-operated FPSO.',
  },
  {
    slug: 'brass-river',
    name: 'Brass River',
    originCountry: 'NG',
    region: 'west-africa',
    apiGravity: 41,
    sulfurPct: 0.06,
    tan: 0.05,
    characterization: 'paraffinic',
    isMarker: false,
    notes: 'Nigerian very light sweet. Eni/NAOC-operated, Brass terminal.',
  },
  {
    slug: 'akpo',
    name: 'Akpo Blend',
    originCountry: 'NG',
    region: 'west-africa',
    apiGravity: 46,
    sulfurPct: 0.05,
    tan: 0.05,
    characterization: 'paraffinic',
    isMarker: false,
    notes: 'Nigerian deepwater condensate. TotalEnergies-operated.',
  },
  {
    slug: 'usan',
    name: 'Usan',
    originCountry: 'NG',
    region: 'west-africa',
    apiGravity: 30,
    sulfurPct: 0.21,
    tan: 0.4,
    characterization: 'paraffinic',
    isMarker: false,
    notes: 'Nigerian deepwater medium sweet. TotalEnergies-operated FPSO.',
  },
  {
    slug: 'agbami',
    name: 'Agbami',
    originCountry: 'NG',
    region: 'west-africa',
    apiGravity: 47,
    sulfurPct: 0.04,
    tan: 0.05,
    characterization: 'paraffinic',
    isMarker: false,
    notes: 'Nigerian deepwater very light sweet condensate. Chevron-operated.',
  },
  {
    slug: 'amenam-blend',
    name: 'Amenam Blend',
    originCountry: 'NG',
    region: 'west-africa',
    apiGravity: 38,
    sulfurPct: 0.10,
    tan: 0.1,
    characterization: 'paraffinic',
    isMarker: false,
    notes: 'Nigerian Niger Delta light sweet blend. TotalEnergies-operated.',
  },
  {
    slug: 'zafiro',
    name: 'Zafiro Blend',
    originCountry: 'GQ',
    region: 'west-africa',
    apiGravity: 31,
    sulfurPct: 0.27,
    tan: 0.2,
    characterization: 'paraffinic',
    isMarker: false,
    notes: 'Equatorial Guinea light sweet. ExxonMobil-operated.',
  },
  {
    slug: 'dalia',
    name: 'Dalia',
    originCountry: 'AO',
    region: 'west-africa',
    apiGravity: 24,
    sulfurPct: 0.50,
    tan: 0.6,
    characterization: 'naphthenic',
    isMarker: false,
    notes: 'Angolan Block 17 medium sweet. TotalEnergies-operated FPSO.',
  },
  {
    slug: 'girassol',
    name: 'Girassol',
    originCountry: 'AO',
    region: 'west-africa',
    apiGravity: 31,
    sulfurPct: 0.30,
    tan: 0.5,
    characterization: 'naphthenic',
    isMarker: false,
    notes: 'Angolan Block 17 medium sweet. TotalEnergies-operated FPSO.',
  },
  {
    slug: 'pazflor',
    name: 'Pazflor',
    originCountry: 'AO',
    region: 'west-africa',
    apiGravity: 24,
    sulfurPct: 0.40,
    tan: 0.6,
    characterization: 'naphthenic',
    isMarker: false,
    notes: 'Angolan Block 17 medium sour. TotalEnergies-operated FPSO.',
  },
  {
    slug: 'clov',
    name: 'CLOV',
    originCountry: 'AO',
    region: 'west-africa',
    apiGravity: 32,
    sulfurPct: 0.30,
    tan: 0.4,
    characterization: 'naphthenic',
    isMarker: false,
    notes: 'Angolan Block 17 (Cravo-Lirio-Orquidea-Violeta) medium sweet. TotalEnergies.',
  },
  {
    slug: 'mondo',
    name: 'Mondo',
    originCountry: 'AO',
    region: 'west-africa',
    apiGravity: 32,
    sulfurPct: 0.50,
    tan: 0.4,
    characterization: 'paraffinic',
    isMarker: false,
    notes: 'Angolan Block 15 light sweet. ExxonMobil-operated.',
  },
  {
    slug: 'hungo',
    name: 'Hungo Blend',
    originCountry: 'AO',
    region: 'west-africa',
    apiGravity: 30,
    sulfurPct: 0.45,
    tan: 0.5,
    characterization: 'paraffinic',
    isMarker: false,
    notes: 'Angolan Block 15 light sweet. ExxonMobil-operated.',
  },
  {
    slug: 'kissanje',
    name: 'Kissanje',
    originCountry: 'AO',
    region: 'west-africa',
    apiGravity: 30,
    sulfurPct: 0.40,
    tan: 0.5,
    characterization: 'paraffinic',
    isMarker: false,
    notes: 'Angolan Block 15 light sweet. ExxonMobil-operated.',
  },
  {
    slug: 'saturno',
    name: 'Saturno',
    originCountry: 'AO',
    region: 'west-africa',
    apiGravity: 31,
    sulfurPct: 0.40,
    tan: 0.4,
    characterization: 'naphthenic',
    isMarker: false,
    notes: 'Angolan Block 15 light sweet. ExxonMobil-operated.',
  },
  {
    slug: 'saxi-batuque',
    name: 'Saxi Batuque',
    originCountry: 'AO',
    region: 'west-africa',
    apiGravity: 31,
    sulfurPct: 0.35,
    tan: 0.4,
    characterization: 'naphthenic',
    isMarker: false,
    notes: 'Angolan Block 15 light sweet. ExxonMobil-operated.',
  },
  {
    slug: 'gindungo',
    name: 'Gindungo',
    originCountry: 'AO',
    region: 'west-africa',
    apiGravity: 41,
    sulfurPct: 0.10,
    tan: 0.1,
    characterization: 'paraffinic',
    isMarker: false,
    notes: 'Angolan condensate.',
  },
  {
    slug: 'mostarda',
    name: 'Mostarda',
    originCountry: 'AO',
    region: 'west-africa',
    apiGravity: 35,
    sulfurPct: 0.20,
    tan: 0.2,
    characterization: 'paraffinic',
    isMarker: false,
    notes: 'Angolan light sweet.',
  },
  {
    slug: 'nemba',
    name: 'Nemba',
    originCountry: 'AO',
    region: 'west-africa',
    apiGravity: 30,
    sulfurPct: 0.40,
    tan: 0.4,
    characterization: 'paraffinic',
    isMarker: false,
    notes: 'Angolan medium sweet — Block 14, Chevron-operated.',
  },
  {
    slug: 'nkossa-blend',
    name: 'Nkossa Blend',
    originCountry: 'CG',
    region: 'west-africa',
    apiGravity: 41,
    sulfurPct: 0.05,
    tan: 0.05,
    characterization: 'paraffinic',
    isMarker: false,
    notes: 'Republic of Congo condensate. TotalEnergies-operated.',
  },
  {
    slug: 'djeno',
    name: 'Djeno',
    originCountry: 'CG',
    region: 'west-africa',
    apiGravity: 26,
    sulfurPct: 0.25,
    tan: 0.5,
    characterization: 'naphthenic',
    isMarker: false,
    notes: 'Republic of Congo medium-heavy sweet. ENI-operated.',
  },
  {
    slug: 'mandji',
    name: 'Mandji',
    originCountry: 'GA',
    region: 'west-africa',
    apiGravity: 30,
    sulfurPct: 1.0,
    tan: 0.4,
    characterization: 'naphthenic',
    isMarker: false,
    notes: 'Gabon medium sour blend.',
  },

  // ── Brazil pre-salt ──────────────────────────────────────────
  {
    slug: 'mero',
    name: 'Mero',
    originCountry: 'BR',
    region: 'americas',
    apiGravity: 28,
    sulfurPct: 0.45,
    tan: 0.6,
    characterization: 'naphthenic',
    isMarker: false,
    notes:
      "Brazilian pre-salt (Libra block). Medium sweet — Petrobras' large-volume export grade.",
  },
  {
    slug: 'atapu',
    name: 'Atapu',
    originCountry: 'BR',
    region: 'americas',
    apiGravity: 28,
    sulfurPct: 0.40,
    tan: 0.7,
    characterization: 'naphthenic',
    isMarker: false,
    notes: 'Brazilian pre-salt medium sweet.',
  },
  {
    slug: 'sepia',
    name: 'Sepia',
    originCountry: 'BR',
    region: 'americas',
    apiGravity: 28,
    sulfurPct: 0.42,
    tan: 0.7,
    characterization: 'naphthenic',
    isMarker: false,
    notes: 'Brazilian pre-salt medium sweet.',
  },
  {
    slug: 'sururu',
    name: 'Sururu',
    originCountry: 'BR',
    region: 'americas',
    apiGravity: 28,
    sulfurPct: 0.40,
    tan: 0.6,
    characterization: 'naphthenic',
    isMarker: false,
    notes: 'Brazilian pre-salt medium sweet.',
  },
  {
    slug: 'bacalhau',
    name: 'Bacalhau',
    originCountry: 'BR',
    region: 'americas',
    apiGravity: 30,
    sulfurPct: 0.40,
    tan: 0.5,
    characterization: 'naphthenic',
    isMarker: false,
    notes: 'Brazilian pre-salt medium sweet. Equinor-operated.',
  },
  {
    slug: 'lapa',
    name: 'Lapa',
    originCountry: 'BR',
    region: 'americas',
    apiGravity: 26,
    sulfurPct: 0.35,
    tan: 0.5,
    characterization: 'naphthenic',
    isMarker: false,
    notes: 'Brazilian pre-salt medium sweet. TotalEnergies-operated FPSO.',
  },
  {
    slug: 'peregrino',
    name: 'Peregrino',
    originCountry: 'BR',
    region: 'americas',
    apiGravity: 13,
    sulfurPct: 1.0,
    tan: 1.5,
    characterization: 'naphthenic',
    isMarker: false,
    notes:
      'Brazilian Campos basin heavy sour. High TAN — needs corrosion-resistant metallurgy. Equinor-operated.',
  },
  {
    slug: 'roncador',
    name: 'Roncador',
    originCountry: 'BR',
    region: 'americas',
    apiGravity: 28,
    sulfurPct: 0.65,
    tan: 0.8,
    characterization: 'naphthenic',
    isMarker: false,
    notes: 'Brazilian Campos basin medium sour. Petrobras-operated.',
  },

  // ── US Gulf of Mexico + onshore ──────────────────────────────
  {
    slug: 'mars-blend',
    name: 'Mars Blend',
    originCountry: 'US',
    region: 'americas',
    apiGravity: 30,
    sulfurPct: 1.9,
    tan: 0.3,
    characterization: 'naphthenic',
    isMarker: false,
    notes:
      "GoM medium sour. Marker-grade — futures + spot widely quoted. Shell-operated, Clovelly LOOP delivery.",
  },
  {
    slug: 'thunder-horse',
    name: 'Thunder Horse',
    originCountry: 'US',
    region: 'americas',
    apiGravity: 35,
    sulfurPct: 0.85,
    tan: 0.2,
    characterization: 'paraffinic',
    isMarker: false,
    notes: 'GoM light sweet-medium. BP-operated FPS.',
  },
  {
    slug: 'southern-green-canyon',
    name: 'Southern Green Canyon',
    originCountry: 'US',
    region: 'americas',
    apiGravity: 28,
    sulfurPct: 2.1,
    tan: 0.3,
    characterization: 'naphthenic',
    isMarker: false,
    notes: 'GoM medium sour blend.',
  },
  {
    slug: 'bakken',
    name: 'Bakken',
    originCountry: 'US',
    region: 'americas',
    apiGravity: 42,
    sulfurPct: 0.10,
    tan: 0.05,
    characterization: 'paraffinic',
    isMarker: false,
    notes:
      'North Dakota tight oil. Light sweet — railed + pipelined to USGC + East Coast refineries.',
  },
  {
    slug: 'alaska-north-slope',
    name: 'Alaska North Slope',
    originCountry: 'US',
    region: 'americas',
    apiGravity: 31,
    sulfurPct: 1.0,
    tan: 0.2,
    characterization: 'naphthenic',
    isMarker: false,
    notes: 'ANS — TAPS pipeline to Valdez. Medium sour, supplies West Coast refineries.',
  },
  {
    slug: 'hls',
    name: 'Heavy Louisiana Sweet',
    originCountry: 'US',
    region: 'americas',
    apiGravity: 32,
    sulfurPct: 0.40,
    tan: 0.1,
    characterization: 'paraffinic',
    isMarker: false,
    notes: 'USGC light sweet aggregator. Pipeline-deliverable to St. James.',
  },
  {
    slug: 'lls',
    name: 'Light Louisiana Sweet',
    originCountry: 'US',
    region: 'americas',
    apiGravity: 38,
    sulfurPct: 0.40,
    tan: 0.1,
    characterization: 'paraffinic',
    isMarker: false,
    notes: 'USGC light sweet pricing point. Often quoted vs WTI Houston.',
  },
  {
    slug: 'domestic-sweet',
    name: 'Domestic Sweet',
    originCountry: 'US',
    region: 'americas',
    apiGravity: 38,
    sulfurPct: 0.30,
    tan: 0.1,
    characterization: 'paraffinic',
    isMarker: false,
    notes: 'Generic US light sweet aggregate (DSW). Cushing pricing.',
  },

  // ── Canada ───────────────────────────────────────────────────
  {
    slug: 'cold-lake-blend',
    name: 'Cold Lake Blend',
    originCountry: 'CA',
    region: 'americas',
    apiGravity: 21,
    sulfurPct: 3.6,
    tan: 0.7,
    characterization: 'mixed',
    isMarker: false,
    notes:
      'Canadian dilbit (cold-lake bitumen + diluent). Imperial-operated. USGC + Midwest complex refineries.',
  },
  {
    slug: 'kearl',
    name: 'Kearl',
    originCountry: 'CA',
    region: 'americas',
    apiGravity: 21,
    sulfurPct: 3.4,
    tan: 0.7,
    characterization: 'mixed',
    isMarker: false,
    notes: 'Canadian oil sands dilbit. Imperial/ExxonMobil-operated.',
  },
  {
    slug: 'fort-hills-dilbit',
    name: 'Fort Hills RCC Dilbit',
    originCountry: 'CA',
    region: 'americas',
    apiGravity: 21,
    sulfurPct: 3.5,
    tan: 0.7,
    characterization: 'mixed',
    isMarker: false,
    notes:
      "Fort Hills 'reduced carbon life cycle' dilbit. Suncor-operated; markets on the GHG-intensity differential.",
  },
  {
    slug: 'synbit',
    name: 'Synbit (Canadian)',
    originCountry: 'CA',
    region: 'americas',
    apiGravity: 22,
    sulfurPct: 3.2,
    tan: 0.6,
    characterization: 'mixed',
    isMarker: false,
    notes:
      'Synthetic + bitumen blend (no diluent). Heavy sour Canadian; rail + pipeline.',
  },

  // ── Middle East ──────────────────────────────────────────────
  {
    slug: 'murban',
    name: 'Murban',
    originCountry: 'AE',
    region: 'gulf',
    apiGravity: 40,
    sulfurPct: 0.78,
    tan: 0.1,
    characterization: 'paraffinic',
    isMarker: false,
    notes:
      'ADNOC flagship light sweet. Has its own ICE futures contract — competes with Brent for Asian refiners.',
  },
  {
    slug: 'al-shaheen',
    name: 'Al-Shaheen',
    originCountry: 'QA',
    region: 'gulf',
    apiGravity: 28,
    sulfurPct: 2.40,
    tan: 0.3,
    characterization: 'naphthenic',
    isMarker: false,
    notes: 'Qatar offshore medium sour. QatarEnergy-marketed; large monthly tender.',
  },
  {
    slug: 'al-jurf',
    name: 'Al-Jurf',
    originCountry: 'LY',
    region: 'mediterranean',
    apiGravity: 41,
    sulfurPct: 0.50,
    tan: 0.1,
    characterization: 'paraffinic',
    isMarker: false,
    notes: 'Libyan offshore light sweet. ENI-operated via Mellitah JV.',
  },
  {
    slug: 'das-blend',
    name: 'Das Blend',
    originCountry: 'AE',
    region: 'gulf',
    apiGravity: 39,
    sulfurPct: 1.10,
    tan: 0.1,
    characterization: 'paraffinic',
    isMarker: false,
    notes: 'ADNOC offshore light sour blend, Das Island terminal.',
  },
  {
    slug: 'qatar-marine',
    name: 'Qatar Marine',
    originCountry: 'QA',
    region: 'gulf',
    apiGravity: 36,
    sulfurPct: 1.40,
    tan: 0.1,
    characterization: 'paraffinic',
    isMarker: false,
    notes: 'Qatar offshore light sour. QatarEnergy-marketed.',
  },
  {
    slug: 'oman',
    name: 'Oman',
    originCountry: 'OM',
    region: 'gulf',
    apiGravity: 33,
    sulfurPct: 1.40,
    tan: 0.2,
    characterization: 'naphthenic',
    isMarker: false,
    notes:
      'Oman blend — co-marker (DME futures settle into physical Oman). Asia-bound medium sour.',
  },
  {
    slug: 'upper-zakum',
    name: 'Upper Zakum',
    originCountry: 'AE',
    region: 'gulf',
    apiGravity: 33,
    sulfurPct: 1.80,
    tan: 0.2,
    characterization: 'naphthenic',
    isMarker: false,
    notes: 'ADNOC offshore medium sour. Term + spot to Asian refiners.',
  },
  {
    slug: 'el-sharara',
    name: 'El-Sharara',
    originCountry: 'LY',
    region: 'mediterranean',
    apiGravity: 43,
    sulfurPct: 0.07,
    tan: 0.05,
    characterization: 'paraffinic',
    isMarker: false,
    notes:
      'Libyan light sweet from the Sharara field (synonymous with Sharara — kept as a separate slug to match producer-published naming).',
  },

  // ── Asia / Oceania ───────────────────────────────────────────
  {
    slug: 'tapis',
    name: 'Tapis',
    originCountry: 'MY',
    region: 'asia-pacific',
    apiGravity: 43,
    sulfurPct: 0.04,
    tan: 0.05,
    characterization: 'paraffinic',
    isMarker: true,
    notes:
      'Malaysian very light sweet — Asia-Pacific marker for light sweet pricing. Petronas-operated.',
  },
  {
    slug: 'minas',
    name: 'Minas',
    originCountry: 'ID',
    region: 'asia-pacific',
    apiGravity: 35,
    sulfurPct: 0.08,
    tan: 0.4,
    characterization: 'paraffinic',
    isMarker: false,
    notes: 'Indonesian Sumatran heavy sweet. High wax content — needs heat for transport.',
  },
  {
    slug: 'duri',
    name: 'Duri',
    originCountry: 'ID',
    region: 'asia-pacific',
    apiGravity: 21,
    sulfurPct: 0.18,
    tan: 0.3,
    characterization: 'naphthenic',
    isMarker: false,
    notes: 'Indonesian Sumatran heavy sweet. Specialty asphalt feedstock.',
  },
  {
    slug: 'handil-mix',
    name: 'Handil Mix',
    originCountry: 'ID',
    region: 'asia-pacific',
    apiGravity: 36,
    sulfurPct: 0.05,
    tan: 0.05,
    characterization: 'paraffinic',
    isMarker: false,
    notes: 'Indonesian East Kalimantan light sweet. TotalEnergies-operated.',
  },
  {
    slug: 'gippsland',
    name: 'Gippsland',
    originCountry: 'AU',
    region: 'asia-pacific',
    apiGravity: 53,
    sulfurPct: 0.05,
    tan: 0.05,
    characterization: 'paraffinic',
    isMarker: false,
    notes: 'Australian Bass Strait condensate. ExxonMobil-operated.',
  },
  {
    slug: 'gorgon',
    name: 'Gorgon',
    originCountry: 'AU',
    region: 'asia-pacific',
    apiGravity: 56,
    sulfurPct: 0.02,
    tan: 0.05,
    characterization: 'paraffinic',
    isMarker: false,
    notes: 'Australian Carnarvon basin condensate. Chevron-operated LNG associated.',
  },
  {
    slug: 'north-west-shelf-condensate',
    name: 'North West Shelf Condensate',
    originCountry: 'AU',
    region: 'asia-pacific',
    apiGravity: 60,
    sulfurPct: 0.02,
    tan: 0.05,
    characterization: 'paraffinic',
    isMarker: false,
    notes: 'Australian condensate (Woodside-operated NWS LNG project).',
  },
  {
    slug: 'cossack',
    name: 'Cossack',
    originCountry: 'AU',
    region: 'asia-pacific',
    apiGravity: 47,
    sulfurPct: 0.04,
    tan: 0.05,
    characterization: 'paraffinic',
    isMarker: false,
    notes: 'Australian Carnarvon basin light sweet condensate.',
  },
  {
    slug: 'kutubu',
    name: 'Kutubu',
    originCountry: 'PG',
    region: 'asia-pacific',
    apiGravity: 44,
    sulfurPct: 0.04,
    tan: 0.05,
    characterization: 'paraffinic',
    isMarker: false,
    notes: 'PNG Highlands light sweet. Loaded at Kumul terminal.',
  },
  {
    slug: 'banyu-urip',
    name: 'Banyu Urip',
    originCountry: 'ID',
    region: 'asia-pacific',
    apiGravity: 33,
    sulfurPct: 0.30,
    tan: 0.2,
    characterization: 'paraffinic',
    isMarker: false,
    notes: 'Indonesian Cepu block light sweet. ExxonMobil-operated.',
  },

  // ── Latam South America ──────────────────────────────────────
  {
    slug: 'liza',
    name: 'Liza',
    originCountry: 'GY',
    region: 'americas',
    apiGravity: 32,
    sulfurPct: 0.55,
    tan: 0.3,
    characterization: 'paraffinic',
    isMarker: false,
    notes: 'Guyanese Stabroek block medium sweet. ExxonMobil-operated; rapid volume ramp post-2020.',
  },
  {
    slug: 'payara',
    name: 'Payara Gold',
    originCountry: 'GY',
    region: 'americas',
    apiGravity: 27,
    sulfurPct: 0.65,
    tan: 0.4,
    characterization: 'naphthenic',
    isMarker: false,
    notes: 'Guyanese Stabroek block medium sweet (heavier than Liza). ExxonMobil-operated.',
  },
  {
    slug: 'medanito',
    name: 'Medanito',
    originCountry: 'AR',
    region: 'americas',
    apiGravity: 36,
    sulfurPct: 0.40,
    tan: 0.2,
    characterization: 'paraffinic',
    isMarker: false,
    notes: 'Argentine Vaca Muerta light sweet. Loaded from Bahía Blanca.',
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
