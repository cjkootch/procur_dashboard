/**
 * EU MRV — vessel-level annual fuel consumption ingest.
 *
 * Source: THETIS-MRV (mrv.emsa.europa.eu)
 * Coverage: every commercial vessel > 5,000 GT calling at EU ports
 * License: open data; published annually with ~1-year lag (2024 data
 *          published mid-2025).
 * Granularity: per-vessel-year. Verified by EU regulators — single
 *              highest-confidence marine fuel dataset publicly available.
 *
 * Why this matters for VTC: cruise + container + tanker operators are
 * MASSIVE refined-fuel buyers (HFO + MGO/MDO blend post-IMO-2020). The
 * Caribbean cruise + transshipment fleet alone is multi-million bbl/yr
 * of bunker demand. MRV data converts that from anecdote into
 * verified per-vessel figures.
 *
 * Architecture (per buyer-intelligence-v2-free-sources-brief.md §4.2):
 *   1. Read MRV Excel (annual download from THETIS-MRV portal)
 *   2. Convert tonnes → bbl using marine-fuel density (6.84 bbl/tonne
 *      for HFO/MDO blend, 7.30 for MGO; default 6.84)
 *   3. For each row, look up IMO in known_entities.metadata.fleet_imos
 *      — if matched, attribute to that operator's slug
 *   4. Aggregate per (operator_slug, coverage_year) — sum tonnes
 *      across all matched vessels
 *   5. Unmatched vessels emit at entity_slug = `vessel:<imo>` so the
 *      data is still in procur, just unattributed
 *
 * Idempotent: DELETE+INSERT on (entity_slug, source='eu_mrv',
 * coverage_year). Matches the seed pattern.
 *
 * Confidence: 0.95 — direct vessel-level disclosure verified by EU
 * regulators. Note: this is GLOBAL annual fuel consumption, not
 * Caribbean-specific bunker demand. AIS time-in-region weighting is
 * a follow-up (brief §4.2 step 4).
 *
 * Run:
 *   pnpm --filter @procur/db ingest-eu-mrv <path-to-mrv.xlsx>
 *   pnpm --filter @procur/db ingest-eu-mrv <path> --year=2024
 *   pnpm --filter @procur/db ingest-eu-mrv <path> --dry-run
 *   pnpm --filter @procur/db ingest-eu-mrv <path> --vessel-level
 *
 * Flags:
 *   --year=YYYY      Reporting period to filter for. MRV file may
 *                    contain multiple years; defaults to most recent.
 *   --dry-run        Print stats; don't write rows.
 *   --vessel-level   Also emit per-vessel signals (entity_slug =
 *                    vessel:IMO). Default off — only operator-level
 *                    aggregations land. Useful for audit.
 */
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { sql } from 'drizzle-orm';
import { db } from './client';
import { readTabular, pickCol, parseNumberSafe } from './lib/read-tabular';

loadEnv({ path: '../../.env.local' });
loadEnv({ path: '../../.env' });

// Marine-fuel tonnes → barrels conversion. 1 bbl = 158.987 L.
// HFO density 0.96 kg/L → 6.51 bbl/tonne; MDO/MGO 0.86 kg/L → 7.30
// bbl/tonne. Marine bunker is dominantly HFO/blend post-IMO-2020 (VLSFO
// at ~0.93 kg/L → ~6.74). Mid-blend factor 6.84 used as default.
const BBL_PER_TONNE_BLEND = 6.84;
const BBL_PER_TONNE_HFO = 6.51;
const BBL_PER_TONNE_MGO = 7.3;
const CONFIDENCE = 0.95;

type MrvRow = {
  imo: string;
  name: string | null;
  shipType: string | null;
  reportingPeriod: number | null;
  totalFuelTonnes: number | null;
  totalCo2Tonnes: number | null;
  timeAtSeaHours: number | null;
  distanceNm: number | null;
};

type OperatorAggregate = {
  operatorSlug: string;
  operatorName: string;
  coverageYear: number;
  vessels: Array<{
    imo: string;
    name: string | null;
    fuelTonnes: number;
  }>;
  totalFuelTonnes: number;
};

