import { parse, parseISO, isValid } from 'date-fns';
import { fromZonedTime } from 'date-fns-tz';

const CANDIDATES = [
  // Day-first numeric
  'dd/MM/yyyy',
  'dd-MM-yyyy',
  'dd.MM.yyyy',
  'dd/MM/yy',
  'd/M/yyyy',
  // Day-first with month name (common in Caribbean English)
  'dd-MMM-yyyy',
  'd-MMM-yyyy',
  'dd MMM yyyy',
  'd MMM yyyy',
  'dd MMMM yyyy',
  'd MMMM yyyy',
  // ISO-adjacent
  'yyyy-MM-dd',
  'yyyy/MM/dd',
  // With time
  "yyyy-MM-dd'T'HH:mm:ss",
  'yyyy-MM-dd HH:mm:ss',
  'dd/MM/yyyy HH:mm',
  'dd-MMM-yyyy HH:mm',
  'd MMM yyyy HH:mm',
] as const;

/**
 * Parse a date string that may arrive in any of a wide range of
 * Caribbean / LatAm / African portal formats. Returns null if unparseable.
 *
 * When `timezone` is provided, the parsed wall-clock date is interpreted
 * as local time in that zone and converted to UTC.
 */
export function parseTenderDate(input: string | null | undefined, timezone?: string): Date | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Try ISO first — fastest and most common for modern portals
  const iso = parseISO(trimmed);
  if (isValid(iso)) return iso;

  for (const fmt of CANDIDATES) {
    const parsed = parse(trimmed, fmt, new Date(0));
    if (isValid(parsed)) {
      if (timezone) return fromZonedTime(parsed, timezone);
      return parsed;
    }
  }

  return null;
}
