/**
 * Read a tabular data file as an array of row objects (header → value).
 *
 * Auto-detects format from the file extension:
 *   .xlsx / .xls / .xlsm  → SheetJS first sheet
 *   .csv / anything else  → csv-parse with column headers
 *
 * GEM trackers ship as .xlsx by default; we'd rather not require the
 * user to manually convert to CSV before ingesting.
 */
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { parse as parseCsv } from 'csv-parse/sync';
import * as XLSX from 'xlsx';

export type Row = Record<string, string>;

export async function readTabular(path: string, sheetName?: string): Promise<Row[]> {
  const ext = extname(path).toLowerCase();
  if (ext === '.xlsx' || ext === '.xls' || ext === '.xlsm') {
    const buf = await readFile(path);
    const workbook = XLSX.read(buf, { type: 'buffer' });
    const targetSheet =
      (sheetName && workbook.Sheets[sheetName]) ||
      workbook.Sheets[workbook.SheetNames[0] ?? ''];
    if (!targetSheet) {
      throw new Error(
        `readTabular: no readable sheet in ${path}. Available: ${workbook.SheetNames.join(', ')}`,
      );
    }
    const rows = XLSX.utils.sheet_to_json<Row>(targetSheet, {
      defval: '',
      raw: false, // returns formatted strings (good for our flexible parsing)
    });
    return rows;
  }
  // CSV / fallback path
  const text = await readFile(path, 'utf8');
  return parseCsv(text, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as Row[];
}

/**
 * Pick the first non-empty value from candidate column names
 * (case-insensitive). Tolerates GEM renaming columns across releases.
 */
export function pickCol(row: Row, ...names: string[]): string | null {
  const lc: Record<string, string> = {};
  for (const [k, v] of Object.entries(row)) lc[k.toLowerCase()] = v;
  for (const n of names) {
    const v = lc[n.toLowerCase()];
    if (v != null && String(v).trim().length > 0) return String(v).trim();
  }
  return null;
}

export function parseNumberSafe(s: string | null): number | null {
  if (!s) return null;
  const cleaned = s.replace(/[, ]/g, '').replace(/[^0-9.\-eE]/g, '');
  if (!cleaned) return null;
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}
