/**
 * TED — Tenders Electronic Daily — awards extractor.
 *
 * Source: https://api.ted.europa.eu/v3/notices/search (no auth)
 * Format: JSON, eForms field schema
 *
 * Distinct from the existing TED scraper at
 * services/scrapers/src/jurisdictions/ted/scraper.ts — that pulls
 * forward-looking opportunity notices into the `opportunities` table.
 * This extractor pulls CONTRACT AWARD NOTICES into the supplier-graph
 * `awards` + `award_awardees` tables.
 *
 * Filters via eForms notice-type = 29 (standard CAN), 30 (utilities CAN),
 * 31 (concessions CAN) — the public-procurement award surface.
 *
 * Coverage notes for crude oil + fuel:
 *   - Most EU crude oil flow is PRIVATE commercial (Eni, Repsol, MOL,
 *     OMV, etc) and never appears here.
 *   - What DOES appear: government strategic-reserve buys, military
 *     fuel procurement, public-transport fuel contracts, aviation fuel
 *     for state airlines, marine bunker for navies. ~5-15 fuel awards
 *     per month across the EU27.
 *   - For food (CPV 15*) volumes are higher — government catering,
 *     school programs, military rations.
 *
 * v1 default: filter to CPV 09 (petroleum/fuel) + 15 (food). Override
 * via constructor option.
 */
import {
  AwardsExtractor,
  classifyAwardByUnspsc,
  convertToUsd,
  fetchWithRetry,
  type NormalizedAward,
} from '@procur/scrapers-core';

const API_BASE = 'https://api.ted.europa.eu/v3/notices/search';
const PORTAL = 'ted_eu';
const PORTAL_HOST = 'https://ted.europa.eu';

/** eForms contract-award notice types. */
const AWARD_NOTICE_TYPES = ['29', '30', '31'] as const;

/** ISO-3 → ISO-2 for the EU + EEA + commonly-quoted partners. */
const ISO3_TO_ISO2: Record<string, string> = {
  AUT: 'AT', BEL: 'BE', BGR: 'BG', HRV: 'HR', CYP: 'CY', CZE: 'CZ', DNK: 'DK',
  EST: 'EE', FIN: 'FI', FRA: 'FR', DEU: 'DE', GRC: 'GR', HUN: 'HU', IRL: 'IE',
  ITA: 'IT', LVA: 'LV', LTU: 'LT', LUX: 'LU', MLT: 'MT', NLD: 'NL', POL: 'PL',
  PRT: 'PT', ROU: 'RO', SVK: 'SK', SVN: 'SI', ESP: 'ES', SWE: 'SE',
  NOR: 'NO', ISL: 'IS', LIE: 'LI', CHE: 'CH', GBR: 'GB', UKR: 'UA',
  TUR: 'TR', SRB: 'RS', BIH: 'BA', MKD: 'MK', ALB: 'AL', MNE: 'ME',
};

/** CPV → supplier-graph category tag. Same logic as the Jamaica
 *  GOJEP extractor's classifyCpvCodes (Family 09 fuel; we extend
 *  to Family 15 food and Family 14 minerals to widen the surface). */
function classifyCpvCodes(codes: readonly string[]): string[] {
  const tags = new Set<string>();
  for (const raw of codes) {
    const code = String(raw).replace(/\D/g, '');
    if (!code) continue;
    if (code.startsWith('09134')) tags.add('diesel');
    else if (code.startsWith('09132')) tags.add('gasoline');
    else if (code.startsWith('09131')) tags.add('jet-fuel');
    else if (code.startsWith('09133') || code.startsWith('091221') || code.startsWith('091220'))
      tags.add('lpg');
    else if (code === '09135100' || code === '09135110') tags.add('heating-oil');
    else if (code.startsWith('09135')) tags.add('heavy-fuel-oil');
    else if (code.startsWith('09230') || code === '09000000') tags.add('crude-oil');
    else if (code.startsWith('091') || code.startsWith('092')) tags.add('heavy-fuel-oil');
    else if (code.startsWith('15')) tags.add('food-commodities');
    else if (code.startsWith('1411') || code.startsWith('1412') || code.startsWith('14')) tags.add('minerals-metals');
  }
  return Array.from(tags);
}

