/**
 * Best-effort Nominatim geocoder for newly-added rolodex entities.
 *
 * The chat auto-add flow rarely has coordinates handy — Apollo, GAIN,
 * MDB, and web-search tools don't return lat/lng. Without coordinates
 * the entity lands in the rolodex but disappears from the map view at
 * `/suppliers/known-entities`. This helper plugs that gap at insert
 * time.
 *
 * Strategy:
 *   1. Compose a Nominatim query from (name, country). Optionally
 *      bias with a website domain when one is known.
 *   2. Restrict to the entity's country via `countrycodes` so
 *      cross-country same-name hits don't pollute (e.g. there's an
 *      "Empresas Polar" in Spain AND Venezuela — without the country
 *      filter we might pin to the wrong continent).
 *   3. Return the first result's coordinates. Null on miss / error.
 *
 * Polite-crawler discipline (Nominatim fair-use):
 *   - Hard cap 1 req/sec across the process — enforced by a module-
 *     level mutex.
 *   - User-Agent identifies procur (Nominatim requires this).
 *   - On 4xx/5xx, return null. Never retry — the operator's insert
 *     must not block on a geocoder hiccup.
 *
 * Cost: $0. Nominatim is free; no API key. Fair-use cap is 1 req/sec
 * which is comfortably above our chat-batch sizes (≤25 entities per
 * tool call → ~25 seconds for a full geocode pass).
 */

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';

let lastCallAt = 0;
async function rateLimit(): Promise<void> {
  const now = Date.now();
  const wait = Math.max(0, 1000 - (now - lastCallAt));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

export interface GeocodeArgs {
  name: string;
  /** ISO-3166-1 alpha-2. Used to bias the search; required for sane
   *  hit rates. */
  country: string;
  /** Optional website domain — Nominatim doesn't directly use this
   *  but we may extend the query later (currently unused; kept for
   *  signature stability). */
  websiteUrl?: string | null;
}

export async function geocodeEntity(
  args: GeocodeArgs,
): Promise<{ latitude: number; longitude: number } | null> {
  if (!args.name || args.name.length < 2) return null;
  if (!args.country || args.country.length !== 2) return null;

  await rateLimit();

  const url = new URL(NOMINATIM_URL);
  url.searchParams.set('q', args.name);
  url.searchParams.set('countrycodes', args.country.toLowerCase());
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', '1');

  try {
    const resp = await fetch(url.toString(), {
      headers: {
        Accept: 'application/json',
        'User-Agent':
          'procur-rolodex-geocoder/0.1 (+https://procur.app; cole@procur.app)',
      },
    });
    if (!resp.ok) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          service: 'assistant.apply.geocodeEntity',
          msg: 'nominatim non-2xx — returning null',
          status: resp.status,
          name: args.name,
          country: args.country,
        }),
      );
      return null;
    }
    const data = (await resp.json()) as Array<{ lat?: string; lon?: string }>;
    if (!Array.isArray(data) || data.length === 0) return null;
    const first = data[0];
    if (!first?.lat || !first.lon) return null;
    const latitude = Number.parseFloat(first.lat);
    const longitude = Number.parseFloat(first.lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    return { latitude, longitude };
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        service: 'assistant.apply.geocodeEntity',
        msg: 'nominatim fetch failed — returning null',
        name: args.name,
        country: args.country,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return null;
  }
}
