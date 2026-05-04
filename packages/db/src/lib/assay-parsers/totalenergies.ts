/**
 * Parser for TotalEnergies "Crude Assays (Total Energies)/" — single
 * "Assay" sheet per file. Layout:
 *
 *   Identity (rows 2-3, col 6 label / col 8 value):
 *     row 2: Crude     | <NAME>
 *     row 3: Country   | <COUNTRY>
 *
 *   Whole-crude properties (rows 5-23, col 2 label / col 5 value):
 *     row 5 : Density at 15°C, kg/m3
 *     row 6 : °API
 *     row 7 : Bbl/mt
 *     row 8 : Viscosity, cSt at 10 °C  (sub-rows for 37.8°C, 50°C)
 *     row 11: Pour Point, °C
 *     row 13: Wax Appearance Temperature °C
 *     row 14: RVP at 37.8 °C, kPa
 *     row 18: Sulphur wt%
 *     row 19: Mercaptan Sulphur, mg/kg
 *     row 20: Hydrogen Sulphide, mg/kg
 *     row 21: Acidity, mg KOH/g
 *     row 22: Nickel, mg/kg
 *     row 23: Vanadium, mg/kg
 *
 *   Assay date at (row 5, col 9).
 *
 *   PROPERTIES OF TBP CUTS block (row 28+) — variable layout per
 *   product family (LIGHT NAPHTHA, HEAVY NAPHTHA, KEROSENE, GASOIL,
 *   VACUUM DISTILLATE, RESIDUE), 1-4 sub-rows per family. Each
 *   family has its own column-header row above the data rows.
 *
 *   v1: capture the whole-crude properties + the cut block as raw
 *   jsonb (preserve fidelity); structured cut extraction is left
 *   to a follow-up since the layout per-family is too variable to
 *   robustly handle here.
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
  type LoadedSheet,
} from '../read-assay-cells';
import type { ParsedAssay, ParsedCut } from './types';

export function parseTotalEnergiesAssay(args: {
  sourceFile: string;
  sheets: LoadedSheet[];
}): ParsedAssay | null {
  const { sourceFile, sheets } = args;

  const assay = sheets.find((s) => s.name === 'Assay') ?? sheets[0]!;
  if (!assay) return null;
  const grid = assay.grid;

  const crudeHit = findLabel(grid, 'Crude');
  const countryHit = findLabel(grid, 'Country');
  if (!crudeHit) return null;

  // Walk right from the label until we find a non-empty string. The
  // name is typically 1-2 columns to the right but can shift per
  // file (BRENT.xlsx puts it at +2, SYNBIT-SHB at +1). The "TBP"
  // header sits further right; capping the search at 4 columns
  // avoids picking that up.
  const nameHit = findValueRight(grid, crudeHit.row, crudeHit.col, 4);
  const name = nameHit ? toText(nameHit.value) : null;
  if (!name) return null;
  const countryVal = countryHit
    ? findValueRight(grid, countryHit.row, countryHit.col, 4)
    : null;
  const country = countryVal ? toText(countryVal.value) : null;

  // Use the filename (without .xlsx) as the producer reference —
  // TotalEnergies doesn't publish an internal ID.
  const reference = sourceFile
    .replace(/^.*\//, '')
    .replace(/\.[^.]+$/, '');

  // Assay date appears on row 5 (or wherever Density at 15°C lives),
  // far right of the value cell. Look for an "Assay Date" label.
  const assayDateLabel = findLabel(grid, 'Assay Date');
  const assayDate = assayDateLabel
    ? toDate(cellAt(grid, assayDateLabel.row, assayDateLabel.col + 2))
    : null;

  // Density at 15°C is in kg/m3 — convert to kg/L (× 0.001).
  const densityKgM3 = readPropNum(grid, [
    'Density at 15°C, kg/m3',
    'Density at 15°C kg/m3',
  ]);
  const densityKgL = densityKgM3 != null ? densityKgM3 / 1000 : null;
  const apiGravity = readPropNum(grid, ['°API', 'API Gravity']);
  const bblPerMt = readPropNum(grid, ['Bbl/mt']);
  const pourPointC = readPropNum(grid, ['Pour Point, °C', 'Pour Point °C']);
  const waxC = readPropNum(grid, ['Wax Appearance Temperature °C', 'Wax Appearance Temperature, °C']);
  const rvpKpa = readPropNum(grid, ['RVP at 37.8 °C, kPa', 'RVP at 37.8°C, kPa']);
  const sulphurWtPct = readPropNum(grid, ['Sulphur wt%', 'Sulfur wt%', 'Total Sulphur wt%']);
  const mercaptanMgKg = readPropNum(grid, ['Mercaptan Sulphur, mg/kg', 'Mercaptan Sulfur, mg/kg']);
  const h2sMgKg = readPropNum(grid, ['Hydrogen Sulphide, mg/kg', 'Hydrogen Sulfide, mg/kg']);
  const tan = readPropNum(grid, ['Acidity, mg KOH/g', 'Acidity mg KOH/g']);
  const nickel = readPropNum(grid, ['Nickel, mg/kg', 'Nickel mg/kg']);
  const vanadium = readPropNum(grid, ['Vanadium, mg/kg', 'Vanadium mg/kg']);

  // Viscosity is published at multiple temperatures, with sub-rows
  // for 10°C, 37.8°C, 50°C. The label "Viscosity, cSt at" sits in
  // col 2 with the temperature in col 3 and the value in col 5.
  const viscosity50 = readViscosityAt(grid, '50');

  // Cut block: capture as raw blob — see file docstring.
  const rawCuts = collectTotalCutsRaw(grid);

  // Heuristic: pour-point check. TotalEnergies sometimes leaves it
  // blank; toNumber('') already returns null so no extra guard.

  const cuts: ParsedCut[] = []; // structured cut extraction deferred (raw kept)

  return {
    source: 'totalenergies',
    sourceFile,
    reference,
    name,
    originLabel: country,
    originCountry: null, // resolved by ingest via country-codes
    sampleDate: null,
    assayDate,
    issueDate: null,
    densityKgL,
    apiGravity,
    bblPerMt,
    pourPointC,
    waxAppearanceTempC: waxC,
    rvpKpa,
    sulphurWtPct,
    mercaptanSulphurMgKg: mercaptanMgKg,
    h2sMgKg,
    acidityMgKohG: tan,
    nickelMgKg: nickel,
    vanadiumMgKg: vanadium,
    viscosityCst50c: viscosity50,
    raw: { cutsBlock: rawCuts },
    cuts,
  };

  function readPropNum(grid: CellGrid, labels: readonly string[]): number | null {
    const hit = findAnyLabel(grid, labels);
    if (!hit) return null;
    // TotalEnergies puts the value 3 columns to the right (col 5
    // for a label in col 2). Try a few offsets to be robust.
    for (const off of [3, 4, 2, 5]) {
      const v = toNumber(cellAt(grid, hit.row, hit.col + off));
      if (v != null) return v;
    }
    return null;
  }

  function readViscosityAt(grid: CellGrid, tempLabel: string): number | null {
    const hit = findLabel(grid, 'Viscosity, cSt at');
    if (!hit) return null;
    // Walk subsequent rows looking for the matching sub-temperature.
    for (let r = hit.row; r <= hit.row + 4 && r < grid.length; r += 1) {
      const tempCell = toText(cellAt(grid, r, hit.col + 1));
      if (tempCell && tempCell.replace(/\s+/g, '').includes(tempLabel)) {
        for (const off of [3, 4, 2, 5]) {
          const v = toNumber(cellAt(grid, r, hit.col + off));
          if (v != null) return v;
        }
      }
    }
    return null;
  }
}

/**
 * Capture the TotalEnergies cut block as a raw matrix (rows × cols
 * of non-null cells, starting from "PROPERTIES OF TBP CUTS"). The
 * follow-up structured parser will mine this without re-reading the
 * source file.
 */
function collectTotalCutsRaw(grid: CellGrid): unknown[] {
  const header = findLabel(grid, 'PROPERTIES OF TBP CUTS');
  if (!header) return [];
  const out: unknown[] = [];
  for (let r = header.row; r < grid.length; r += 1) {
    const row = grid[r]!;
    const compact: Array<{ col: number; value: unknown }> = [];
    for (let c = 0; c < row.length; c += 1) {
      if (row[c] != null && String(row[c]).trim() !== '') {
        const v = row[c];
        compact.push({
          col: c,
          value: v instanceof Date ? v.toISOString() : (v as unknown),
        });
      }
    }
    if (compact.length > 0) out.push({ row: r, cells: compact });
  }
  return out;
}
