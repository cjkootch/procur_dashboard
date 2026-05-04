/**
 * Parser for BP "Crude Assays (BP)/" — .xls files in BP's own
 * Summary template. Layout differs from the Haverly template:
 *
 *   Sheet "Summary":
 *     row 8 :  Reference: MM22BTB1
 *     row 10:  Name: Brent Blend
 *     row 12:  Origin: North Sea - UK
 *     row 14:  Sample Date (Excel serial number)
 *     row 16:  Comments
 *     row 25+: Cut Data block, one row per property × cut columns:
 *               row 27 : cut header (Light Naphtha, Heavy Naphtha, Kero, …)
 *               row 29 : Start (°C API)  — IBP, 95.0, 149.0, …
 *               row 30 : End (°C API)    — 95.0, 149.0, 175.0, …
 *               row 33 : Yield on crude (% wt)
 *               row 34 : Yield on crude (% vol)
 *               row 35 : Density at 15°C (kg/litre)
 *               row 38 : Total Sulphur (% wt)
 *               row 39 : Mercaptan Sulphur (ppm wt)
 *               …
 *
 * BP doesn't publish a unified Whole-Crude-Properties block — the
 * "Crude" column of the Cut Data block carries the whole-crude
 * value (Yield 100% wt, density 0.8343 kg/L, sulphur 0.424%, etc.).
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

export function parseBpAssay(args: {
  sourceFile: string;
  sheets: LoadedSheet[];
}): ParsedAssay | null {
  const { sourceFile, sheets } = args;

  const summary = sheets.find((s) => s.name === 'Summary') ?? sheets[0]!;
  if (!summary) return null;
  const grid = summary.grid;

  const reference = readLabelRight(grid, 'Reference');
  const name = readLabelRight(grid, 'Name');
  if (!reference || !name) return null;

  const origin = readLabelRight(grid, 'Origin');
  const sampleDate = readLabelRight(grid, 'Sample Date', { date: true });
  const assayDate = readLabelRight(grid, 'Assay Date', { date: true });
  const comments = readLabelRight(grid, 'Comments');

  // Whole-crude properties: BP encodes them as the "Crude" column
  // of the cut block. Find each property row, then read the value
  // immediately to the right of the property label (the "Crude"
  // column lives at startRow.col-side of the cuts).
  const crudeCol = findCrudeColumn(grid);
  const densityRow = findAnyLabel(grid, [
    'Density at 15°C (kg/litre)',
    'Density at 15°C (kg/L)',
  ]);
  const sulphurRow = findAnyLabel(grid, ['Total Sulphur (% wt)', 'Total Sulfur (% wt)']);
  const mercaptanRow = findAnyLabel(grid, [
    'Mercaptan Sulphur (ppm wt)',
    'Mercaptan Sulfur (ppm wt)',
    'Mercaptan Sulphur (ppm)',
  ]);
  const tanRow = findAnyLabel(grid, ['TAN (mg KOH/g)', 'Acidity (mg KOH/g)']);
  const pourRow = findAnyLabel(grid, ['Pour Point (°C)']);
  const nickelRow = findAnyLabel(grid, ['Nickel (ppm wt)', 'Nickel (mg/kg)', 'Nickel (ppm)']);
  const vanadiumRow = findAnyLabel(grid, [
    'Vanadium (ppm wt)',
    'Vanadium (mg/kg)',
    'Vanadium (ppm)',
  ]);

  const densityKgL = crudeCol != null && densityRow ? toNumber(cellAt(grid, densityRow.row, crudeCol)) : null;
  const sulphurWtPct = crudeCol != null && sulphurRow ? toNumber(cellAt(grid, sulphurRow.row, crudeCol)) : null;
  const mercaptanMgKg = crudeCol != null && mercaptanRow ? toNumber(cellAt(grid, mercaptanRow.row, crudeCol)) : null;
  const tan = crudeCol != null && tanRow ? toNumber(cellAt(grid, tanRow.row, crudeCol)) : null;
  const pour = crudeCol != null && pourRow ? toNumber(cellAt(grid, pourRow.row, crudeCol)) : null;
  const nickel = crudeCol != null && nickelRow ? toNumber(cellAt(grid, nickelRow.row, crudeCol)) : null;
  const vanadium = crudeCol != null && vanadiumRow ? toNumber(cellAt(grid, vanadiumRow.row, crudeCol)) : null;

  // BP cuts: each cut occupies one column starting from the column
  // right of the "Crude" column.
  const cuts = parseBpCuts(grid, crudeCol);

  return {
    source: 'bp',
    sourceFile,
    reference,
    name,
    originLabel: origin,
    originCountry: null, // resolved in ingest
    sampleDate,
    assayDate,
    issueDate: null,
    comments,
    densityKgL,
    sulphurWtPct,
    mercaptanSulphurMgKg: mercaptanMgKg,
    acidityMgKohG: tan,
    pourPointC: pour,
    nickelMgKg: nickel,
    vanadiumMgKg: vanadium,
    raw: null,
    cuts,
  };

  function readLabelRight(
    grid: CellGrid,
    label: string,
    opts: { date?: boolean } = {},
  ): string | null {
    const hit = findLabel(grid, label);
    if (!hit) return null;
    const val = findValueRight(grid, hit.row, hit.col, 4);
    if (!val) return null;
    return opts.date ? toDate(val.value) : toText(val.value);
  }
}

/** Find the column index of the "Crude" header (whole-crude column).
 *  Returns null when not found. */
