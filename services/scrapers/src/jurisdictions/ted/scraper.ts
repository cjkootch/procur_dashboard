/**
 * TED — Tenders Electronic Daily.
 *
 * Portal:   https://ted.europa.eu
 * API:      https://api.ted.europa.eu/v3/notices/search  (no auth required)
 * Volume:   ~26k notices/30d total feed; ~8k after VTC CPV filter
 *
 * Filtered to CPV (Common Procurement Vocabulary) prefixes matching VTC's
 * supply categories. CPV is the EU's classification — different numbering
 * scheme from US PSC / Canadian GSIN, but the top-level divisions map
 * cleanly to our buckets:
 *
 *   15xxxxxx  Food, beverages, tobacco
 *   09xxxxxx  Petroleum products, fuel, electricity
 *   34xxxxxx  Transport equipment (vehicles)
 *   14xxxxxx  Mining, basic metals, related products
 *
 * Notes:
 * - TED is multilingual (24 EU languages). Title + description fields are
 *   keyed by 3-letter ISO language code. We prefer English and fall back
 *   to the first available language; non-English rows hit the AI translate
 *   pipeline like everything else.
 * - Pagination uses an opaque `iterationNextToken` rather than offset.
 *   Max page size is 250.
 * - TED publishes on weekdays Brussels-time. Scheduling at 4-hour intervals
 *   keeps freshness without redundant calls on weekends.
 */
import {
  TenderScraper,
  classifyVtcCategory,
  fetchWithRetry,
  type NormalizedOpportunity,
  type RawOpportunity,
} from '@procur/scrapers-core';
import { log } from '@procur/utils/logger';

const API_BASE = 'https://api.ted.europa.eu/v3/notices/search';
const PORTAL = 'https://ted.europa.eu';

/**
 * CPV top-level divisions covering VTC's commodity supply lines. The
 * query uses prefix wildcards so all sub-codes within each division
 * match (e.g., 15100000 / 15300000 / 15800000 are all included by `15*`).
 *
 * Excluded: 03xxxxxx (Agricultural raw products) — too broad, caught
 * mostly local farmers' markets-scale notices. Add later if VTC wants
 * agricultural feedstock as well.
 */
const VTC_CPV_PREFIXES = ['15', '09', '34', '14'];

/**
 * Fields we request from the search endpoint. Listed explicitly because
 * (a) `fields` is required (TED rejects empty), and (b) requesting
 * fewer fields reduces response size on bulk pages. Field names follow
 * eForms BT-* conventions plus a few legacy aliases.
 */
const SEARCH_FIELDS = [
  'publication-number',
  'notice-title',
  'publication-date',
  'classification-cpv',
  'buyer-name',
  'organisation-country-buyer',
  'contract-nature',
  'procedure-type',
  'total-value',
  'total-value-cur',
  'place-of-performance',
  'description-lot',
  'description-proc',
  'description-part',
  'deadline-receipt-tender-date-lot',
  'deadline',
  'links',
];

const HEADERS: Record<string, string> = {
  'content-type': 'application/json',
  accept: 'application/json',
  'user-agent': 'procur-scraper/1.0 (+https://discover.procur.app)',
};

const MAX_PAGE_SIZE = 250; // TED-enforced upper bound

/**
 * TED search response per the v3 API. Shape simplified to what we use.
 */
type TedNotice = {
  'publication-number': string;
  'notice-title'?: MultilingualField;
  'publication-date'?: string; // "YYYY-MM-DD+HH:MM" with timezone offset
  'classification-cpv'?: string[]; // 8-digit codes
  'buyer-name'?: MultilingualField;
  'organisation-country-buyer'?: string[]; // ISO3
  'contract-nature'?: string[];
  'procedure-type'?: string;
  'total-value'?: number;
  'total-value-cur'?: string[];
  'place-of-performance'?: string[]; // ISO3
  'description-lot'?: MultilingualField;
  'description-proc'?: MultilingualField;
  'description-part'?: MultilingualField;
  'deadline-receipt-tender-date-lot'?: string[];
  deadline?: string;
  links?: TedLinks;
};

/**
 * TED multilingual field shape varies by field:
 *   notice-title       → Record<lang, string>          (single string)
 *   description-lot    → Record<lang, string[]>        (one per lot)
 *   description-proc   → Record<lang, string[]>
 *   buyer-name         → Record<lang, string[] | string> (varies)
 * `pickEnglish` handles both shapes.
 */
