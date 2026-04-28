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
import { extname, resolve, isAbsolute } from 'node:path';
import { parse as parseCsv } from 'csv-parse/sync';
import * as XLSX from 'xlsx';

export type Row = Record<string, string>;

/**
 * Resolve a user-provided file path against the directory where the
 * user actually invoked the command, not the script's runtime CWD.
 *
 * pnpm --filter switches CWD to the workspace package directory, which
 * means relative paths like `./gort.csv` would resolve under
 * `packages/db/` instead of the user's terminal cwd. pnpm exposes the
 * original cwd as INIT_CWD; tsx/node fall back to process.cwd().
 *
 * Absolute paths pass through unchanged.
 */
export function resolveUserPath(userPath: string): string {
  if (isAbsolute(userPath)) return userPath;
  const baseDir = process.env.INIT_CWD ?? process.cwd();
  return resolve(baseDir, userPath);
}

export async function readTabular(path: string, sheetName?: string): Promise<Row[]> {
  const resolved = resolveUserPath(path);
  const ext = extname(resolved).toLowerCase();
  if (ext === '.xlsx' || ext === '.xls' || ext === '.xlsm') {
    const buf = await readFile(resolved);
    const workbook = XLSX.read(buf, { type: 'buffer' });
    let targetSheet: XLSX.WorkSheet | undefined;
    if (sheetName) {
      targetSheet = workbook.Sheets[sheetName];
      if (!targetSheet) {
        throw new SheetNotFoundError(sheetName, workbook.SheetNames);
      }
    } else {
      targetSheet = workbook.Sheets[workbook.SheetNames[0] ?? ''];
    }
    if (!targetSheet) {
      throw new Error(
        `readTabular: no readable sheet in ${resolved}. Available: ${workbook.SheetNames.join(', ')}`,
      );
    }
    const rows = XLSX.utils.sheet_to_json<Row>(targetSheet, {
      defval: '',
      raw: false, // returns formatted strings (good for our flexible parsing)
    });
    return rows;
  }
  // CSV / fallback path
  const text = await readFile(resolved, 'utf8');
  return parseCsv(text, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as Row[];
}

/**
 * Thrown when a specific sheet name was requested but not present in
 * the workbook. Lets callers distinguish "this xlsx doesn't have the
 * sheet I expected" from "the file doesn't exist or can't be read".
 */
export class SheetNotFoundError extends Error {
  readonly sheetName: string;
  readonly availableSheets: string[];
  constructor(sheetName: string, availableSheets: string[]) {
    super(
      `Sheet "${sheetName}" not found. Available: ${availableSheets.join(', ')}`,
    );
    this.name = 'SheetNotFoundError';
    this.sheetName = sheetName;
    this.availableSheets = availableSheets;
  }
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