const SEARCH_FIELDS = [
  'publication-number',
  'notice-title',
  'notice-type',
  'publication-date',
  'classification-cpv',
  'buyer-name',
  'organisation-country-buyer',
  'total-value',
  'total-value-cur',
  'winner-name',
  'winner-country',
  'links',
] as const;

type MultilingualField = Record<string, string | string[]>;
type TedLinks = { html?: Record<string, string> };

type TedNotice = {
  'publication-number'?: string;
  'notice-title'?: MultilingualField;
  'notice-type'?: string;
  'publication-date'?: string;
  'classification-cpv'?: string[];
  'buyer-name'?: MultilingualField;
  'organisation-country-buyer'?: string[];
  'total-value'?: number;
  'total-value-cur'?: string[];
  'winner-name'?: MultilingualField | string[];
  'winner-country'?: string[];
  links?: TedLinks;
};

type TedSearchResponse = {
  notices?: TedNotice[];
  totalNoticeCount?: number;
  iterationNextToken?: string;
};

const HEADERS: Record<string, string> = {
  'content-type': 'application/json',
  accept: 'application/json',
  'user-agent': 'procur-research/1.0',
};

const MAX_PAGE_SIZE = 250;

export type TedAwardsExtractorOptions = {
  /** Days back from today. Default 30 — TED awards lag publishing by
   *  weeks, so a wider window catches more. */
  postedWithinDays?: number;
  /** CPV prefix list. Default ['09','15'] (fuel + food). */
  cpvPrefixes?: string[];
  /** Hard cap on pages. Default 20 (5,000 award notices per run). */
  maxPages?: number;
  /** Inject a fake response for tests. */
  fixture?: TedSearchResponse;
};

export class TedAwardsExtractor extends AwardsExtractor {
  readonly jurisdictionSlug = 'eu-ted';
  readonly sourcePortal = PORTAL;

  constructor(private readonly options: TedAwardsExtractorOptions = {}) {
    super();
  }

