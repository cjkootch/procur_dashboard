/**
 * Parser for Haverly-template assay reports (ExxonMobil unbranded
 * "Crude Assays/" + Equinor "Crude Assays (Equinor)/"). Both
 * producers publish via Haverly Systems' assay tooling, so the
 * worksheet structure is identical:
 *
 *   Sheet "Summary" or "Summary (C)":
 *     - Left block (cols 2-3): General Information
 *         row 13/15: Reference, Name, Origin, Sample/Assay/Issue dates
 *     - Middle block (cols 7-11): Light hydrocarbon molecule yields
 *     - Right block (cols 12-17): Whole Crude Properties
 *         col 13 = label, col 17 = value
 *     - Cut Data block (around row 30+):
 *         row 33-35: Start/End temps as a horizontal row of cuts
 *         row 37+:    Yield (% wt), Yield (% vol), Cumulative Yield (% wt),
 *                     Density (g/cc), Sulfur (% wt), … one row per property
 *
 *   Sheet "Yield Graph": chart data — skipped for ingest.
 *
 * Differences from ExxonMobil to Equinor are minor (a "Traded Crude"
 * row that shifts subsequent labels by 1 in Equinor; resolved via
 * label search rather than fixed coordinates).
 */
import {
  cellAt,
  findAnyLabel,
  findLabel,
  findValueRight,
  toDate,
  toNumber,
  toText,
  type CellGrid,
  type CellValue,
  type LoadedSheet,
} from '../read-assay-cells';
import type { ParsedAssay, ParsedCut } from './types';

/** psi → kPa conversion. Equinor publishes RVP in psi; we store kPa. */
const PSI_TO_KPA = 6.89476;

