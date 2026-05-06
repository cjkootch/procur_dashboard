/**
 * ML Layer Phase 2 (days 1-3) — heterogeneous graph extraction for
 * Component B (GraphSAGE training pipeline).
 *
 * Per docs/procur-ml-layer-brief.md §5.2 + §5.3. Walks procur's
 * Postgres schema to produce a PyG-compatible JSON dump:
 *   - Per-node-type feature matrices (one-hot + bucketed numerics)
 *   - Per-edge-type edge_index lists with weights
 *   - Index maps for round-tripping back to slugs / IDs
 *
 * The Python training side (PyTorch Geometric GraphSAGE in
 * services/ai-pipeline) loads this file and trains. Output is
 * intentionally JSON not Parquet/Arrow — at procur's likely scale
 * (10K-100K entities) the files stay under 100MB and JSON keeps
 * the format obvious for debugging.
 *
 * Coverage in v1 (what's safely extractable from procur today):
 *
 * Node types:
 *   - entity      (known_entities)
 *   - vessel      (vessels)
 *   - port        (ports)
 *   - crude_grade (crude_grades)
 *
 * Edge types:
 *   - entity-owns-entity      (entity_ownership, fuzzy-matched to slugs)
 *   - entity-located-port     (lat/long proximity within 5km)
 *   - vessel-called-port      (cargo_trips load + discharge)
 *   - vessel-carried-grade    (cargo_trips.inferred_grade_slug)
 *   - port-handles-grade      (ports.known_grades array)
 *
 * Deferred to v2 (per brief §5.2 but data infra not yet in procur):
 *   - entity-operates-vessel  (no operator field on vessels)
 *   - entity-trades-grade     (needs operator → vessel chain)
 *   - entity-mentioned-signal (signal-as-node would explode graph size; v1 keeps signals out)
 *   - entity-counterparty-entity (derive from awards once shape is stable)
 *
 * Run from repo root:
 *   pnpm --filter @procur/db extract-graph --output graph.json
 *   pnpm --filter @procur/db extract-graph --output graph.json --country=JM
 *   pnpm --filter @procur/db extract-graph --output graph.json --stats-only
 */
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { writeFile } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { sql } from 'drizzle-orm';
import { db } from './client';

loadEnv({ path: '../../.env.local' });
loadEnv({ path: '../../.env' });

// ─── Output format ─────────────────────────────────────────────────

type NodeId = string;

type GraphOutput = {
  metadata: {
    extractedAt: string;
    procurCommit: string | null;
    countryFilter: string | null;
    targetEntitySlug: string | null;
    featureDims: Record<NodeType, number>;
    featureNames: Record<NodeType, string[]>;
    edgeTypes: EdgeType[];
    nodeCounts: Record<NodeType, number>;
    edgeCounts: Record<EdgeType, number>;
  };
  nodes: Record<
    NodeType,
    {
      ids: NodeId[];
      features: number[][];
    }
  >;
  edges: Record<
    EdgeType,
    Array<{
      src: number; // index into source-type nodes
      dst: number; // index into dest-type nodes
      weight: number; // 0-1
      // Edge-type-specific attributes — kept loose-typed so the Python
      // side can pick what it needs without re-extracting.
      attrs?: Record<string, number | string | null>;
    }>
  >;
};

type NodeType = 'entity' | 'vessel' | 'port' | 'crude_grade';
type EdgeType =
  | 'entity-owns-entity'
  | 'entity-located-port'
  | 'vessel-called-port'
  | 'vessel-carried-grade'
  | 'port-handles-grade';

// ─── Vocabularies (must match feature_names ordering at training time) ───

// Top categories surfaced via known_entities.categories arrays. Captures
// the segment one-hot referenced in brief §5.3. Picking 16 covers the
// long tail of what procur tracks; rare categories collapse into "other".
const CATEGORY_VOCAB = [
  'crude-oil',
  'diesel',
  'gasoline',
  'jet-fuel',
  'heavy-fuel-oil',
  'lpg',
  'lng',
  'food-commodities',
  'agriculture',
  'bauxite',
  'alumina',
  'gold',
  'nickel',
  'cement',
  'steel',
  'other',
] as const;

// known_entities.role — capture the dominant procur roles. New roles
// land as 'other'; widen the vocab as the rolodex grows.
const ROLE_VOCAB = [
  'refiner',
  'producer',
  'trader',
  'buyer',
  'state-buyer',
  'power-plant',
  'utility',
  'marine-operator',
  'mining',
  'industrial',
  'other',
] as const;

