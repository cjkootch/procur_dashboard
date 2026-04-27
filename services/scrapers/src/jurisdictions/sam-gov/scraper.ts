/**
 * SAM.gov — US federal government procurement (formerly FedBizOpps).
 *
 * Portal:   https://sam.gov
 * API:      https://api.sam.gov/opportunities/v2/search
 * Auth:     SAM_API_KEY query parameter (free tier — get one at api.sam.gov)
 * Docs:     https://open.gsa.gov/api/get-opportunities-public-api/
 *
 * Surface filtered by NAICS to commodity categories relevant to Vector
 * Trade Capital (food, fuel, vehicles, minerals). SAM publishes ~50K
 * active opportunities at any time across every federal agency; the
 * NAICS filter narrows to a few hundred per month.
 *
 * Set-asides INCLUDED — VTC is a women-owned small business so WOSB /
 * EDWOSB / total-small-business / partial-small-business set-asides are
 * all biddable. typeOfSetAside is left unfiltered server-side; we ingest
 * everything and let the AI pipeline tag relevance.
 *
 * Rate limits: SAM enforces ~10 req/sec for keyed access. The default
 * 1000-row page size + ~5 NAICS-pages-per-run keeps us well under that.
 *
 * v1 omits the per-notice description fetch (description field is a URL
 * to a separate endpoint — would 5x the API call count). Title + AI
 * summary is sufficient for first-pass discovery.
 */
import {
  TenderScraper,
  fetchWithRetry,
  type NormalizedOpportunity,
  type RawOpportunity,
} from '@procur/scrapers-core';
import { log } from '@procur/utils/logger';

const API_BASE = 'https://api.sam.gov/opportunities/v2/search';
const PORTAL = 'https://sam.gov';

/**
 * NAICS codes aligned to VTC's supply categories. Comma-joined into the
 * `ncode=` query param. SAM's API supports comma-separated lists.
 *
 * Categories:
 *   424410-424590  food wholesale (groceries, frozen, poultry, grain)
 *   311211-311615  food processing (flour, sugar, poultry — the few
 *                  food-processing codes a trader might bid on)
 *   424710-424720  petroleum bulk + non-bulk wholesale
 *   486990         pipeline transport (occasionally fuel-delivery contracts)
 *   423110-423120  motor vehicle wholesale + parts
 *   441110         new car dealers (used for federal fleet sales)
 *   423510-423520  metal + mineral/ore wholesale
 *   424690         other chemical & allied (catch-all for specialty mins)
 *   212322,212390  industrial sand + other nonmetallic mineral mining
 */
const VTC_NAICS_CODES = [
  // Food
  '424410',
  '424420',
  '424440',
  '424490',
  '424510',
  '424590',
  '311211',
  '311311',
  '311615',
  // Fuel
  '424710',
  '424720',
  '486990',
  // Vehicles
  '423110',
  '423120',
  '441110',
  // Minerals
  '423510',
  '423520',
  '424690',
  '212322',
  '212390',
];

/**
 * Procurement notice types we care about. SAM publishes ~10 distinct
 * types; for buyers, only solicitations and combined-synopsis-solicitations
 * are immediately actionable. Pre-solicitation gives advance notice. Sources
 * Sought (`r`) is market research, not a real bid opportunity. Award
 * notices (`a`) belong in the "past awards" tab.
 *
 *   o = Solicitation
 *   p = Pre-solicitation
 *   k = Combined Synopsis/Solicitation
 *   r = Sources Sought
 *   a = Award Notice
 *   s = Special Notice
 *   g = Sale of Surplus Property
 *   i = Intent to Bundle Requirements (DoD-Funded)
 */
const ACTIVE_NOTICE_TYPES = ['o', 'p', 'k'];
const AWARD_NOTICE_TYPES = ['a'];