type MultilingualField = Record<string, string | string[]>;

type TedLinks = {
  html?: Record<string, string>;
  htmlDirect?: Record<string, string>;
  pdf?: Record<string, string>;
  xml?: Record<string, string>;
};

type TedSearchResponse = {
  notices: TedNotice[];
  totalNoticeCount?: number;
  iterationNextToken?: string;
  timedOut?: boolean;
};

type TedInput = {
  /** Days back from today. Default 7 for the schedule, override via backfill. */
  postedWithinDays?: number;
  /** CPV prefix list. Default = VTC commodities. Pass [] to take everything. */
  cpvPrefixes?: string[];
  /** Hard cap on pages to fetch (each page = up to 250 notices). Default 50. */
  maxPages?: number;
  /** Pre-canned response for tests. */
  fixture?: TedSearchResponse;
};

export class TedScraper extends TenderScraper {
  readonly jurisdictionSlug = 'eu-ted';
  readonly sourceName = 'ted-eu';
  readonly portalUrl = PORTAL;

  constructor(private readonly input: TedInput = {}) {
    super();
  }

  async fetch(): Promise<RawOpportunity[]> {
    if (this.input.fixture) {
      return this.parseSearchResponse(this.input.fixture);
    }

    const days = this.input.postedWithinDays ?? 7;
    const prefixes = this.input.cpvPrefixes ?? VTC_CPV_PREFIXES;
    const maxPages = this.input.maxPages ?? 50;
    const since = formatTedDate(daysAgo(days));

    const cpvClause = prefixes.length === 0
      ? ''
      : ' AND (' + prefixes.map((p) => `classification-cpv=${p}*`).join(' OR ') + ')';
    const query = `publication-date>=${since}${cpvClause}`;

    const out: RawOpportunity[] = [];
    let nextToken: string | undefined;
    let page = 0;

    while (page < maxPages) {
      const body: Record<string, unknown> = {
        query,
        limit: MAX_PAGE_SIZE,
        fields: SEARCH_FIELDS,
        paginationMode: 'ITERATION',
      };
      if (nextToken) body.iterationNextToken = nextToken;

      const res = await fetchWithRetry(API_BASE, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify(body),
        timeoutMs: 60_000,
        retryableStatuses: [408, 429, 500, 502, 503, 504],
      });

      const text = await res.text();
      if (!res.ok) {
        log.error('ted.search.http_error', {
          status: res.status,
          page,
          preview: text.slice(0, 400),
        });
        break;
      }

      const json = JSON.parse(text) as TedSearchResponse;
      const pageRows = this.parseSearchResponse(json);
      out.push(...pageRows);

      if (page === 0) {
        log.info('ted.search.first_page', {
          query,
          totalNoticeCount: json.totalNoticeCount ?? 'unknown',
          pageRows: pageRows.length,
        });
      }

      nextToken = json.iterationNextToken;
      page += 1;
      if (!nextToken || pageRows.length === 0) break;
    }