export function parseHaverlyAssay(args: {
  source: 'exxonmobil' | 'equinor';
  sourceFile: string;
  sheets: LoadedSheet[];
}): ParsedAssay | null {
  const { source, sourceFile, sheets } = args;

  const summary =
    sheets.find((s) => s.name === 'Summary') ??
    sheets.find((s) => s.name === 'Summary (C)') ??
    sheets[0]!;
  if (!summary) return null;
  const grid = summary.grid;

  // ── General Information ─────────────────────────────────────────
  const reference = readLabelRight(grid, 'Reference');
  const name = readLabelRight(grid, 'Name');
  if (!reference || !name) return null; // not a Haverly assay we can parse

  const origin = readLabelRight(grid, 'Origin');
  const sampleDate = readLabelRight(grid, 'Sample Date');
  const assayDate = readLabelRight(grid, 'Assay Date');
  const issueDate = readLabelRight(grid, 'Issue Date');
  const comments = readLabelRight(grid, 'Comments');

  // ── Whole Crude Properties (right block) ────────────────────────
  // The right block is a 2-column key/value layout where the label
  // sits in col 13 and the value in col 17 (1-indexed cell coords;
  // grid is 0-indexed so cols 12 and 16). We use findLabel because
  // the row offset varies between producers.
  const densityGcc = readWholeCrudeNum(grid, ['Density @ 15°C (g/cc)', 'Density at 15°C (g/cc)']);
  const apiGravity = readWholeCrudeNum(grid, ['API Gravity', '°API']);
  const sulphurWtPct = readWholeCrudeNum(grid, [
    'Total Sulphur (% wt)',
    'Total Sulfur (% wt)',
    'Sulphur (% wt)',
    'Sulfur (% wt)',
  ]);
  const pourPointC = readWholeCrudeNum(grid, ['Pour Point (°C)', 'Pour Point (C)']);
  const viscosity20 = readWholeCrudeNum(grid, ['Viscosity @ 20°C (cSt)', 'Viscosity at 20°C (cSt)']);
  const viscosity40 = readWholeCrudeNum(grid, ['Viscosity @ 40°C (cSt)', 'Viscosity at 40°C (cSt)']);
  // Some Haverly assays publish 50°C; capture either when present.
  const viscosity50 = readWholeCrudeNum(grid, ['Viscosity @ 50°C (cSt)', 'Viscosity at 50°C (cSt)']);
  const nickel = readWholeCrudeNum(grid, ['Nickel (ppm)', 'Nickel, mg/kg', 'Nickel mg/kg']);
  const vanadium = readWholeCrudeNum(grid, ['Vanadium (ppm)', 'Vanadium, mg/kg', 'Vanadium mg/kg']);
  const nitrogen = readWholeCrudeNum(grid, ['Total Nitrogen (ppm)', 'Total Nitrogen mg/kg']);
  const tan = readWholeCrudeNum(grid, [
    'Total Acid Number (mgKOH/g)',
    'Total Acid Number (mg KOH/g)',
    'Acidity, mg KOH/g',
    'TAN (mgKOH/g)',
  ]);
  const mercaptan = readWholeCrudeNum(grid, [
    'Mercaptan Sulphur (ppm)',
    'Mercaptan Sulfur (ppm)',
    'Mercaptan Sulphur, mg/kg',
  ]);
  const h2s = readWholeCrudeNum(grid, [
    'Hydrogen Sulphide (ppm)',
    'Hydrogen Sulfide (ppm)',
    'Hydrogen Sulphide, mg/kg',
    'H2S (ppm)',
  ]);
  const rvpPsi = readWholeCrudeNum(grid, ['Reid Vapour Pressure (psi)', 'RVP (psi)']);

  // ── TBP cut data ────────────────────────────────────────────────
  const cuts = parseHaverlyCuts(grid);

  // ── Raw blob: capture every (label, value) we found in the right
  // block so a follow-up can recover fields we don't model as
  // columns yet (paraffin %, NaCl, wax appearance, etc.).
  const raw = collectWholeCrudeRaw(grid);

  return {
    source,
    sourceFile,
    reference,
    name,
    originLabel: origin,
    originCountry: null, // resolved by ingest script via country-codes
    sampleDate,
    assayDate,
    issueDate,
    comments,
    densityKgL: densityGcc, // g/cc ≈ kg/L for our use
    apiGravity,
    sulphurWtPct,
    pourPointC,
    viscosityCst20c: viscosity20,
    viscosityCst50c: viscosity50 ?? viscosity40, // store 50°C when present, else 40°C as proxy
    nickelMgKg: nickel,
    vanadiumMgKg: vanadium,
    nitrogenMgKg: nitrogen,
    acidityMgKohG: tan,
    mercaptanSulphurMgKg: mercaptan,
    h2sMgKg: h2s,
    rvpKpa: rvpPsi != null ? rvpPsi * PSI_TO_KPA : null,
    raw,
    cuts,
  };

  /** Read the value to the right of `label` in the General Info block. */
  function readLabelRight(grid: CellGrid, label: string): string | null {
    const hit = findLabel(grid, label);
    if (!hit) return null;
    const val = findValueRight(grid, hit.row, hit.col, 4);
    if (!val) return null;
    if (label.toLowerCase().includes('date')) return toDate(val.value);
    return toText(val.value);
  }

  /** Read a number from the Whole Crude Properties block (right side). */
  function readWholeCrudeNum(grid: CellGrid, labels: readonly string[]): number | null {
    const hit = findAnyLabel(grid, labels);
    if (!hit) return null;
    // Whole Crude block: value lives ~4 columns to the right of label.
    const val = findValueRight(grid, hit.row, hit.col, 8);
    return val ? toNumber(val.value) : null;
  }
}

/**
 * Walk the Cut Data block and emit one ParsedCut per column.
 *
 * Cut Data layout (Haverly):
 *   row R    : 'Cut Data' header
 *   row R+3  : 'Start (°C)'  label, then per-cut starts in cols 3..N
 *              (typically 'IBP', 'C5', 65, 100, ..., FBP)
 *   row R+4  : 'End (°C)'   label, then per-cut ends
 *   row R+7  : 'Yield (% wt)'
 *   row R+8  : 'Yield (% vol)'
 *   row R+9  : 'Cumulative Yield (% wt)'
 *   row R+10 : 'Density @ 15°C (g/cc)'
 *   row R+11 : 'Sulphur (% wt)'
 *   row R+12 : … further per-cut properties
 */