type SamRawData = {
  noticeId: string;
  title: string;
  solicitationNumber?: string;
  fullParentPathName?: string; // agency hierarchy "DEPT OF DEFENSE.DEPT OF THE ARMY.AMC.ACC.ACC-RSA"
  postedDate?: string; // YYYY-MM-DD
  type?: string; // descriptive string, e.g. "Combined Synopsis/Solicitation"
  baseType?: string;
  responseDeadLine?: string; // ISO 8601 with timezone, may be null
  naicsCode?: string;
  classificationCode?: string; // PSC code
  active?: string; // "Yes" | "No"
  award?: {
    date?: string;
    number?: string;
    amount?: string | number;
    awardee?: { name?: string };
  } | null;
  typeOfSetAsideDescription?: string;
  typeOfSetAside?: string;
  uiLink?: string;
  /**
   * placeOfPerformance is a structured object on SAM:
   *   { city: { code, name }, state: { code, name }, country: { code, name }, zip }
   * Stored verbatim in rawContent for the AI pipeline; we don't currently
   * surface it on cards.
   */
  placeOfPerformance?: unknown;
};

type SamSearchResponse = {
  totalRecords?: number;
  limit?: number;
  offset?: number;
  opportunitiesData?: unknown[];
};

type SamInput = {
  /** Override the API key (defaults to env SAM_API_KEY). */
  apiKey?: string;
  /** Days to look back from today. Default 30. */
  postedWithinDays?: number;
  /** Page size; SAM caps at 1000. Default 1000. */
  pageSize?: number;
  /** Max pages per NAICS code per run. Default 3 (3 × 1000 = 3000 cap). */
  maxPagesPerNaics?: number;
  /** Override the NAICS list (for testing). */
  naicsCodes?: string[];
  /** Pre-canned JSON response (for testing). */
  fixtureJson?: SamSearchResponse;
};

const COMMON_HEADERS: Record<string, string> = {
  accept: 'application/json',
  'user-agent': 'procur-scraper/1.0 (+https://discover.procur.app)',
};

export class SamGovScraper extends TenderScraper {
  readonly jurisdictionSlug = 'us-federal';
  readonly sourceName = 'sam-gov';
  readonly portalUrl = PORTAL;

  constructor(private readonly input: SamInput = {}) {
    super();
  }

  async fetch(): Promise<RawOpportunity[]> {
    if (this.input.fixtureJson) {
      return this.parseSearchResponse(this.input.fixtureJson);
    }

    const apiKey = this.input.apiKey ?? process.env.SAM_API_KEY;
    if (!apiKey) {
      throw new Error('SAM_API_KEY env var required (set in trigger.dev project env)');
    }

    const pageSize = this.input.pageSize ?? 1000;
    const maxPages = this.input.maxPagesPerNaics ?? 3;
    const days = this.input.postedWithinDays ?? 30;
    const codes = this.input.naicsCodes ?? VTC_NAICS_CODES;
    const { postedFrom, postedTo } = buildDateRange(days);

    const out: RawOpportunity[] = [];
    const seenNoticeIds = new Set<string>();

    // Pull ACTIVE-type notices (solicitations / pre-sol / combined synopsis).
    // Comma-joined ptype lets us issue one paginated query per NAICS instead
    // of one-per-(naics × type), keeping us well under SAM's 10 req/sec cap.
    for (const naics of codes) {
      const naicsRows = await this.fetchPaginated({
        apiKey,
        ncode: naics,
        ptype: ACTIVE_NOTICE_TYPES.join(','),
        postedFrom,
        postedTo,
        pageSize,
        maxPages,
      });
      let added = 0;
      for (const row of naicsRows) {
        if (seenNoticeIds.has(row.sourceReferenceId)) continue;
        seenNoticeIds.add(row.sourceReferenceId);
        out.push(row);
        added += 1;
      }
      log.info('sam.fetch.naics', { naics, fetched: naicsRows.length, added });
    }

    // Award notices for the same NAICS list, surfaced in the Past-awards
    // tab. Lower volume than active so we cap at 1 page each.
    for (const naics of codes) {
      const awardRows = await this.fetchPaginated({
        apiKey,
        ncode: naics,
        ptype: AWARD_NOTICE_TYPES.join(','),
        postedFrom,
        postedTo,
        pageSize,
        maxPages: 1,
      });
      let added = 0;
      for (const row of awardRows) {
        if (seenNoticeIds.has(row.sourceReferenceId)) continue;
        seenNoticeIds.add(row.sourceReferenceId);
        out.push(row);
        added += 1;
      }
      if (awardRows.length > 0) {
        log.info('sam.fetch.naics_awards', { naics, fetched: awardRows.length, added });
      }
    }

    return out;
  }