    log.info('ted.fetch.done', { pages: page, kept: out.length });
    return out;
  }

  private parseSearchResponse(payload: TedSearchResponse): RawOpportunity[] {
    const out: RawOpportunity[] = [];
    const items = Array.isArray(payload.notices) ? payload.notices : [];
    for (const n of items) {
      const id = n['publication-number'];
      if (!id) continue;

      const link =
        n.links?.html?.ENG ??
        n.links?.htmlDirect?.ENG ??
        Object.values(n.links?.html ?? {})[0] ??
        `${PORTAL}/en/notice/${id}`;

      out.push({
        sourceReferenceId: `TED-${id}`,
        sourceUrl: link,
        rawData: n as unknown as Record<string, unknown>,
      });
    }
    return out;
  }

  async parse(raw: RawOpportunity): Promise<NormalizedOpportunity | null> {
    const n = raw.rawData as unknown as TedNotice;
    const title = pickEnglish(n['notice-title']);
    if (!title) return null;

    const description =
      pickEnglish(n['description-lot']) ??
      pickEnglish(n['description-proc']) ??
      pickEnglish(n['description-part']);

    const language = preferredLanguage(n['notice-title']) ?? 'en';
    // Buyer-name on TED can be `string[]` (per lot) — when a notice
    // has 50 lots all naming the same buying entity, joining everything
    // produces a 5KB string that blows past the btree index limit on
    // `agencies.slug`. Take the first element only since it's almost
    // always the same buyer repeated.
    const buyer = pickFirst(n['buyer-name']);

    // Beneficiary country: only set when place-of-performance is in a
    // KNOWN non-EU destination AND differs from the buyer's country.
    // TED's `place-of-performance` uses NUTS region codes (e.g., CZ010
    // for Prague, BG415 for Sofia), not ISO codes — taking the leading
    // 2 chars gives the country prefix. For intra-EU rows we leave
    // beneficiaryCountry null since the buyer location is the natural
    // jurisdiction context. ECHO humanitarian rows pointing to Haiti /
    // Sahel / etc. surface via the keyword classifier instead.
    const buyerCountry = n['organisation-country-buyer']?.[0];
    const popCode = n['place-of-performance']?.[0]?.slice(0, 2).toUpperCase();
    const beneficiaryCountry =
      popCode && buyerCountry && popCode !== iso3ToIso2(buyerCountry)
        ? iso2ToName(popCode)
        : undefined;

    const cpvCategory = pickCategoryFromCpv(n['classification-cpv']);
    const category =
      cpvCategory ?? classifyVtcCategory(`${title} ${description ?? ''}`) ?? undefined;

    const totalValue = typeof n['total-value'] === 'number' ? n['total-value'] : undefined;
    const currency = n['total-value-cur']?.[0] ?? 'EUR';

    return {
      sourceReferenceId: raw.sourceReferenceId,
      sourceUrl: raw.sourceUrl,
      title: title.slice(0, 500),
      description,
      referenceNumber: n['publication-number'],
      type: n['procedure-type'],
      agencyName: buyer,
      category,
      currency,
      valueEstimate: totalValue,
      publishedAt: parseTedDate(n['publication-date']),
      deadlineAt: parseTedDate(n['deadline-receipt-tender-date-lot']?.[0] ?? n.deadline),
      deadlineTimezone: 'Europe/Brussels',
      language,
      beneficiaryCountry,
      rawContent: n as unknown as Record<string, unknown>,
    };
  }
}

/**
 * CPV prefix → VTC slug mapping. Used as the primary categorizer
 * for TED rows because CPV codes are reliably populated. Falls back
 * to the keyword classifier in parse() when CPV is empty or doesn't
 * cleanly bucket.
 */
function pickCategoryFromCpv(cpvs: string[] | undefined): string | undefined {
  if (!cpvs || cpvs.length === 0) return undefined;
  // Score each VTC bucket by how many of the row's CPVs match it.
  // First-most-hits wins. Avoids a 5-CPV row with one stray vehicle
  // code getting bucketed as vehicles when it's clearly a food order.
  const counts: Record<string, number> = {
    'food-commodities': 0,
    'petroleum-fuels': 0,
    'vehicles-fleet': 0,
    'minerals-metals': 0,
  };
  for (const code of cpvs) {
    const prefix = code.slice(0, 2);
    if (prefix === '15') counts['food-commodities']! += 1;
    else if (prefix === '09') counts['petroleum-fuels']! += 1;
    else if (prefix === '34') counts['vehicles-fleet']! += 1;
    else if (prefix === '14') counts['minerals-metals']! += 1;
  }
  const winner = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return winner && winner[1] > 0 ? winner[0] : undefined;
}

/**
 * Pull the English variant of a multilingual TED field if present,
 * otherwise the first available language. TED's per-language values
 * are arrays (one entry per lot); we join them with newlines so all
 * lot-level text shows up in one description blob.
 */
/**
 * Like `pickEnglish`, but for fields that should resolve to a single
 * value rather than a paragraph join — buyer-name being the canonical
 * example, where TED returns the buyer once per lot. Joining all lot
 * entries produces 5KB+ strings that blow past the agencies.slug
 * btree index limit when slugified.
 */
