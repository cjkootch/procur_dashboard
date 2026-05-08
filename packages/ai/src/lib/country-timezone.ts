/**
 * ISO 3166-1 alpha-2 country code → primary IANA timezone.
 *
 * Used by the RVM executor's quiet-hours gate. We resolve the
 * recipient's country to a representative timezone, then check
 * whether "now" in that zone falls inside the operator's allowed
 * window (8am-6pm by default).
 *
 * Multi-zone countries map to the most-populous / commercial-center
 * zone:
 *   - US → America/New_York (most populous; non-LA / non-Chicago
 *     recipients still get a reasonable approximation given the
 *     8am-6pm window)
 *   - CA → America/Toronto
 *   - RU → Europe/Moscow
 *   - CN → Asia/Shanghai
 *   - AU → Australia/Sydney
 *   - BR → America/Sao_Paulo
 *
 * For the high-precision case (US East/West coast distinction),
 * future work could derive timezone from the area code of the
 * E.164 number — out of scope here.
 *
 * Coverage: G20 + every major B2B market. Unknown country falls
 * back to UTC (operator's quiet-hours window evaluated against UTC,
 * which is conservative — 8am-6pm UTC roughly covers business
 * hours in EU + UK + most of Africa).
 */

const COUNTRY_TIMEZONE: Record<string, string> = {
  // North America
  US: 'America/New_York',
  CA: 'America/Toronto',
  MX: 'America/Mexico_City',

  // Latin America
  BR: 'America/Sao_Paulo',
  AR: 'America/Argentina/Buenos_Aires',
  CL: 'America/Santiago',
  CO: 'America/Bogota',
  PE: 'America/Lima',
  VE: 'America/Caracas',
  TT: 'America/Port_of_Spain',
  BB: 'America/Barbados',
  JM: 'America/Jamaica',

  // Europe
  GB: 'Europe/London',
  IE: 'Europe/Dublin',
  FR: 'Europe/Paris',
  DE: 'Europe/Berlin',
  IT: 'Europe/Rome',
  ES: 'Europe/Madrid',
  PT: 'Europe/Lisbon',
  NL: 'Europe/Amsterdam',
  BE: 'Europe/Brussels',
  CH: 'Europe/Zurich',
  AT: 'Europe/Vienna',
  SE: 'Europe/Stockholm',
  NO: 'Europe/Oslo',
  DK: 'Europe/Copenhagen',
  FI: 'Europe/Helsinki',
  PL: 'Europe/Warsaw',
  CZ: 'Europe/Prague',
  HU: 'Europe/Budapest',
  RO: 'Europe/Bucharest',
  GR: 'Europe/Athens',
  TR: 'Europe/Istanbul',
  RU: 'Europe/Moscow',

  // Middle East / Africa
  AE: 'Asia/Dubai',
  SA: 'Asia/Riyadh',
  IL: 'Asia/Jerusalem',
  EG: 'Africa/Cairo',
  ZA: 'Africa/Johannesburg',
  NG: 'Africa/Lagos',
  KE: 'Africa/Nairobi',
  MA: 'Africa/Casablanca',

  // Asia-Pacific
  JP: 'Asia/Tokyo',
  KR: 'Asia/Seoul',
  CN: 'Asia/Shanghai',
  HK: 'Asia/Hong_Kong',
  TW: 'Asia/Taipei',
  SG: 'Asia/Singapore',
  MY: 'Asia/Kuala_Lumpur',
  ID: 'Asia/Jakarta',
  PH: 'Asia/Manila',
  TH: 'Asia/Bangkok',
  VN: 'Asia/Ho_Chi_Minh',
  IN: 'Asia/Kolkata',
  PK: 'Asia/Karachi',
  BD: 'Asia/Dhaka',
  AU: 'Australia/Sydney',
  NZ: 'Pacific/Auckland',
};

export function resolveCountryTimezone(country: string | null | undefined): string {
  if (!country) return 'UTC';
  const code = country.trim().toUpperCase();
  return COUNTRY_TIMEZONE[code] ?? 'UTC';
}

/**
 * Get the current hour-of-day (0-23) in the given country's primary
 * timezone. Uses Intl.DateTimeFormat for accurate DST handling
 * without bringing in moment / luxon / etc.
 */
export function currentHourInCountry(
  country: string | null | undefined,
  now: Date = new Date(),
): number {
  const tz = resolveCountryTimezone(country);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const hourPart = parts.find((p) => p.type === 'hour');
  if (!hourPart) return now.getUTCHours();
  // Intl 'hour: 2-digit' returns '00'..'23' in 24h mode; some
  // browser implementations return '24' for midnight. Normalize.
  const hour = Number.parseInt(hourPart.value, 10);
  if (!Number.isFinite(hour)) return now.getUTCHours();
  return hour === 24 ? 0 : hour;
}

/**
 * Is "now" inside the operator's allowed window for outreach to a
 * recipient in `country`? Default 8am-6pm recipient-local per Cole's
 * compliance posture.
 */
export function isWithinQuietHours(input: {
  country: string | null | undefined;
  startHour?: number;
  endHour?: number;
  now?: Date;
}): { allowed: boolean; recipientHour: number; timezone: string } {
  const startHour = input.startHour ?? 8;
  const endHour = input.endHour ?? 18;
  const tz = resolveCountryTimezone(input.country);
  const recipientHour = currentHourInCountry(input.country, input.now);
  return {
    allowed: recipientHour >= startHour && recipientHour < endHour,
    recipientHour,
    timezone: tz,
  };
}
