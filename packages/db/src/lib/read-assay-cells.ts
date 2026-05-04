/**
 * Cell-level reader for crude-assay sheets.
 *
 * Crude assay xlsx files don't follow a header-row convention — they
 * use vertical key/value layouts ("Reference: BAKN523Y" sitting in
 * cells (B13, C13)) and matrix layouts (TBP cuts spread across
 * columns C-H+). The `readTabular` helper assumes a header row and
 * doesn't fit; this reader exposes the raw 2D cell grid plus
 * helpers tuned to the assay use-case.
 */
import { readFile } from 'node:fs/promises';
import * as XLSX from 'xlsx';

import { resolveUserPath } from './read-tabular';

/** A 2D array of cells, indexed as `grid[rowIndex][colIndex]`. Rows
 *  and cols are 0-indexed (XLSX row 1 = grid[0]). Empty cells are
 *  `null` so callers can distinguish "absent" from "0" or "''". */
export type CellGrid = Array<Array<CellValue>>;
export type CellValue = string | number | boolean | Date | null;

export type LoadedSheet = {
  name: string;
  grid: CellGrid;
  rows: number;
  cols: number;
};

/** Load all sheets in a workbook as cell grids. */
export async function loadAssayWorkbook(path: string): Promise<LoadedSheet[]> {
  const resolved = resolveUserPath(path);
  const buf = await readFile(resolved);
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
  return wb.SheetNames.map((name) => ({
    name,
    ...sheetToGrid(wb.Sheets[name]!),
  }));
}

function sheetToGrid(ws: XLSX.WorkSheet): { grid: CellGrid; rows: number; cols: number } {
  // sheet_to_json with header:1 + raw:true returns the cell grid as
  // an array of arrays, preserving native cell types (numbers stay
  // numbers, dates stay Date objects).
  const aoa = XLSX.utils.sheet_to_json<Array<CellValue>>(ws, {
    header: 1,
    defval: null,
    raw: true,
    blankrows: true,
  });
  let cols = 0;
  for (const row of aoa) {
    if (row.length > cols) cols = row.length;
  }
  // Right-pad short rows with nulls so grid[r][c] is always defined.
  const grid: CellGrid = aoa.map((row) => {
    const padded: Array<CellValue> = row.slice();
    while (padded.length < cols) padded.push(null);
    return padded;
  });
  return { grid, rows: grid.length, cols };
}

/**
 * Find the first cell whose stringified value matches `label` (case-
 * insensitive, whitespace-trimmed) and return its (row, col).
 * Returns null when the label isn't found.
 */
export function findLabel(grid: CellGrid, label: string): { row: number; col: number } | null {
  const target = normaliseLabel(label);
  for (let r = 0; r < grid.length; r += 1) {
    const row = grid[r]!;
    for (let c = 0; c < row.length; c += 1) {
      const cell = row[c];
      if (cell == null) continue;
      if (normaliseLabel(String(cell)) === target) return { row: r, col: c };
    }
  }
  return null;
}

/**
 * Find the first cell whose stringified value matches ANY of the
 * provided `labels` (case-insensitive). Returns the first hit. Useful
 * when producers spell the same field differently
 * ("Sulphur" vs "Sulfur" vs "Total Sulfur (% wt)").
 */
export function findAnyLabel(
  grid: CellGrid,
  labels: readonly string[],
): { row: number; col: number; label: string } | null {
  for (const label of labels) {
    const hit = findLabel(grid, label);
    if (hit) return { ...hit, label };
  }
  return null;
}

/** Read a cell at (row, col), returning null when out-of-bounds. */
export function cellAt(grid: CellGrid, row: number, col: number): CellValue {
  return grid[row]?.[col] ?? null;
}

/**
 * Walk to the right of `(row, col)` until a non-null cell is found,
 * up to `maxStep` columns. Useful for assays that put the label and
 * value in adjacent (but not necessarily neighbouring) cells. Returns
 * the value + the column it was found in, or null when the row runs
 * out of cells before a value is hit.
 */
export function findValueRight(
  grid: CellGrid,
  row: number,
  col: number,
  maxStep = 6,
): { value: CellValue; col: number } | null {
  const r = grid[row];
  if (!r) return null;
  for (let c = col + 1; c < Math.min(r.length, col + 1 + maxStep); c += 1) {
    if (r[c] != null && String(r[c]).trim() !== '') {
      return { value: r[c]!, col: c };
    }
  }
  return null;
}

/** Coerce a cell to a finite number, or null. */
export function toNumber(v: CellValue): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return null;
  if (v instanceof Date) return null;
  const cleaned = String(v).replace(/[, ]/g, '').replace(/[^0-9.\-eE]/g, '');
  if (!cleaned) return null;
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Coerce a cell to a trimmed string, or null when empty. */
export function toText(v: CellValue): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

/**
 * Coerce a cell to a YYYY-MM-DD date string. Handles:
 *   - native Date objects (xlsx cellDates:true)
 *   - Excel serial numbers (rare, but seen in BP "44680.0" form)
 *   - free-text dates ("17 July 2015", "07 October 2015")
 * Returns null when not parseable.
 */
export function toDate(v: CellValue): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number') {
    // Excel serial date: days since 1899-12-30 (accounting for the
    // Lotus 1-2-3 leap-year bug). XLSX library normalises to that
    // epoch; we re-do the math here for serial numbers that bypass
    // cellDates auto-conversion.
    const ms = (v - 25569) * 86400 * 1000;
    const d = new Date(ms);
    return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : null;
  }
  const s = String(v).trim();
  if (!s) return null;
  // Try direct parsing — handles "2025-03-21", "17 July 2015",
  // "07 October 2015", "21/03/2025" (some locales), etc.
  const parsed = new Date(s);
  if (Number.isFinite(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }
  return null;
}

function normaliseLabel(s: string): string {
  return s
    .toLowerCase()
    .replace(/ /g, ' ') // nbsp → space
    .replace(/[:°*]/g, '') // strip common decorators
    .replace(/\s+/g, ' ')
    .trim();
}