// Compact region encoding — matches the freight-region taxonomy procur
// already uses elsewhere. Keeps feature dim modest while preserving
// the geography signal that drives counterparty similarity.
const REGION_VOCAB = [
  'caribbean',
  'us_gulf',
  'us_east',
  'us_west',
  'mediterranean',
  'nw_europe',
  'middle_east',
  'india',
  'east_asia',
  'southeast_asia',
  'west_africa',
  'south_america',
  'central_america',
  'other',
] as const;

const VESSEL_TYPE_VOCAB = [
  'crude-tanker',
  'product-tanker',
  'lng',
  'lpg',
  'chemical',
  'cargo',
  'container',
  'bulker',
  'cruise',
  'other',
] as const;

const PORT_TYPE_VOCAB = [
  'crude_terminal',
  'product_terminal',
  'lng_terminal',
  'lpg_terminal',
  'bunker_port',
  'container',
  'general_cargo',
  'cruise',
  'other',
] as const;

const COUNTRY_TO_REGION: Record<string, (typeof REGION_VOCAB)[number]> = {
  // Caribbean basin
  JM: 'caribbean', DO: 'caribbean', HT: 'caribbean', CU: 'caribbean',
  TT: 'caribbean', BB: 'caribbean', BS: 'caribbean', PR: 'caribbean',
  GD: 'caribbean', LC: 'caribbean', VC: 'caribbean', AG: 'caribbean',
  KN: 'caribbean', DM: 'caribbean', VG: 'caribbean', AI: 'caribbean',
  GY: 'caribbean', SR: 'caribbean', BZ: 'caribbean',
  // US sub-regions — rough Gulf vs East vs West
  US: 'us_gulf', // default; many seeds will have specific lat/long; refine later
  // Med
  IT: 'mediterranean', GR: 'mediterranean', ES: 'mediterranean',
  PT: 'mediterranean', MT: 'mediterranean', CY: 'mediterranean',
  HR: 'mediterranean', TR: 'mediterranean', IL: 'mediterranean',
  EG: 'mediterranean', LY: 'mediterranean', TN: 'mediterranean',
  DZ: 'mediterranean', MA: 'mediterranean',
  // NW Europe
  NL: 'nw_europe', BE: 'nw_europe', DE: 'nw_europe', FR: 'nw_europe',
  GB: 'nw_europe', NO: 'nw_europe', SE: 'nw_europe', DK: 'nw_europe',
  FI: 'nw_europe', IE: 'nw_europe', PL: 'nw_europe',
  // Middle East
  SA: 'middle_east', AE: 'middle_east', KW: 'middle_east', QA: 'middle_east',
  OM: 'middle_east', BH: 'middle_east', IQ: 'middle_east', IR: 'middle_east',
  YE: 'middle_east', JO: 'middle_east', LB: 'middle_east',
  // Asia
  IN: 'india', PK: 'india', BD: 'india', LK: 'india',
  CN: 'east_asia', JP: 'east_asia', KR: 'east_asia', TW: 'east_asia',
  HK: 'east_asia',
  ID: 'southeast_asia', MY: 'southeast_asia', SG: 'southeast_asia',
  TH: 'southeast_asia', VN: 'southeast_asia', PH: 'southeast_asia',
  MM: 'southeast_asia',
  // Africa
  NG: 'west_africa', AO: 'west_africa', GA: 'west_africa', GH: 'west_africa',
  CI: 'west_africa', CM: 'west_africa', SN: 'west_africa',
  // South America
  BR: 'south_america', AR: 'south_america', CL: 'south_america',
  PE: 'south_america', CO: 'south_america', VE: 'south_america',
  EC: 'south_america',
  // Central America
  MX: 'central_america', PA: 'central_america', GT: 'central_america',
  CR: 'central_america', NI: 'central_america', HN: 'central_america',
  SV: 'central_america',
};

function regionOf(country: string | null): (typeof REGION_VOCAB)[number] {
  if (!country) return 'other';
  return COUNTRY_TO_REGION[country.toUpperCase()] ?? 'other';
}

function oneHot<const T extends readonly string[]>(
  vocab: T,
  value: string | null,
): number[] {
  return vocab.map((v) => (v === value ? 1 : 0));
}

function multiHot<const T extends readonly string[]>(
  vocab: T,
  values: (string | null)[] | null,
): number[] {
  if (!values) return vocab.map(() => 0);
  const set = new Set(values.filter((v): v is string => !!v));
  return vocab.map((v) => (set.has(v) ? 1 : 0));
}

