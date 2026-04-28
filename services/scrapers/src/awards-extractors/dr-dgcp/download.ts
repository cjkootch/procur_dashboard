/**
 * OCDS bulk-file discovery + streaming download for DR DGCP.
 *
 * The Open Contracting Data Registry hosts DGCP at publication 22.
 * Per-year .jsonl.gz files follow a fixed URL pattern; there's no
 * listing API, so we enumerate years explicitly. A "full.jsonl.gz"
 * exists too but it's the union of the per-year files — fetching
 * per-year is cheaper to retry on failure and more cache-friendly
 * (older years are immutable; only the current-year file changes).
 */
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';

const OCDR_BASE = 'https://data.open-contracting.org/en/publication/22/download';

/**
 * URL for a per-year DGCP OCDS bulk file. Year is validated as a
 * 4-digit integer to fail fast on caller bugs (passing 2_025 vs '25').
 */
export function getDrDgcpYearUrl(year: number): string {
  if (!Number.isInteger(year) || year < 2010 || year > 2100) {
    throw new Error(`getDrDgcpYearUrl: invalid year ${year}`);
  }
  return `${OCDR_BASE}?name=${year}.jsonl.gz`;
}

/**
 * Default lookback range — current year and the previous N-1 years.
 * Matches the Python caribbean_fuel/dr_extractor.py 5-year window.
 *
 * `asOf` exists so tests can pin "today" without time-traveling the
 * whole runtime.
 */
export function getDefaultLookbackYears(
  yearsBack = 5,
  asOf: Date = new Date(),
): number[] {
  const currentYear = asOf.getUTCFullYear();
  const years: number[] = [];
  for (let i = 0; i < yearsBack; i += 1) {
    years.push(currentYear - i);
  }
  return years;
}

/**
 * Stream lines from a remote .jsonl.gz file. Yields one JSONL line
 * per iteration; never buffers the whole file in memory. 404s for
 * not-yet-published years (e.g., asking for `2026.jsonl.gz` in early
 * 2026) are surfaced as a thrown error — caller decides whether to
 * tolerate.
 *
 * Implementation: fetch → ReadableStream → Node Readable → gunzip → readline.
 * Web ReadableStream → Node Readable conversion is the only somewhat
 * fiddly bit; using `Readable.fromWeb` keeps the rest of the chain
 * idiomatic.
 */
export async function* streamRemoteJsonlGz(url: string): AsyncIterable<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`fetch ${url} failed: HTTP ${response.status}`);
  }
  if (!response.body) {
    throw new Error(`fetch ${url} returned empty body`);
  }
  const nodeStream = Readable.fromWeb(response.body as never);
  const gunzipped = nodeStream.pipe(createGunzip());
  const rl = createInterface({ input: gunzipped, crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim()) yield line;
  }
}