function parseHaverlyCuts(grid: CellGrid): ParsedCut[] {
  const startRow = findLabel(grid, 'Start (°C)');
  const endRow = findLabel(grid, 'End (°C)');
  if (!startRow || !endRow) return [];

  // The cut columns extend from startRow.col + 1 rightward. Find the
  // last column with a non-null end-temp.
  const lastCol = lastNonNullCol(grid[endRow.row]!, endRow.col + 1);
  if (lastCol < 0) return [];

  const yieldWtRow = findLabel(grid, 'Yield (% wt)');
  const yieldVolRow = findLabel(grid, 'Yield (% vol)');
  const cumulativeRow = findLabel(grid, 'Cumulative Yield (% wt)');
  const densityRow = findAnyLabel(grid, [
    'Density @ 15°C (g/cc)',
    'Density (g/cc)',
    'Density at 15°C (g/cc)',
  ]);
  const sulphurRow = findAnyLabel(grid, [
    'Sulphur (% wt)',
    'Sulfur (% wt)',
    'Total Sulphur (% wt)',
  ]);

  const cuts: ParsedCut[] = [];
  for (let c = startRow.col + 1, order = 0; c <= lastCol; c += 1, order += 1) {
    const startCell = cellAt(grid, startRow.row, c);
    const endCell = cellAt(grid, endRow.row, c);
    const startText = toText(startCell);
    const endText = toText(endCell);
    if (startText == null && endText == null) continue;
    const startNum = toNumber(startCell);
    const endNum = toNumber(endCell);
    const label = `${startText ?? '?'}-${endText ?? '?'}`;
    cuts.push({
      cutLabel: label,
      cutOrder: order,
      startTempC: startNum,
      endTempC: endNum,
      yieldWtPct: yieldWtRow ? toNumber(cellAt(grid, yieldWtRow.row, c)) : null,
      yieldVolPct: yieldVolRow ? toNumber(cellAt(grid, yieldVolRow.row, c)) : null,
      cumulativeYieldWtPct: cumulativeRow
        ? toNumber(cellAt(grid, cumulativeRow.row, c))
        : null,
      densityKgL: densityRow ? toNumber(cellAt(grid, densityRow.row, c)) : null,
      sulphurWtPct: sulphurRow ? toNumber(cellAt(grid, sulphurRow.row, c)) : null,
    });
  }
  return cuts;
}

function lastNonNullCol(row: Array<CellValue>, fromCol: number): number {
  let last = -1;
  for (let c = fromCol; c < row.length; c += 1) {
    if (row[c] != null && String(row[c]).trim() !== '') last = c;
  }
  return last;
}

/**
 * Capture every Whole Crude Properties (label → value) pair we find,
 * even fields we don't model as columns — so the raw jsonb preserves
 * paraffin %, NaCl, wax appearance, etc. for later mining.
 */
function collectWholeCrudeRaw(grid: CellGrid): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // Whole Crude Properties block: label in col 13 (index 12), value in
  // col 17 (index 16). Walk the column.
  const headerHit = findLabel(grid, 'Whole Crude Properties');
  if (!headerHit) return out;
  for (let r = headerHit.row + 1; r < Math.min(grid.length, headerHit.row + 30); r += 1) {
    const label = toText(cellAt(grid, r, headerHit.col));
    if (!label) continue;
    // Try value in same row, 4 columns to the right (typical Haverly
    // layout). Fall back to "any non-null in next 6 cols".
    const valHit = findValueRight(grid, r, headerHit.col, 6);
    if (!valHit) continue;
    out[label] = valHit.value instanceof Date ? valHit.value.toISOString() : valHit.value;
  }
  return out;
}