function pickFirst(field: MultilingualField | undefined): string | undefined {
  if (!field) return undefined;
  const entries = Object.entries(field);
  if (entries.length === 0) return undefined;
  const englishKey = entries.find(([k]) => k.toLowerCase() === 'eng');
  const chosen = englishKey ?? entries[0]!;
  const value = chosen[1];
  if (value == null) return undefined;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const first = value[0];
  if (typeof first !== 'string') return undefined;
  const trimmed = first.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function pickEnglish(field: MultilingualField | undefined): string | undefined {
  if (!field) return undefined;
  const entries = Object.entries(field);
  if (entries.length === 0) return undefined;
  // ENG uppercase or eng lowercase — TED has been inconsistent over time.
  const englishKey = entries.find(([k]) => k.toLowerCase() === 'eng');
  const chosen = englishKey ?? entries[0]!;
  const value = chosen[1];
  if (value == null) return undefined;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return value
    .map((v) => v.trim())
    .filter((v) => v.length > 0)
    .join('\n\n');
}

/**
 * Detect the language of the chosen field so we can flag the row for
 * AI translation. Returns ISO 639-1 (2-char) since the rest of our
 * pipeline keys off that.
 */
function preferredLanguage(field: MultilingualField | undefined): string | undefined {
  if (!field) return undefined;
  const keys = Object.keys(field).map((k) => k.toLowerCase());
  if (keys.includes('eng')) return 'en';
  // Fall back to the first language in the field. Map common 3-letter
  // codes to 2-letter; everything else returns undefined and the row
  // gets default 'en' in parse() which the AI pipeline can override
  // after detect-language runs.
  return ISO3_TO_2[keys[0] ?? ''] ?? undefined;
}

const ISO3_TO_2: Record<string, string> = {
  eng: 'en', fra: 'fr', deu: 'de', spa: 'es', ita: 'it', nld: 'nl',
  por: 'pt', pol: 'pl', ces: 'cs', dan: 'da', fin: 'fi', swe: 'sv',
  ron: 'ro', hun: 'hu', ell: 'el', bul: 'bg', hrv: 'hr', slk: 'sk',
  slv: 'sl', est: 'et', lav: 'lv', lit: 'lt', mlt: 'mt', gle: 'ga',
};

/**
 * Map ISO3 (TED's `organisation-country-buyer` format) → ISO2
 * (the prefix used in NUTS region codes for `place-of-performance`).
 * Limited to EU/EEA + UK to keep the table small; the rest fall
 * through and beneficiaryCountry stays null.
 */
const ISO3_TO_ISO2: Record<string, string> = {
  AUT: 'AT', BEL: 'BE', BGR: 'BG', HRV: 'HR', CYP: 'CY', CZE: 'CZ',
  DNK: 'DK', EST: 'EE', FIN: 'FI', FRA: 'FR', DEU: 'DE', GRC: 'EL',
  HUN: 'HU', IRL: 'IE', ITA: 'IT', LVA: 'LV', LTU: 'LT', LUX: 'LU',
  MLT: 'MT', NLD: 'NL', POL: 'PL', PRT: 'PT', ROU: 'RO', SVK: 'SK',
  SVN: 'SI', ESP: 'ES', SWE: 'SE',
  GBR: 'UK', NOR: 'NO', CHE: 'CH', ISL: 'IS', LIE: 'LI',
};

const ISO2_TO_NAME: Record<string, string> = {
  AT: 'Austria', BE: 'Belgium', BG: 'Bulgaria', HR: 'Croatia',
  CY: 'Cyprus', CZ: 'Czech Republic', DK: 'Denmark', EE: 'Estonia',
  FI: 'Finland', FR: 'France', DE: 'Germany', EL: 'Greece',
  GR: 'Greece', HU: 'Hungary', IE: 'Ireland', IT: 'Italy',
  LV: 'Latvia', LT: 'Lithuania', LU: 'Luxembourg', MT: 'Malta',
  NL: 'Netherlands', PL: 'Poland', PT: 'Portugal', RO: 'Romania',
  SK: 'Slovakia', SI: 'Slovenia', ES: 'Spain', SE: 'Sweden',
  UK: 'United Kingdom', GB: 'United Kingdom',
  NO: 'Norway', CH: 'Switzerland', IS: 'Iceland', LI: 'Liechtenstein',
};

function iso3ToIso2(code: string | undefined): string | undefined {
  if (!code) return undefined;
  return ISO3_TO_ISO2[code.toUpperCase()];
}

function iso2ToName(code: string | undefined): string | undefined {
  if (!code) return undefined;
  return ISO2_TO_NAME[code.toUpperCase()];
}

function daysAgo(days: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d;
}

/**
 * TED expects YYYYMMDD (no separators) in query string filters.
 */
function formatTedDate(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

/**
 * TED dates come in two flavours:
 *   "2026-04-20+02:00"        publication-date — has TZ offset
 *   "2026-05-15"              deadline — date-only (Brussels-local)
 * Native Date handles both correctly; bare YYYY-MM-DD becomes UTC
 * midnight which is close enough for "closes on" display.
 */
function parseTedDate(s: string | undefined): Date | undefined {
  if (!s || s.length === 0) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
}