  private async fetchPaginated(args: {
    apiKey: string;
    ncode: string;
    ptype: string;
    postedFrom: string;
    postedTo: string;
    pageSize: number;
    maxPages: number;
  }): Promise<RawOpportunity[]> {
    const out: RawOpportunity[] = [];
    let offset = 0;
    for (let page = 0; page < args.maxPages; page += 1) {
      const url = new URL(API_BASE);
      url.searchParams.set('api_key', args.apiKey);
      url.searchParams.set('postedFrom', args.postedFrom);
      url.searchParams.set('postedTo', args.postedTo);
      url.searchParams.set('ncode', args.ncode);
      url.searchParams.set('ptype', args.ptype);
      url.searchParams.set('limit', String(args.pageSize));
      url.searchParams.set('offset', String(offset));

      const res = await fetchWithRetry(url.toString(), {
        method: 'GET',
        headers: COMMON_HEADERS,
        timeoutMs: 60_000,
        retryableStatuses: [408, 429, 502, 503, 504],
      });

      const text = await res.text();
      if (!res.ok) {
        const preview = text.slice(0, 500).replace(/\s+/g, ' ');
        log.error('sam.search.http_error', {
          status: res.status,
          ncode: args.ncode,
          ptype: args.ptype,
          page,
          preview,
        });
        // Don't fail the whole run on one bad NAICS — log and skip.
        return out;
      }

      let json: SamSearchResponse;
      try {
        json = JSON.parse(text) as SamSearchResponse;
      } catch {
        log.error('sam.search.bad_json', {
          ncode: args.ncode,
          page,
          preview: text.slice(0, 300),
        });
        return out;
      }

      const pageRows = this.parseSearchResponse(json);
      out.push(...pageRows);

      const total = json.totalRecords ?? 0;
      offset += args.pageSize;
      if (offset >= total || pageRows.length === 0) break;
    }
    return out;
  }

  private parseSearchResponse(payload: SamSearchResponse): RawOpportunity[] {
    const out: RawOpportunity[] = [];
    const items = Array.isArray(payload.opportunitiesData) ? payload.opportunitiesData : [];
    for (const it of items) {
      if (!it || typeof it !== 'object') continue;
      const o = it as Record<string, unknown>;
      const noticeId = stringOrUndef(o.noticeId);
      const title = stringOrUndef(o.title);
      if (!noticeId || !title) continue;

      const award = o.award as SamRawData['award'];
      const data: SamRawData = {
        noticeId,
        title,
        solicitationNumber: stringOrUndef(o.solicitationNumber),
        fullParentPathName: stringOrUndef(o.fullParentPathName),
        postedDate: stringOrUndef(o.postedDate),
        type: stringOrUndef(o.type),
        baseType: stringOrUndef(o.baseType),
        responseDeadLine: stringOrUndef(o.responseDeadLine),
        naicsCode: stringOrUndef(o.naicsCode),
        classificationCode: stringOrUndef(o.classificationCode),
        active: stringOrUndef(o.active),
        award: award ?? null,
        typeOfSetAsideDescription: stringOrUndef(o.typeOfSetAsideDescription),
        typeOfSetAside: stringOrUndef(o.typeOfSetAside),
        uiLink: stringOrUndef(o.uiLink),
        placeOfPerformance: o.placeOfPerformance,
      };

      out.push({
        sourceReferenceId: `SAM-${noticeId}`,
        sourceUrl: data.uiLink ?? `${PORTAL}/opp/${noticeId}/view`,
        rawData: data as unknown as Record<string, unknown>,
      });
    }
    return out;
  }