function parseMrvRow(row: Record<string, string>): MrvRow | null {
  // MRV column names vary slightly across reporting years. The
  // pickCol helper picks the first present alternative.
  const imoRaw = pickCol(row, 'IMO Number', 'IMO', 'imo number', 'imo_number');
  if (!imoRaw) return null;
  const imo = String(imoRaw).trim().replace(/^IMO\s*/i, '');
  if (!/^\d{6,7}$/.test(imo)) return null;

  return {
    imo,
    name: pickCol(row, 'Name', 'Ship Name', 'Vessel Name'),
    shipType: pickCol(row, 'Ship type', 'Ship Type', 'Vessel Type'),
    reportingPeriod: parseNumberSafe(
      pickCol(row, 'Reporting Period', 'Reporting period', 'Year'),
    ),
    totalFuelTonnes: parseNumberSafe(
      pickCol(
        row,
        'Total fuel consumption [m tonnes]',
        'Total fuel consumption',
        'Total Fuel Consumption [m tonnes]',
      ),
    ),
    totalCo2Tonnes: parseNumberSafe(
      pickCol(
        row,
        'Total CO₂ emissions [m tonnes]',
        'Total CO2 emissions [m tonnes]',
        'Total CO₂ emissions',
        'Total CO2 emissions',
      ),
    ),
    timeAtSeaHours: parseNumberSafe(
      pickCol(
        row,
        'Annual Total time spent at sea [hours]',
        'Annual total time spent at sea',
        'Time at sea [h]',
      ),
    ),
    distanceNm: parseNumberSafe(
      pickCol(row, 'Annual average Fuel consumption per distance', 'Distance [n miles]'),
    ),
  };
}

type OperatorMap = Map<string, { slug: string; name: string }>;