/** Bucket a numeric value (e.g. DWT, capacity) into log2-spaced bins. */
function logBucket(value: number | null, edges: number[]): number[] {
  const out = edges.map(() => 0);
  if (value == null || value <= 0) return out;
  let bucket = edges.findIndex((e) => value <= e);
  if (bucket < 0) bucket = edges.length - 1;
  out[bucket] = 1;
  return out;
}

const DWT_EDGES = [25_000, 60_000, 120_000, 200_000, 320_000, Infinity]; // small/MR/LR/Aframax/VLCC/ULCC
const ENTITY_SCALE_EDGES = [50_000, 200_000, 500_000, 2_000_000, Infinity]; // bbl/yr or capacity proxy

// ─── Feature builders ──────────────────────────────────────────────

function buildEntityFeatureNames(): string[] {
  return [
    ...CATEGORY_VOCAB.map((c) => `cat:${c}`),
    ...ROLE_VOCAB.map((r) => `role:${r}`),
    ...REGION_VOCAB.map((r) => `region:${r}`),
    ...ENTITY_SCALE_EDGES.map((e, i) => `scale:bucket_${i}_le_${e === Infinity ? 'inf' : e}`),
    'has_lat_long',
    'apollo_matched',
    'has_apollo_funding',
  ];
}

type EntityRow = {
  slug: string;
  country: string;
  role: string;
  categories: string[] | null;
  latitude: number | null;
  longitude: number | null;
  metadata: Record<string, unknown> | null;
  apollo_org_id: string | null;
  apollo_total_funding: number | null;
};

function entityFeatures(e: EntityRow): number[] {
  // Pick a scale proxy from metadata — capacity_bpd, fleet_size_approx,
  // capacity_mw, etc. Many entities won't have one; that's fine — feature
  // is a one-hot bucket, all-zero for unscaled entities.
  const m = e.metadata ?? {};
  const scaleProxy =
    typeof m.capacity_bpd === 'number'
      ? Number(m.capacity_bpd) * 365
      : typeof m.capacity_mw === 'number'
        ? Number(m.capacity_mw) * 8760 * 0.55 // very rough — power MWh/yr at ~55% utilization
        : typeof m.fleet_size_approx === 'number'
          ? Number(m.fleet_size_approx) * 100_000 // proxy: 100k bbl/yr per vessel
          : typeof m.totalCapacityMw === 'number'
            ? Number(m.totalCapacityMw) * 8760 * 0.55
            : null;

  // Categories: take all from the array, fall back to 'other'
  const cats = e.categories && e.categories.length > 0 ? e.categories : ['other'];

  return [
    ...multiHot(CATEGORY_VOCAB, cats),
    ...oneHot(ROLE_VOCAB, ROLE_VOCAB.includes(e.role as (typeof ROLE_VOCAB)[number]) ? e.role : 'other'),
    ...oneHot(REGION_VOCAB, regionOf(e.country)),
    ...logBucket(scaleProxy, ENTITY_SCALE_EDGES),
    e.latitude != null && e.longitude != null ? 1 : 0,
    e.apollo_org_id != null ? 1 : 0,
    e.apollo_total_funding != null && e.apollo_total_funding > 0 ? 1 : 0,
  ];
}

function buildVesselFeatureNames(): string[] {
  return [
    ...VESSEL_TYPE_VOCAB.map((t) => `type:${t}`),
    ...REGION_VOCAB.map((r) => `flag_region:${r}`),
    ...DWT_EDGES.map((e, i) => `dwt:bucket_${i}_le_${e === Infinity ? 'inf' : e}`),
    'has_imo',
    'recent_seen', // last_seen within 90d
  ];
}

type VesselRow = {
  mmsi: string;
  imo: string | null;
  ship_type_label: string | null;
  flag_country: string | null;
  dwt: number | null;
  last_seen_at: Date | null;
};

function vesselFeatures(v: VesselRow): number[] {
  const recentSeen = v.last_seen_at
    ? Date.now() - v.last_seen_at.getTime() < 90 * 86400 * 1000
    : false;
  return [
    ...oneHot(
      VESSEL_TYPE_VOCAB,
      VESSEL_TYPE_VOCAB.includes(v.ship_type_label as (typeof VESSEL_TYPE_VOCAB)[number])
        ? v.ship_type_label
        : 'other',
    ),
    ...oneHot(REGION_VOCAB, regionOf(v.flag_country)),
    ...logBucket(v.dwt, DWT_EDGES),
    v.imo != null ? 1 : 0,
    recentSeen ? 1 : 0,
  ];
}

