/**
 * Crude assay ingest — parses producer-published xlsx assay reports
 * (ExxonMobil unbranded "Crude Assays/", BP, Equinor, TotalEnergies)
 * into `crude_assays` + `crude_assay_cuts`.
 *
 * Source detection is by directory name; each source has a dedicated
 * parser under `lib/assay-parsers/` because the layouts differ
 * meaningfully (Haverly template vs BP custom vs TotalEnergies single-
 * sheet).
 *
 * Idempotency: each row upserts on (source, reference). Re-running
 * after a producer publishes a new vintage replaces the row in place.
 * Cuts are deleted-then-inserted per assay so a partial re-parse
 * doesn't leave stale cuts behind.
 *
 * Run:
 *   pnpm --filter @procur/db ingest-crude-assays
 *   pnpm --filter @procur/db ingest-crude-assays --base=/path/to/files
 *   pnpm --filter @procur/db ingest-crude-assays --dry-run
 *   pnpm --filter @procur/db ingest-crude-assays --source=equinor
 */
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { readdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { eq, sql } from 'drizzle-orm';

import * as schema from './schema';
import { loadAssayWorkbook } from './lib/read-assay-cells';
import { parseHaverlyAssay } from './lib/assay-parsers/haverly';
import { parseBpAssay } from './lib/assay-parsers/bp';
import { parseTotalEnergiesAssay } from './lib/assay-parsers/totalenergies';
import type { ParsedAssay } from './lib/assay-parsers/types';

loadEnv({ path: '../../.env.local' });
loadEnv({ path: '../../.env' });

type SourceConfig = {
  source: 'exxonmobil' | 'bp' | 'equinor' | 'totalenergies';
  /** Directory name relative to the ingest base directory. */
  dirName: string;
  /** Returns `null` when the file doesn't parse (e.g. empty workbook). */
  parse: (args: { sourceFile: string; sheets: Awaited<ReturnType<typeof loadAssayWorkbook>> }) =>
    | ParsedAssay
    | null;
};

const SOURCES: SourceConfig[] = [
  {
    source: 'exxonmobil',
    dirName: 'Crude Assays',
    parse: (args) => parseHaverlyAssay({ source: 'exxonmobil', ...args }),
  },
  {
    source: 'bp',
    dirName: 'Crude Assays (BP)',
    parse: parseBpAssay,
  },
  {
    source: 'equinor',
    dirName: 'Crude Assays (Equinor)',
    parse: (args) => parseHaverlyAssay({ source: 'equinor', ...args }),
  },
  {
    source: 'totalenergies',
    dirName: 'Crude Assays (Total Energies)',
    parse: parseTotalEnergiesAssay,
  },
];

/** Common country labels seen in producer assays → ISO-2. The full
 *  country-codes.ts lives in @procur/catalog, but @procur/db can't
 *  import upward without creating a cycle, so we inline the labels
 *  most likely to appear as assay origins (oil-producing nations
 *  + the unusual "North Sea - UK" composite-region labels). */
const ORIGIN_TO_ISO2: Record<string, string> = {
  'algeria': 'DZ', 'angola': 'AO', 'argentina': 'AR', 'australia': 'AU',
  'azerbaijan': 'AZ', 'bahrain': 'BH', 'brazil': 'BR', 'brunei': 'BN',
  'cameroon': 'CM', 'canada': 'CA', 'chad': 'TD', 'china': 'CN',
  'colombia': 'CO', 'congo': 'CG', 'denmark': 'DK', 'ecuador': 'EC',
  'egypt': 'EG', 'equatorial guinea': 'GQ', 'gabon': 'GA', 'ghana': 'GH',
  'guyana': 'GY', 'india': 'IN', 'indonesia': 'ID', 'iran': 'IR',
  'iraq': 'IQ', 'italy': 'IT', 'kazakhstan': 'KZ', 'kuwait': 'KW',
  'libya': 'LY', 'malaysia': 'MY', 'mexico': 'MX', 'netherlands': 'NL',
  'nigeria': 'NG', 'norway': 'NO', 'oman': 'OM', 'pakistan': 'PK',
  'qatar': 'QA', 'russia': 'RU', 'saudi arabia': 'SA', 'senegal': 'SN',
  'south sudan': 'SS', 'sudan': 'SD', 'syria': 'SY', 'thailand': 'TH',
  'trinidad and tobago': 'TT', 'tunisia': 'TN', 'turkey': 'TR',
  'turkmenistan': 'TM', 'uae': 'AE', 'united arab emirates': 'AE',
  'uk': 'GB', 'united kingdom': 'GB', 'us': 'US', 'usa': 'US',
  'united states': 'US', 'venezuela': 'VE', 'vietnam': 'VN', 'yemen': 'YE',
  // Sub-national US labels seen in the unbranded "Crude Assays/" set.
  'north dakota': 'US', 'texas': 'US', 'alaska': 'US', 'louisiana': 'US',
};

/** Best-effort ISO-2 from a free-form origin label.
 *  Parses prefixes like "North Sea - UK" → "GB". Returns null when
 *  no recognisable country found. */
function resolveOriginCountry(label: string | null | undefined): string | null {
  if (!label) return null;
  const lower = label.toLowerCase().trim();
  if (ORIGIN_TO_ISO2[lower]) return ORIGIN_TO_ISO2[lower]!;
  // Try the trailing token after a dash ("North Sea - UK" → "uk").
  const tail = lower.split(/\s*[-–—]\s*/).pop()?.trim();
  if (tail && ORIGIN_TO_ISO2[tail]) return ORIGIN_TO_ISO2[tail]!;
  // Try any country word inside the label.
  for (const [name, iso] of Object.entries(ORIGIN_TO_ISO2)) {
    if (lower.includes(name)) return iso;
  }
  return null;
}

export type IngestResult = {
  perSource: Record<string, { parsed: number; written: number; failed: number }>;
  totalAssays: number;
  totalCuts: number;
  failures: Array<{ file: string; error: string }>;
};

export async function ingestCrudeAssays(opts: {
  base?: string;
  dryRun?: boolean;
  source?: string;
}): Promise<IngestResult> {
  const base = opts.base ?? process.env.INIT_CWD ?? process.cwd();
  const dryRun = opts.dryRun ?? false;
  const sourceFilter = opts.source;

  const result: IngestResult = {
    perSource: {},
    totalAssays: 0,
    totalCuts: 0,
    failures: [],
  };

  // Parse all files first so we can report up-front what the writes
  // will look like before touching the DB.
  const allParsed: Array<{ source: string; assay: ParsedAssay }> = [];

  for (const cfg of SOURCES) {
    if (sourceFilter && cfg.source !== sourceFilter) continue;
    const dir = join(base, cfg.dirName);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (e) {
      console.warn(`skip ${cfg.source}: ${dir} not found`);
      continue;
    }
    const files = entries.filter((n) => /\.(xlsx|xls|xlsm)$/i.test(n));
    result.perSource[cfg.source] = { parsed: 0, written: 0, failed: 0 };

    for (const fname of files) {
      const path = join(dir, fname);
      try {
        const sheets = await loadAssayWorkbook(path);
        const parsed = cfg.parse({ sourceFile: fname, sheets });
        if (!parsed) {
          result.failures.push({ file: path, error: 'parser returned null' });
          result.perSource[cfg.source]!.failed += 1;
          continue;
        }
        // Resolve origin country from the free-text label.
        if (parsed.originLabel && !parsed.originCountry) {
          parsed.originCountry = resolveOriginCountry(parsed.originLabel);
        }
        allParsed.push({ source: cfg.source, assay: parsed });
        result.perSource[cfg.source]!.parsed += 1;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        result.failures.push({ file: path, error: msg });
        result.perSource[cfg.source]!.failed += 1;
      }
    }
  }

  console.log(
    `Parsed ${allParsed.length} assays from ${Object.keys(result.perSource).length} sources` +
      (result.failures.length > 0 ? ` (${result.failures.length} failures)` : ''),
  );

  if (dryRun) {
    console.log('--dry-run: skipping DB writes.');
    for (const { assay } of allParsed.slice(0, 5)) {
      console.log(
        `  [${assay.source}] ${assay.reference} ${assay.name} | ` +
          `API=${assay.apiGravity ?? '-'} S=${assay.sulphurWtPct ?? '-'}% ` +
          `cuts=${assay.cuts.length}`,
      );
    }
    return result;
  }

  // ── DB writes ──────────────────────────────────────────────────
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error('DATABASE_URL not set');
  const sqlClient = neon(dbUrl);
  const db = drizzle(sqlClient, { schema });

  for (const { source, assay } of allParsed) {
    const inserted = await db
      .insert(schema.crudeAssays)
      .values({
        source,
        reference: assay.reference,
        sourceFile: assay.sourceFile,
        name: assay.name,
        gradeSlug: null,
        originCountry: assay.originCountry ?? null,
        originLabel: assay.originLabel ?? null,
        sampleDate: assay.sampleDate ?? null,
        assayDate: assay.assayDate ?? null,
        issueDate: assay.issueDate ?? null,
        densityKgL: numericOrNull(assay.densityKgL),
        apiGravity: numericOrNull(assay.apiGravity),
        bblPerMt: numericOrNull(assay.bblPerMt),
        sulphurWtPct: numericOrNull(assay.sulphurWtPct),
        pourPointC: numericOrNull(assay.pourPointC),
        acidityMgKohG: numericOrNull(assay.acidityMgKohG),
        vanadiumMgKg: numericOrNull(assay.vanadiumMgKg),
        nickelMgKg: numericOrNull(assay.nickelMgKg),
        nitrogenMgKg: numericOrNull(assay.nitrogenMgKg),
        rvpKpa: numericOrNull(assay.rvpKpa),
        viscosityCst20c: numericOrNull(assay.viscosityCst20c),
        viscosityCst50c: numericOrNull(assay.viscosityCst50c),
        mercaptanSulphurMgKg: numericOrNull(assay.mercaptanSulphurMgKg),
        h2sMgKg: numericOrNull(assay.h2sMgKg),
        waxAppearanceTempC: numericOrNull(assay.waxAppearanceTempC),
        comments: assay.comments ?? null,
        raw: assay.raw ?? null,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [schema.crudeAssays.source, schema.crudeAssays.reference],
        set: {
          sourceFile: sql`excluded.source_file`,
          name: sql`excluded.name`,
          originCountry: sql`excluded.origin_country`,
          originLabel: sql`excluded.origin_label`,
          sampleDate: sql`excluded.sample_date`,
          assayDate: sql`excluded.assay_date`,
          issueDate: sql`excluded.issue_date`,
          densityKgL: sql`excluded.density_kg_l`,
          apiGravity: sql`excluded.api_gravity`,
          bblPerMt: sql`excluded.bbl_per_mt`,
          sulphurWtPct: sql`excluded.sulphur_wt_pct`,
          pourPointC: sql`excluded.pour_point_c`,
          acidityMgKohG: sql`excluded.acidity_mg_koh_g`,
          vanadiumMgKg: sql`excluded.vanadium_mg_kg`,
          nickelMgKg: sql`excluded.nickel_mg_kg`,
          nitrogenMgKg: sql`excluded.nitrogen_mg_kg`,
          rvpKpa: sql`excluded.rvp_kpa`,
          viscosityCst20c: sql`excluded.viscosity_cst_20c`,
          viscosityCst50c: sql`excluded.viscosity_cst_50c`,
          mercaptanSulphurMgKg: sql`excluded.mercaptan_sulphur_mg_kg`,
          h2sMgKg: sql`excluded.h2s_mg_kg`,
          waxAppearanceTempC: sql`excluded.wax_appearance_temp_c`,
          comments: sql`excluded.comments`,
          raw: sql`excluded.raw`,
          updatedAt: sql`now()`,
        },
      })
      .returning({ id: schema.crudeAssays.id });

    const assayId = inserted[0]?.id;
    if (!assayId) {
      console.warn(`upsert returned no id for ${source}/${assay.reference}`);
      continue;
    }
    // Replace cuts wholesale: delete + insert. Cleaner than diffing
    // a parser whose cut count may change between vintages.
    await db
      .delete(schema.crudeAssayCuts)
      .where(eq(schema.crudeAssayCuts.assayId, assayId));
    if (assay.cuts.length > 0) {
      await db.insert(schema.crudeAssayCuts).values(
        assay.cuts.map((cut) => ({
          assayId,
          cutLabel: cut.cutLabel,
          cutOrder: cut.cutOrder,
          startTempC: numericOrNull(cut.startTempC),
          endTempC: numericOrNull(cut.endTempC),
          yieldWtPct: numericOrNull(cut.yieldWtPct),
          yieldVolPct: numericOrNull(cut.yieldVolPct),
          cumulativeYieldWtPct: numericOrNull(cut.cumulativeYieldWtPct),
          densityKgL: numericOrNull(cut.densityKgL),
          sulphurWtPct: numericOrNull(cut.sulphurWtPct),
          raw: cut.raw ?? null,
        })),
      );
    }
    result.perSource[source]!.written += 1;
    result.totalAssays += 1;
    result.totalCuts += assay.cuts.length;
  }

  return result;
}

/** Drizzle's numeric column accepts string | number; null for unset. */
function numericOrNull(n: number | null | undefined): string | null {
  return n == null || !Number.isFinite(n) ? null : String(n);
}

async function main() {
  const args = process.argv.slice(2);
  const baseArg = args.find((a) => a.startsWith('--base='))?.split('=')[1];
  const sourceArg = args.find((a) => a.startsWith('--source='))?.split('=')[1];
  const dryRun = args.includes('--dry-run');
  const result = await ingestCrudeAssays({
    base: baseArg,
    source: sourceArg,
    dryRun,
  });
  for (const [src, stats] of Object.entries(result.perSource)) {
    console.log(`  ${src}: parsed=${stats.parsed} written=${stats.written} failed=${stats.failed}`);
  }
  console.log(`Total: ${result.totalAssays} assays, ${result.totalCuts} cuts.`);
  if (result.failures.length > 0) {
    console.log(`Failures (${result.failures.length}):`);
    for (const f of result.failures.slice(0, 20)) {
      console.log(`  ${basename(f.file)}: ${f.error}`);
    }
    if (result.failures.length > 20) {
      console.log(`  … and ${result.failures.length - 20} more`);
    }
  }
}

if (process.argv[1] && process.argv[1].endsWith('ingest-crude-assays.ts')) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