  async *streamAwards(): AsyncIterable<NormalizedAward> {
    if (this.options.fixture) {
      yield* this.parseResponse(this.options.fixture);
      return;
    }

    const days = this.options.postedWithinDays ?? 30;
    const prefixes = this.options.cpvPrefixes ?? ['09', '15'];
    const maxPages = this.options.maxPages ?? 20;
    const since = formatTedDate(daysAgo(days));

    const noticeTypeClause =
      'notice-type IN (' + AWARD_NOTICE_TYPES.map((t) => `"${t}"`).join(' ') + ')';
    const cpvClause = prefixes.length
      ? ' AND (' + prefixes.map((p) => `classification-cpv=${p}*`).join(' OR ') + ')'
      : '';
    const query = `publication-date>=${since} AND ${noticeTypeClause}${cpvClause}`;

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

      let res: Response;
      try {
        res = await fetchWithRetry(API_BASE, {
          method: 'POST',
          headers: HEADERS,
          body: JSON.stringify(body),
          timeoutMs: 60_000,
          retryableStatuses: [408, 429, 500, 502, 503, 504],
        });
      } catch {
        break;
      }
      if (!res.ok) break;

      const json = (await res.json()) as TedSearchResponse;
      const items = json.notices ?? [];
      if (items.length === 0) break;

      yield* this.parseResponse({ notices: items });

      nextToken = json.iterationNextToken;
      page += 1;
      if (!nextToken) break;
    }
  }

  private *parseResponse(payload: TedSearchResponse): Generator<NormalizedAward> {
    const items = Array.isArray(payload.notices) ? payload.notices : [];
    for (const n of items) {
      const id = n['publication-number'];
      if (!id) continue;

      const cpv = n['classification-cpv'] ?? [];
      const tags = classifyCpvCodes(cpv);
      // Fall back to the UNSPSC classifier if for some reason the
      // notice carries UNSPSC instead (rare but defensive).
      const finalTags = tags.length ? tags : classifyAwardByUnspsc(cpv);
      if (finalTags.length === 0) continue;

      const buyerCountryIso3 = n['organisation-country-buyer']?.[0];
      const buyerCountry = buyerCountryIso3
        ? (ISO3_TO_ISO2[buyerCountryIso3] ?? buyerCountryIso3.slice(0, 2))
        : 'EU';
      const buyerName = pickEnglish(n['buyer-name']) ?? 'UNKNOWN';
      const title = pickEnglish(n['notice-title']) ?? null;

      const winnerNames = collectWinners(n['winner-name']);
      if (winnerNames.length === 0) continue;
      const winnerCountriesIso3 = n['winner-country'] ?? [];

      const valueNative = typeof n['total-value'] === 'number' ? n['total-value'] : null;
      const valueCurrency = n['total-value-cur']?.[0]?.toUpperCase() ?? 'EUR';
      const awardDate = (n['publication-date'] ?? '').slice(0, 10) || new Date().toISOString().slice(0, 10);

      const sourceUrl =
        n.links?.html?.ENG ??
        Object.values(n.links?.html ?? {})[0] ??
        `${PORTAL_HOST}/en/notice/${id}`;

      yield {
        award: {
          sourcePortal: PORTAL,
          sourceAwardId: id,
          sourceUrl,
          rawPayload: { publication_number: id, cpv },
          buyerName,
          buyerCountry,
          title,
          commodityDescription: title,
          cpvCodes: cpv,
          categoryTags: finalTags,
          contractValueNative: valueNative,
          contractCurrency: valueCurrency,
          contractValueUsd: convertToUsd(valueNative, valueCurrency, awardDate),
          awardDate,
          status: 'active',
        },
        awardees: winnerNames.map((name, i) => {
          const ci = winnerCountriesIso3[i] ?? winnerCountriesIso3[0];
          const country = ci ? (ISO3_TO_ISO2[ci] ?? ci.slice(0, 2)) : null;
          return {
            supplier: {
              sourcePortal: PORTAL,
              sourceReferenceId: `${PORTAL}::name::${name}`,
              organisationName: name,
              country,
            },
            role: 'prime' as const,
            aliases: [name],
          };
        }),
      };
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

export function pickEnglish(field: MultilingualField | undefined): string | null {
  if (!field) return null;
  const candidates: Array<string | string[] | undefined> = [
    field.ENG,
    field.eng,
    field.EN,
    field.en,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
    if (Array.isArray(c) && c.length && c[0] && typeof c[0] === 'string') return c[0].trim();
  }
  // Fallback to the first non-empty entry in any language.
  for (const v of Object.values(field)) {
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (Array.isArray(v) && v[0] && typeof v[0] === 'string') return v[0].trim();
  }
  return null;
}

export function collectWinners(
  field: MultilingualField | string[] | undefined,
): string[] {
  if (!field) return [];
  if (Array.isArray(field)) {
    return field.filter((s): s is string => typeof s === 'string' && s.trim().length > 0);
  }
  const out: string[] = [];
  for (const v of Object.values(field)) {
    if (typeof v === 'string' && v.trim()) out.push(v.trim());
    else if (Array.isArray(v)) {
      for (const item of v) {
        if (typeof item === 'string' && item.trim()) out.push(item.trim());
      }
    }
  }
  // Dedupe — a multilingual field for "Name" usually carries the same
  // string under every language.
  return Array.from(new Set(out));
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

function formatTedDate(d: Date): string {
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(
    d.getUTCDate(),
  ).padStart(2, '0')}`;
}