function buildPortFeatureNames(): string[] {
  return [
    ...PORT_TYPE_VOCAB.map((t) => `type:${t}`),
    ...REGION_VOCAB.map((r) => `region:${r}`),
  ];
}

type PortRow = {
  slug: string;
  country: string;
  port_type: string | null;
};

function portFeatures(p: PortRow): number[] {
  return [
    ...oneHot(
      PORT_TYPE_VOCAB,
      PORT_TYPE_VOCAB.includes(p.port_type as (typeof PORT_TYPE_VOCAB)[number])
        ? p.port_type
        : 'other',
    ),
    ...oneHot(REGION_VOCAB, regionOf(p.country)),
  ];
}

function buildCrudeGradeFeatureNames(): string[] {
  return [
    'api_gravity_norm', // numeric, normalized 0-1 around typical 5-50 API
    'sulfur_pct_norm',  // numeric, normalized 0-1 around typical 0-5%
    ...REGION_VOCAB.map((r) => `source_region:${r}`),
  ];
}

type CrudeGradeRow = {
  slug: string;
  api_gravity: number | null;
  sulfur_pct: number | null;
  source_country: string | null;
};

function crudeGradeFeatures(g: CrudeGradeRow): number[] {
  const apiNorm = g.api_gravity != null ? Math.max(0, Math.min(1, (g.api_gravity - 5) / 45)) : 0;
  const sulfurNorm = g.sulfur_pct != null ? Math.max(0, Math.min(1, g.sulfur_pct / 5)) : 0;
  return [apiNorm, sulfurNorm, ...oneHot(REGION_VOCAB, regionOf(g.source_country))];
}

// ─── Edge builders ─────────────────────────────────────────────────

/** Haversine distance in km between two lat/long points. */
function kmBetween(
  lat1: number, lon1: number,
  lat2: number, lon2: number,
): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ─── Main ──────────────────────────────────────────────────────────