function findCrudeColumn(grid: CellGrid): number | null {
  const hit = findLabel(grid, 'Crude');
  return hit ? hit.col : null;
}

function parseBpCuts(grid: CellGrid, crudeCol: number | null): ParsedCut[] {
  if (crudeCol == null) return [];
  const headerRow = findLabel(grid, 'Cut Data');
  if (!headerRow) return [];

  const startRow = findAnyLabel(grid, ['Start (°C API)', 'Start (°C)']);
  const endRow = findAnyLabel(grid, ['End (°C API)', 'End (°C)']);
  if (!startRow || !endRow) return [];

  const yieldWtRow = findAnyLabel(grid, ['Yield on crude (% wt)', 'Yield (% wt)']);
  const yieldVolRow = findAnyLabel(grid, ['Yield on crude (% vol)', 'Yield (% vol)']);
  const densityRow = findAnyLabel(grid, ['Density at 15°C (kg/litre)', 'Density at 15°C (kg/L)']);
  const sulphurRow = findAnyLabel(grid, ['Total Sulphur (% wt)', 'Total Sulfur (% wt)']);

  const lastCol = lastNonNullCol(grid[endRow.row]!, crudeCol + 1);
  if (lastCol < 0) return [];

  // The cut header (Light Naphtha, Heavy Naphtha, Kero) lives 2-3
  // rows above startRow. Find the nearest non-empty row up.
  const headerLabels = readCutHeaderLabels(grid, startRow.row, crudeCol + 1, lastCol);

  const cuts: ParsedCut[] = [];
  for (let c = crudeCol + 1, order = 0; c <= lastCol; c += 1, order += 1) {
    const startCell = cellAt(grid, startRow.row, c);
    const endCell = cellAt(grid, endRow.row, c);
    const startText = toText(startCell);
    const endText = toText(endCell);
    if (startText == null && endText == null) continue;
    const label = headerLabels[c] ?? `${startText ?? '?'}-${endText ?? '?'}`;
    cuts.push({
      cutLabel: label,
      cutOrder: order,
      startTempC: toNumber(startCell),
      endTempC: toNumber(endCell),
      yieldWtPct: yieldWtRow ? toNumber(cellAt(grid, yieldWtRow.row, c)) : null,
      yieldVolPct: yieldVolRow ? toNumber(cellAt(grid, yieldVolRow.row, c)) : null,
      densityKgL: densityRow ? toNumber(cellAt(grid, densityRow.row, c)) : null,
      sulphurWtPct: sulphurRow ? toNumber(cellAt(grid, sulphurRow.row, c)) : null,
    });
  }
  return cuts;
}

function readCutHeaderLabels(
  grid: CellGrid,
  startRow: number,
  fromCol: number,
  toCol: number,
): Record<number, string> {
  const labels: Record<number, string> = {};
  // Walk up from startRow; the first non-empty row in each column is
  // the cut name. BP places cut names 2 rows above startRow.
  for (let c = fromCol; c <= toCol; c += 1) {
    for (let r = startRow - 1; r >= Math.max(0, startRow - 4); r -= 1) {
      const v = toText(cellAt(grid, r, c));
      if (v && !/^[\d.]+$/.test(v) && !v.toLowerCase().startsWith('start')) {
        labels[c] = v;
        break;
      }
    }
  }
  return labels;
}

function lastNonNullCol(row: Array<CellValue>, fromCol: number): number {
  let last = -1;
  for (let c = fromCol; c < row.length; c += 1) {
    if (row[c] != null && String(row[c]).trim() !== '') last = c;
  }
  return last;
}