async function loadOperatorFleetMap(): Promise<OperatorMap> {
  // Walks known_entities for marine-operator rows that carry
  // metadata.fleet_imos. Returns IMO → operator. IMO numbers can be
  // shared across an operator's fleet rosters (parent/sub) so the
  // last-write wins shouldn't matter much; we surface a count.
  const rows = (await db.execute(sql`
    SELECT slug, name, metadata
      FROM known_entities
     WHERE role = 'marine-operator'
       AND metadata ? 'fleet_imos'
       AND jsonb_array_length(metadata->'fleet_imos') > 0;
  `)) as unknown as Array<{
    slug: string;
    name: string;
    metadata: { fleet_imos?: string[] };
  }>;
  const map: OperatorMap = new Map();
  for (const r of rows) {
    const imos = Array.isArray(r.metadata?.fleet_imos) ? r.metadata!.fleet_imos! : [];
    for (const raw of imos) {
      const imo = String(raw).trim().replace(/^IMO\s*/i, '');
      if (!/^\d{6,7}$/.test(imo)) continue;
      map.set(imo, { slug: r.slug, name: r.name });
    }
  }
  return map;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const path = args.find((a) => !a.startsWith('--')) ?? process.env.EU_MRV_PATH;
  const dryRun = args.includes('--dry-run');
  const vesselLevel = args.includes('--vessel-level');
  const yearArg = args.find((a) => a.startsWith('--year='));
  const yearOverride = yearArg ? Number.parseInt(yearArg.split('=')[1] ?? '', 10) : null;

  if (!path) {
    console.error(
      'Usage: pnpm --filter @procur/db ingest-eu-mrv <path-to-mrv.xlsx>\n' +
        '  --year=YYYY       Reporting period filter\n' +
        '  --vessel-level    Emit per-vessel signals as well\n' +
        '  --dry-run         Print stats only, do not write\n' +
        '\n' +
        'Download MRV file from https://mrv.emsa.europa.eu/#public/emission-report',
    );
    process.exit(1);
  }
  console.log(`Reading MRV from ${path}…`);

  let rawRows: Array<Record<string, string>>;
  try {
    rawRows = await readTabular(path);
  } catch (err) {
    console.error(`Failed to read ${path}: ${(err as Error).message}`);
    process.exit(1);
  }
  console.log(`  ${rawRows.length} raw rows`);

  const parsed: MrvRow[] = [];
  let droppedNoImo = 0;
  let droppedNoFuel = 0;
  for (const row of rawRows) {
    const m = parseMrvRow(row);
    if (!m) {
      droppedNoImo += 1;
      continue;
    }
    if (m.totalFuelTonnes == null || m.totalFuelTonnes <= 0) {
      droppedNoFuel += 1;
      continue;
    }
    parsed.push(m);
  }
  console.log(
    `  ${parsed.length} parsed, droppedNoImo=${droppedNoImo}, droppedNoFuel=${droppedNoFuel}`,
  );

  // Filter by reporting period — default to most recent year present.
  const yearsPresent = new Set(parsed.map((r) => r.reportingPeriod).filter((y): y is number => y != null));
  const targetYear = yearOverride ?? (yearsPresent.size > 0 ? Math.max(...yearsPresent) : null);
  if (!targetYear) {
    console.error('No reporting period column found and --year not supplied. Aborting.');
    process.exit(1);
  }
  console.log(`  filtering to coverage_year=${targetYear} (years present: ${[...yearsPresent].sort().join(', ')})`);

  const filtered = parsed.filter((r) => r.reportingPeriod === targetYear);
  console.log(`  ${filtered.length} rows match target year`);

  const operatorMap = await loadOperatorFleetMap();
  console.log(`  ${operatorMap.size} IMOs mapped to ${new Set([...operatorMap.values()].map((v) => v.slug)).size} operators`);

  // Aggregate by operator
  const byOperator = new Map<string, OperatorAggregate>();
  const unmatched: MrvRow[] = [];
  for (const r of filtered) {
    const op = operatorMap.get(r.imo);
    if (!op) {
      unmatched.push(r);
      continue;
    }
    let agg = byOperator.get(op.slug);
    if (!agg) {
      agg = {
        operatorSlug: op.slug,
        operatorName: op.name,
        coverageYear: targetYear,
        vessels: [],
        totalFuelTonnes: 0,
      };
      byOperator.set(op.slug, agg);
    }
    agg.vessels.push({
      imo: r.imo,
      name: r.name,
      fuelTonnes: r.totalFuelTonnes!,
    });
    agg.totalFuelTonnes += r.totalFuelTonnes!;
  }

  console.log(
    `\n  ${byOperator.size} operator aggregates, ${unmatched.length} unmatched vessels`,
  );
  if (byOperator.size > 0) {
    console.log('  top operators by tonnes:');
    const top = [...byOperator.values()]
      .sort((a, b) => b.totalFuelTonnes - a.totalFuelTonnes)
      .slice(0, 15);
    for (const o of top) {
      const bbl = o.totalFuelTonnes * BBL_PER_TONNE_BLEND;
      console.log(
        `    ${o.operatorName} (${o.vessels.length} vessels): ${(o.totalFuelTonnes / 1000).toFixed(1)}k tonnes → ${(bbl / 1e6).toFixed(2)}M bbl/yr`,
      );
    }
  }

  if (dryRun) {
    console.log('\n(dry run — no rows written.)');
    return;
  }

  let inserted = 0;

  // Operator-level signals
  for (const o of byOperator.values()) {
    const bblMid = o.totalFuelTonnes * BBL_PER_TONNE_BLEND;
    const bblMin = o.totalFuelTonnes * BBL_PER_TONNE_HFO;
    const bblMax = o.totalFuelTonnes * BBL_PER_TONNE_MGO;
    const rawData = {
      vesselCount: o.vessels.length,
      totalFuelTonnes: o.totalFuelTonnes,
      tonnesToBbl: { hfo: BBL_PER_TONNE_HFO, blend: BBL_PER_TONNE_BLEND, mgo: BBL_PER_TONNE_MGO },
      vessels: o.vessels.slice(0, 50), // cap audit list size
      vesselsTruncated: o.vessels.length > 50,
    };
    await db.execute(sql`
      DELETE FROM fuel_consumption_signals
       WHERE entity_slug = ${o.operatorSlug}
         AND source = 'eu_mrv'
         AND coverage_year = ${o.coverageYear};
    `);
    await db.execute(sql`
      INSERT INTO fuel_consumption_signals (
        entity_slug, source, signal_kind, fuel_type,
        volume_bbl_yr_min, volume_bbl_yr_max,
        confidence, coverage_year, notes, source_url, raw_data
      ) VALUES (
        ${o.operatorSlug},
        'eu_mrv',
        'volume_estimate',
        'mixed',
        ${bblMin.toFixed(2)},
        ${bblMax.toFixed(2)},
        ${CONFIDENCE},
        ${o.coverageYear},
        ${`EU MRV: ${o.vessels.length} vessels reporting ${(o.totalFuelTonnes / 1000).toFixed(1)}k tonnes total fuel ${o.coverageYear}. Mid-blend ${(bblMid / 1e6).toFixed(2)}M bbl/yr (HFO ${(bblMin / 1e6).toFixed(2)} - MGO ${(bblMax / 1e6).toFixed(2)}). Global figure (not Caribbean-specific).`},
        ${'https://mrv.emsa.europa.eu/#public/emission-report'},
        ${JSON.stringify(rawData)}::jsonb
      );
    `);
    inserted += 1;
  }

  if (vesselLevel) {
    for (const r of filtered) {
      const tonnes = r.totalFuelTonnes!;
      const bblMin = tonnes * BBL_PER_TONNE_HFO;
      const bblMax = tonnes * BBL_PER_TONNE_MGO;
      const rawData = {
        imo: r.imo,
        shipType: r.shipType,
        timeAtSeaHours: r.timeAtSeaHours,
        co2Tonnes: r.totalCo2Tonnes,
        totalFuelTonnes: tonnes,
        tonnesToBbl: { hfo: BBL_PER_TONNE_HFO, blend: BBL_PER_TONNE_BLEND, mgo: BBL_PER_TONNE_MGO },
      };
      await db.execute(sql`
        DELETE FROM fuel_consumption_signals
         WHERE entity_slug = ${`vessel:${r.imo}`}
           AND source = 'eu_mrv'
           AND coverage_year = ${targetYear};
      `);
      await db.execute(sql`
        INSERT INTO fuel_consumption_signals (
          entity_slug, source, signal_kind, fuel_type,
          volume_bbl_yr_min, volume_bbl_yr_max,
          confidence, coverage_year, notes, source_url, raw_data
        ) VALUES (
          ${`vessel:${r.imo}`},
          'eu_mrv',
          'volume_estimate',
          'mixed',
          ${bblMin.toFixed(2)},
          ${bblMax.toFixed(2)},
          ${CONFIDENCE},
          ${targetYear},
          ${`EU MRV vessel ${r.name ?? `IMO ${r.imo}`} (${r.shipType ?? 'unknown type'}): ${tonnes.toFixed(1)} tonnes fuel ${targetYear}.`},
          ${'https://mrv.emsa.europa.eu/#public/emission-report'},
          ${JSON.stringify(rawData)}::jsonb
        );
      `);
      inserted += 1;
    }
  }

  console.log(
    `\nInserted ${inserted} signal rows (${byOperator.size} operator + ${vesselLevel ? filtered.length : 0} vessel).`,
  );
  if (unmatched.length > 0 && !vesselLevel) {
    console.log(
      `\n  ${unmatched.length} vessels unattributed (no operator mapping). ` +
        'Add IMOs to known_entities.metadata.fleet_imos to attribute them, ' +
        'or re-run with --vessel-level to land them at vessel:IMO entity slugs.',
    );
    if (unmatched.length <= 30) {
      console.log('  unmatched IMOs:');
      for (const r of unmatched) {
        console.log(`    ${r.imo} ${r.name ?? '(unnamed)'} — ${r.shipType ?? '?'} — ${r.totalFuelTonnes?.toFixed(0)} tonnes`);
      }
    }
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