function resolveUserPath(p: string): string {
  if (isAbsolute(p)) return p;
  const baseDir = process.env.INIT_CWD ?? process.cwd();
  return resolve(baseDir, p);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outputArg = args.find((a) => a.startsWith('--output='));
  const countryArg = args.find((a) => a.startsWith('--country='));
  const singleEntityArg = args.find((a) => a.startsWith('--single-entity='));
  const statsOnly = args.includes('--stats-only');
  const output = outputArg ? outputArg.split('=')[1] ?? '' : 'graph.json';
  const country = countryArg ? (countryArg.split('=')[1] ?? '').toUpperCase() || null : null;
  const singleEntity = singleEntityArg ? (singleEntityArg.split('=')[1] ?? '') || null : null;

  console.log(
    `extract-graph — output=${output}, country=${country ?? 'ALL'}, ` +
      `singleEntity=${singleEntity ?? 'none'}, statsOnly=${statsOnly}`,
  );

  // ─── Single-entity neighborhood resolution ────────────────────
  // For inductive inference (Component B days 11-13 per brief §5.4):
  // restrict the graph to the target entity + its 1-hop neighborhood
  // across all node types. Drops the 5-min trgm-match cost for the
  // ownership edges down to <1s.
  let entitySlugFilter: string[] | null = null;
  let portSlugFilter: string[] | null = null;
  let vesselMmsiFilter: string[] | null = null;
  let gradeSlugFilter: string[] | null = null;

  if (singleEntity) {
    const target = (await db.execute(sql`
      SELECT slug, latitude::float8 AS latitude, longitude::float8 AS longitude
        FROM known_entities WHERE slug = ${singleEntity}
    `)) as unknown as Array<{ slug: string; latitude: number | null; longitude: number | null }>;
    if (target.length === 0 || !target[0]) {
      console.error(`single-entity slug not found in known_entities: ${singleEntity}`);
      process.exit(1);
    }
    const t = target[0];

    // 1-hop entities — target + ownership-connected (fuzzy-matched
    // via the name → slug link). One join query covers the whole
    // walk so we avoid the per-row trgm overhead of the full extract.
    const ownerNeighbors = (await db.execute(sql`
      WITH target AS (SELECT name FROM known_entities WHERE slug = ${singleEntity})
      SELECT DISTINCT ke.slug
        FROM entity_ownership eo
        JOIN known_entities ke
          ON similarity(ke.name, eo.subject_name) > 0.55
          OR similarity(ke.name, eo.parent_name) > 0.55
       WHERE EXISTS (
               SELECT 1 FROM target
                WHERE similarity(eo.subject_name, target.name) > 0.55
                   OR similarity(eo.parent_name, target.name) > 0.55
             );
    `)) as unknown as Array<{ slug: string }>;
    const slugs = new Set<string>([singleEntity]);
    for (const r of ownerNeighbors) slugs.add(r.slug);
    entitySlugFilter = [...slugs];

    // 1-hop ports — within 5km of target's lat/long. If target has
    // no coords, port filter is empty (no port edges anyway).
    if (t.latitude != null && t.longitude != null) {
      const portCoords = (await db.execute(sql`
        SELECT slug, lat::float8 AS lat, lng::float8 AS lng FROM ports
      `)) as unknown as Array<{ slug: string; lat: number; lng: number }>;
      const nearbyPorts = portCoords.filter(
        (p) => kmBetween(t.latitude as number, t.longitude as number, p.lat, p.lng) <= 5,
      );
      portSlugFilter = nearbyPorts.map((p) => p.slug);
    } else {
      portSlugFilter = [];
    }

    // 1-hop vessels — those that called any nearby port in last 24mo
    if (portSlugFilter.length > 0) {
      const vesselRows = (await db.execute(sql`
        SELECT DISTINCT mmsi FROM cargo_trips
         WHERE (load_port_slug = ANY(ARRAY[${sql.join(
           portSlugFilter.map((p) => sql`${p}`),
           sql`, `,
         )}]::text[])
            OR discharge_port_slug = ANY(ARRAY[${sql.join(
              portSlugFilter.map((p) => sql`${p}`),
              sql`, `,
            )}]::text[]))
           AND inferred_at >= NOW() - INTERVAL '24 months';
      `)) as unknown as Array<{ mmsi: string }>;
      vesselMmsiFilter = vesselRows.map((v) => v.mmsi);
    } else {
      vesselMmsiFilter = [];
    }

    // 1-hop grades — handled by nearby ports OR carried by 1-hop vessels
    const gradesFromPorts = (portSlugFilter.length > 0
      ? ((await db.execute(sql`
          SELECT DISTINCT unnest(known_grades) AS slug
            FROM ports
           WHERE slug = ANY(ARRAY[${sql.join(
             portSlugFilter.map((p) => sql`${p}`),
             sql`, `,
           )}]::text[])
             AND known_grades IS NOT NULL;
        `).catch(() => [] as Array<unknown>)) as unknown as Array<{ slug: string }>)
      : []);
    const gradesFromVessels =
      vesselMmsiFilter.length > 0
        ? ((await db.execute(sql`
            SELECT DISTINCT inferred_grade_slug AS slug
              FROM cargo_trips
             WHERE inferred_grade_slug IS NOT NULL
               AND mmsi = ANY(ARRAY[${sql.join(
                 vesselMmsiFilter.map((m) => sql`${m}`),
                 sql`, `,
               )}]::text[]);
          `)) as unknown as Array<{ slug: string }>)
        : [];
    gradeSlugFilter = [
      ...new Set([
        ...gradesFromPorts.map((g) => g.slug),
        ...gradesFromVessels.map((g) => g.slug),
      ]),
    ];

    console.log(
      `  neighborhood: entities=${entitySlugFilter.length}, ports=${portSlugFilter.length}, vessels=${vesselMmsiFilter.length}, grades=${gradeSlugFilter.length}`,
    );
  }

  // ─── Nodes ────────────────────────────────────────────────────
  const entityRows = (await (entitySlugFilter
    ? db.execute(sql`
        SELECT slug, country, role, categories, latitude::float8 AS latitude, longitude::float8 AS longitude,
               metadata, apollo_org_id, apollo_total_funding
          FROM known_entities
         WHERE slug = ANY(ARRAY[${sql.join(
           entitySlugFilter.map((s) => sql`${s}`),
           sql`, `,
         )}]::text[])
      `)
    : country
    ? db.execute(sql`
        SELECT slug, country, role, categories, latitude::float8 AS latitude, longitude::float8 AS longitude,
               metadata, apollo_org_id, apollo_total_funding
          FROM known_entities
         WHERE country = ${country}
      `)
    : db.execute(sql`
        SELECT slug, country, role, categories, latitude::float8 AS latitude, longitude::float8 AS longitude,
               metadata, apollo_org_id, apollo_total_funding
          FROM known_entities
      `))) as unknown as EntityRow[];

  const vesselRows = (await (vesselMmsiFilter
    ? vesselMmsiFilter.length === 0
      ? Promise.resolve([] as unknown[])
      : db.execute(sql`
          SELECT mmsi, imo, ship_type_label, flag_country, dwt, last_seen_at
            FROM vessels
           WHERE mmsi = ANY(ARRAY[${sql.join(
             vesselMmsiFilter.map((m) => sql`${m}`),
             sql`, `,
           )}]::text[])
        `)
    : db.execute(sql`
        SELECT mmsi, imo, ship_type_label, flag_country, dwt, last_seen_at
          FROM vessels
      `))) as unknown as VesselRow[];

  const portRows = (await (portSlugFilter
    ? portSlugFilter.length === 0
      ? Promise.resolve([] as unknown[])
      : db.execute(sql`
          SELECT slug, country, port_type FROM ports
           WHERE slug = ANY(ARRAY[${sql.join(
             portSlugFilter.map((p) => sql`${p}`),
             sql`, `,
           )}]::text[])
        `)
    : country
    ? db.execute(sql`
        SELECT slug, country, port_type FROM ports WHERE country = ${country}
      `)
    : db.execute(sql`SELECT slug, country, port_type FROM ports`))) as unknown as PortRow[];

  // crude_grades schema may not have all the fields we'd want. Fall back
  // gracefully: pull whatever's there + null out missing.
  const crudeGradeRows = (await (gradeSlugFilter
    ? gradeSlugFilter.length === 0
      ? Promise.resolve([] as unknown[])
      : db.execute(sql`
          SELECT slug,
                 NULLIF(api_gravity, NULL)::float8 AS api_gravity,
                 NULLIF(sulfur_pct, NULL)::float8 AS sulfur_pct,
                 source_country
            FROM crude_grades
           WHERE slug = ANY(ARRAY[${sql.join(
             gradeSlugFilter.map((g) => sql`${g}`),
             sql`, `,
           )}]::text[])
        `).catch(async () => {
          const fallback = (await db.execute(sql`
            SELECT slug FROM crude_grades
             WHERE slug = ANY(ARRAY[${sql.join(
               (gradeSlugFilter as string[]).map((g) => sql`${g}`),
               sql`, `,
             )}]::text[])
          `)) as unknown as Array<{ slug: string }>;
          return fallback.map((r) => ({
            slug: r.slug,
            api_gravity: null,
            sulfur_pct: null,
            source_country: null,
          }));
        })
    : db.execute(sql`
        SELECT slug,
               NULLIF(api_gravity, NULL)::float8 AS api_gravity,
               NULLIF(sulfur_pct, NULL)::float8 AS sulfur_pct,
               source_country
          FROM crude_grades
      `).catch(async () => {
        const fallback = (await db.execute(sql`SELECT slug FROM crude_grades`)) as unknown as Array<{ slug: string }>;
        return fallback.map((r) => ({
          slug: r.slug,
          api_gravity: null,
          sulfur_pct: null,
          source_country: null,
        }));
      }))) as unknown as CrudeGradeRow[];

  console.log(
    `\n  nodes loaded: entity=${entityRows.length}, vessel=${vesselRows.length}, port=${portRows.length}, crude_grade=${crudeGradeRows.length}`,
  );

  const entityIndex = new Map(entityRows.map((e, i) => [e.slug, i]));
  const portIndex = new Map(portRows.map((p, i) => [p.slug, i]));
  const vesselIndex = new Map(vesselRows.map((v, i) => [v.mmsi, i]));
  const gradeIndex = new Map(crudeGradeRows.map((g, i) => [g.slug, i]));

  // ─── Edges ────────────────────────────────────────────────────
  const edges: GraphOutput['edges'] = {
    'entity-owns-entity': [],
    'entity-located-port': [],
    'vessel-called-port': [],
    'vessel-carried-grade': [],
    'port-handles-grade': [],
  };

  // entity-located-port: lat/long proximity within 5km. Naive O(N×M)
  // — fine at procur scale (~5K entities × ~1K ports). If it becomes
  // hot, swap for a quadtree.
  // weight = exp(-dKm) so 0km=1, 5km≈0.0067 — captures "AT this port"
  // intuition without a hard binary cutoff.
  const portCoordRows = (await db.execute(sql`
    SELECT slug, lat::float8 AS lat, lng::float8 AS lng FROM ports
  `)) as unknown as Array<{ slug: string; lat: number; lng: number }>;
  for (const e of entityRows) {
    if (e.latitude == null || e.longitude == null) continue;
    const eIdx = entityIndex.get(e.slug);
    if (eIdx == null) continue;
    for (const p of portCoordRows) {
      const dKm = kmBetween(e.latitude, e.longitude, p.lat, p.lng);
      if (dKm > 5) continue;
      const pIdx = portIndex.get(p.slug);
      if (pIdx == null) continue;
      edges['entity-located-port'].push({
        src: eIdx,
        dst: pIdx,
        weight: Math.exp(-dKm),
        attrs: { dist_km: dKm },
      });
    }
  }

  // vessel-called-port: from cargo_trips load + discharge ports.
  // Constrain to filtered vessels when in single-entity mode so we
  // don't scan all 24mo of cargo_trips for one entity's neighborhood.
  const cargoTripRows = (vesselMmsiFilter && vesselMmsiFilter.length === 0
    ? ([] as unknown[])
    : await db.execute(vesselMmsiFilter
        ? sql`
            SELECT mmsi, load_port_slug, discharge_port_slug, inferred_grade_slug,
                   inferred_volume_bbl, confidence::float8 AS confidence
              FROM cargo_trips
             WHERE inferred_at >= NOW() - INTERVAL '24 months'
               AND mmsi = ANY(ARRAY[${sql.join(
                 vesselMmsiFilter.map((m) => sql`${m}`),
                 sql`, `,
               )}]::text[])
          `
        : sql`
            SELECT mmsi, load_port_slug, discharge_port_slug, inferred_grade_slug,
                   inferred_volume_bbl, confidence::float8 AS confidence
              FROM cargo_trips
             WHERE inferred_at >= NOW() - INTERVAL '24 months'
          `)) as unknown as Array<{
    mmsi: string;
    load_port_slug: string;
    discharge_port_slug: string;
    inferred_grade_slug: string | null;
    inferred_volume_bbl: string | null;
    confidence: number;
  }>;

  for (const t of cargoTripRows) {
    const vIdx = vesselIndex.get(t.mmsi);
    if (vIdx == null) continue;
    const loadIdx = portIndex.get(t.load_port_slug);
    const dischargeIdx = portIndex.get(t.discharge_port_slug);
    if (loadIdx != null) {
      edges['vessel-called-port'].push({
        src: vIdx,
        dst: loadIdx,
        weight: t.confidence,
        attrs: { role: 'load' },
      });
    }
    if (dischargeIdx != null) {
      edges['vessel-called-port'].push({
        src: vIdx,
        dst: dischargeIdx,
        weight: t.confidence,
        attrs: { role: 'discharge' },
      });
    }
    // vessel-carried-grade
    if (t.inferred_grade_slug) {
      const gIdx = gradeIndex.get(t.inferred_grade_slug);
      if (gIdx != null) {
        edges['vessel-carried-grade'].push({
          src: vIdx,
          dst: gIdx,
          weight: t.confidence,
        });
      }
    }
  }

  // port-handles-grade: from ports.known_grades array
  const portGradeRows = (await db.execute(sql`
    SELECT slug, known_grades FROM ports WHERE known_grades IS NOT NULL
  `).catch(() => [] as Array<unknown>)) as unknown as Array<{
    slug: string;
    known_grades: string[] | null;
  }>;
  for (const p of portGradeRows) {
    if (!p.known_grades) continue;
    const pIdx = portIndex.get(p.slug);
    if (pIdx == null) continue;
    for (const gradeSlug of p.known_grades) {
      const gIdx = gradeIndex.get(gradeSlug);
      if (gIdx == null) continue;
      edges['port-handles-grade'].push({ src: pIdx, dst: gIdx, weight: 1.0 });
    }
  }

  // entity-owns-entity: fuzzy-match subject_name + parent_name to
  // known_entities slugs. In single-entity mode constrain to ownership
  // rows that touch the neighborhood — avoids scanning all 26K rows
  // for one entity's local graph.
  const targetEntityNames =
    entitySlugFilter && entitySlugFilter.length > 0
      ? entityRows.map((e) => e.slug) // re-use the loaded entity rows for fuzzy match
      : null;
  const ownershipRows = (await (targetEntityNames
    ? db.execute(sql`
        WITH neighborhood AS (
          SELECT name FROM known_entities
           WHERE slug = ANY(ARRAY[${sql.join(
             targetEntityNames.map((s) => sql`${s}`),
             sql`, `,
           )}]::text[])
        )
        SELECT eo.subject_name, eo.parent_name, eo.share_pct::float8 AS share_pct
          FROM entity_ownership eo
         WHERE EXISTS (
                 SELECT 1 FROM neighborhood n
                  WHERE similarity(eo.subject_name, n.name) > 0.55
                     OR similarity(eo.parent_name, n.name) > 0.55
               );
      `)
    : db.execute(sql`
        SELECT subject_name, parent_name, share_pct::float8 AS share_pct
          FROM entity_ownership
      `))) as unknown as Array<{ subject_name: string; parent_name: string; share_pct: number | null }>;
  for (const o of ownershipRows) {
    // pg_trgm match each side. Threshold 0.55 same as supplier-graph.
    const subjectMatch = (await db.execute(sql`
      SELECT slug FROM known_entities
       WHERE similarity(name, ${o.subject_name}) > 0.55
       ORDER BY similarity(name, ${o.subject_name}) DESC
       LIMIT 1
    `)) as unknown as Array<{ slug: string }>;
    const parentMatch = (await db.execute(sql`
      SELECT slug FROM known_entities
       WHERE similarity(name, ${o.parent_name}) > 0.55
       ORDER BY similarity(name, ${o.parent_name}) DESC
       LIMIT 1
    `)) as unknown as Array<{ slug: string }>;
    if (!subjectMatch[0] || !parentMatch[0]) continue;
    const sIdx = entityIndex.get(subjectMatch[0].slug);
    const pIdx = entityIndex.get(parentMatch[0].slug);
    if (sIdx == null || pIdx == null) continue;
    // weight = share_pct/100, default 1.0 if not disclosed
    edges['entity-owns-entity'].push({
      src: pIdx, // parent → subject (parent owns subject)
      dst: sIdx,
      weight: o.share_pct != null ? Math.max(0, Math.min(1, o.share_pct / 100)) : 1.0,
      attrs: { share_pct: o.share_pct },
    });
  }

  // ─── Assemble output ─────────────────────────────────────────
  const featureNames = {
    entity: buildEntityFeatureNames(),
    vessel: buildVesselFeatureNames(),
    port: buildPortFeatureNames(),
    crude_grade: buildCrudeGradeFeatureNames(),
  } satisfies Record<NodeType, string[]>;

  const out: GraphOutput = {
    metadata: {
      extractedAt: new Date().toISOString(),
      procurCommit: process.env.PROCUR_COMMIT ?? null,
      countryFilter: country,
      targetEntitySlug: singleEntity,
      featureDims: {
        entity: featureNames.entity.length,
        vessel: featureNames.vessel.length,
        port: featureNames.port.length,
        crude_grade: featureNames.crude_grade.length,
      },
      featureNames,
      edgeTypes: [
        'entity-owns-entity',
        'entity-located-port',
        'vessel-called-port',
        'vessel-carried-grade',
        'port-handles-grade',
      ],
      nodeCounts: {
        entity: entityRows.length,
        vessel: vesselRows.length,
        port: portRows.length,
        crude_grade: crudeGradeRows.length,
      },
      edgeCounts: {
        'entity-owns-entity': edges['entity-owns-entity'].length,
        'entity-located-port': edges['entity-located-port'].length,
        'vessel-called-port': edges['vessel-called-port'].length,
        'vessel-carried-grade': edges['vessel-carried-grade'].length,
        'port-handles-grade': edges['port-handles-grade'].length,
      },
    },
    nodes: {
      entity: {
        ids: entityRows.map((e) => e.slug),
        features: entityRows.map(entityFeatures),
      },
      vessel: {
        ids: vesselRows.map((v) => v.mmsi),
        features: vesselRows.map(vesselFeatures),
      },
      port: {
        ids: portRows.map((p) => p.slug),
        features: portRows.map(portFeatures),
      },
      crude_grade: {
        ids: crudeGradeRows.map((g) => g.slug),
        features: crudeGradeRows.map(crudeGradeFeatures),
      },
    },
    edges,
  };

  console.log('\n  graph stats:');
  console.log('    nodes:');
  for (const [k, n] of Object.entries(out.metadata.nodeCounts)) {
    console.log(`      ${k.padEnd(14)} ${n.toString().padStart(8)}  (feature_dim=${out.metadata.featureDims[k as NodeType]})`);
  }
  console.log('    edges:');
  for (const [k, n] of Object.entries(out.metadata.edgeCounts)) {
    console.log(`      ${k.padEnd(28)} ${n.toString().padStart(8)}`);
  }

  if (statsOnly) {
    console.log('\n(--stats-only — no file written.)');
    return;
  }

  const path = resolveUserPath(output);
  await writeFile(path, JSON.stringify(out));
  console.log(`\nWrote ${path}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