  async parse(raw: RawOpportunity): Promise<NormalizedOpportunity | null> {
    const d = raw.rawData as unknown as SamRawData;
    if (!d.title) return null;

    const isAward = d.baseType === 'Award Notice' || d.type === 'Award Notice';
    const status: NormalizedOpportunity['status'] = isAward
      ? 'awarded'
      : d.active === 'No'
        ? 'closed'
        : 'active';

    // Description: synthesize from set-aside + classification + place,
    // since we don't fetch the full description URL in v1. Gives the
    // AI summary pipeline + search index something useful to match on.
    const descParts: string[] = [];
    if (d.typeOfSetAsideDescription) descParts.push(`Set-aside: ${d.typeOfSetAsideDescription}`);
    if (d.naicsCode) descParts.push(`NAICS: ${d.naicsCode}`);
    if (d.classificationCode) descParts.push(`PSC: ${d.classificationCode}`);
    const placeText = formatPlaceOfPerformance(d.placeOfPerformance);
    if (placeText) descParts.push(`Place of performance: ${placeText}`);
    const description = descParts.length > 0 ? descParts.join('\n') : undefined;

    const agencyName = topLevelAgency(d.fullParentPathName);

    const award = d.award;
    const awardedAmount =
      award?.amount != null ? Number.parseFloat(String(award.amount)) : undefined;

    return {
      sourceReferenceId: raw.sourceReferenceId,
      sourceUrl: raw.sourceUrl,
      title: d.title.slice(0, 500),
      description,
      referenceNumber: d.solicitationNumber,
      type: d.type ?? d.baseType,
      agencyName,
      currency: 'USD',
      publishedAt: parseSamDate(d.postedDate),
      deadlineAt: parseIsoDate(d.responseDeadLine),
      language: 'en',
      status,
      awardedAt: parseSamDate(award?.date),
      awardedAmount: Number.isFinite(awardedAmount) ? awardedAmount : undefined,
      awardedToCompanyName: award?.awardee?.name,
      rawContent: d as unknown as Record<string, unknown>,
    };
  }
}

function buildDateRange(days: number): { postedFrom: string; postedTo: string } {
  const today = new Date();
  const past = new Date(today.getTime() - days * 24 * 60 * 60 * 1000);
  return {
    postedFrom: formatMmDdYyyy(past),
    postedTo: formatMmDdYyyy(today),
  };
}

function formatMmDdYyyy(d: Date): string {
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const yyyy = d.getUTCFullYear();
  return `${mm}/${dd}/${yyyy}`;
}

/**
 * SAM dates come as YYYY-MM-DD (postedDate, award.date) — parse as
 * UTC midnight. Bare dates without a timezone are treated as US/Eastern
 * conventionally, but UTC midnight is close enough for "posted on" /
 * "awarded on" display without timezone jitter.
 */
function parseSamDate(s: string | undefined): Date | undefined {
  if (!s) return undefined;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/**
 * responseDeadLine is full ISO 8601 with timezone offset, e.g.
 *   "2024-01-31T17:00:00-05:00"
 * Native Date parses these correctly.
 */
function parseIsoDate(s: string | undefined): Date | undefined {
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/**
 * SAM's `fullParentPathName` is a dot-delimited chain from cabinet
 * department down to a specific contracting office, e.g.:
 *   "DEPT OF DEFENSE.DEPT OF THE ARMY.AMC.ACC.ACC-RSA"
 * For agency display we want the cabinet-level head, so we take the
 * first segment and title-case it. Specific office becomes irrelevant
 * noise in card UX.
 */
function topLevelAgency(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const head = path.split('.')[0]?.trim();
  if (!head) return undefined;
  // Title-case but preserve known acronyms (USDA, GSA, NASA, etc).
  return head
    .split(/\s+/)
    .map((w) => (w.length <= 4 && w === w.toUpperCase() ? w : titleCase(w)))
    .join(' ');
}

function titleCase(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1).toLowerCase();
}

function formatPlaceOfPerformance(p: unknown): string | undefined {
  if (!p || typeof p !== 'object') return undefined;
  const o = p as Record<string, unknown>;
  const city = (o.city as Record<string, unknown> | undefined)?.name;
  const state = (o.state as Record<string, unknown> | undefined)?.name;
  const country = (o.country as Record<string, unknown> | undefined)?.name;
  const parts = [city, state, country].filter((v): v is string => typeof v === 'string' && v.length > 0);
  return parts.length > 0 ? parts.join(', ') : undefined;
}

function stringOrUndef(v: unknown): string | undefined {
  if (v == null) return undefined;
  const s = String(v).trim();
  return s.length > 0 ? s : undefined;
}
