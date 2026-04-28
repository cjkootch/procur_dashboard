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
  classifyVtcCategory,
  fetchWithRetry,
  loadHtml,
  type NormalizedOpportunity,
  type RawOpportunity,
  type ScrapedDocument,
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
 * Map NAICS code → Discover taxonomy slug. Used at parse time so users
 * can filter the catalog to a single VTC commodity bucket without
 * scanning everything. Slugs match `taxonomy_categories.slug` (seeded
 * via 0027 migration).
 */
const NAICS_TO_CATEGORY: Record<string, string> = {
  '424410': 'food-commodities',
  '424420': 'food-commodities',
  '424440': 'food-commodities',
  '424490': 'food-commodities',
  '424510': 'food-commodities',
  '424590': 'food-commodities',
  '311211': 'food-commodities',
  '311311': 'food-commodities',
  '311615': 'food-commodities',
  '424710': 'petroleum-fuels',
  '424720': 'petroleum-fuels',
  '486990': 'petroleum-fuels',
  '423110': 'vehicles-fleet',
  '423120': 'vehicles-fleet',
  '441110': 'vehicles-fleet',
  '423510': 'minerals-metals',
  '423520': 'minerals-metals',
  '424690': 'minerals-metals',
  '212322': 'minerals-metals',
  '212390': 'minerals-metals',
};

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
   * The country.name is what we surface as beneficiaryCountry for non-US
   * notices (Antigua, Haiti, Iraq, etc) so the country filter works for SAM.
   */
  placeOfPerformance?: {
    city?: { code?: string; name?: string };
    state?: { code?: string; name?: string };
    country?: { code?: string; name?: string };
    zip?: string;
  };
  /**
   * SAM's `description` field in the v2 search response is a URL pointing
   * to a separate `/v1/noticedesc?noticeid=...` endpoint that returns the
   * actual notice text (HTML). We fetch it in a second pass after the
   * search loop completes, populating descriptionText below.
   */
  descriptionUrl?: string;
  /** Plain-text version of the fetched description (HTML stripped). */
  descriptionText?: string;
  /**
   * `resourceLinks` is an array of URLs to attached files (RFP PDFs,
   * amendments, drawings). Surfaced as opportunity documents.
   */
  resourceLinks?: string[];
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
  /** Days to look back from today. Default 60. */
  postedWithinDays?: number;
  /** Page size; SAM caps at 1000. Default 1000. */
  pageSize?: number;
  /** Max pages per NAICS code per run. Default 3 (3 × 1000 = 3000 cap). */
  maxPagesPerNaics?: number;
  /** Override the NAICS list (for testing). */
  naicsCodes?: string[];
  /** Skip the per-notice description fetch (faster, but no AI summary). */
  skipDescriptions?: boolean;
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
    const days = this.input.postedWithinDays ?? 60;
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

    // Second pass: fetch the per-notice description for every row. SAM's
    // search response gives us a URL, not the text; we need the text for
    // AI summary + search index. Sequential keeps us under the 10 req/sec
    // free-tier rate limit without coordination.
    if (!this.input.skipDescriptions) {
      await this.hydrateDescriptions(out, apiKey);
    }

    return out;
  }

  /**
   * For each opportunity, GET the descriptionUrl and stash the HTML-stripped
   * text on rawData.descriptionText. One call per opportunity — for a
   * 60-day VTC-NAICS run that's typically <500 calls (~50 sec at 10 RPS).
   * Errors are logged but don't fail the row; `parse()` falls back to the
   * synthesized description when descriptionText is empty.
   */
  private async hydrateDescriptions(rows: RawOpportunity[], apiKey: string): Promise<void> {
    let fetched = 0;
    let failed = 0;
    for (const row of rows) {
      const data = row.rawData as unknown as SamRawData;
      if (!data.descriptionUrl) continue;
      try {
        // Append our api_key — SAM rejects unauthenticated description
        // calls with 401 even though the URL came from an authenticated
        // search response.
        const url = new URL(data.descriptionUrl);
        url.searchParams.set('api_key', apiKey);
        const res = await fetchWithRetry(url.toString(), {
          method: 'GET',
          headers: COMMON_HEADERS,
          timeoutMs: 30_000,
          retryableStatuses: [408, 429, 502, 503, 504],
        });
        if (!res.ok) {
          failed += 1;
          continue;
        }
        const text = await res.text();
        // Response is sometimes plain text, sometimes JSON {description: "..."}
        let html: string | undefined;
        try {
          const json = JSON.parse(text) as { description?: string } | string;
          html = typeof json === 'string' ? json : json?.description;
        } catch {
          html = text;
        }
        if (html && html.trim().length > 0) {
          data.descriptionText = stripHtml(html);
          fetched += 1;
        }
      } catch (err) {
        failed += 1;
        log.warn('sam.description.failed', {
          noticeId: data.noticeId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    log.info('sam.descriptions.hydrated', { fetched, failed, total: rows.length });
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
        placeOfPerformance: o.placeOfPerformance as SamRawData['placeOfPerformance'],
        descriptionUrl: stringOrUndef(o.description),
        resourceLinks: Array.isArray(o.resourceLinks)
          ? (o.resourceLinks as unknown[])
              .map((r) => (typeof r === 'string' ? r : null))
              .filter((r): r is string => r != null && r.length > 0)
          : undefined,
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

    // Real description if we hydrated it, otherwise synthesize from
    // set-aside / NAICS / PSC / place so search + AI pipeline have
    // something to chew on. Both branches deliver the same shape.
    const description = d.descriptionText ?? synthesizeDescription(d);

    const agencyName = normalizeAgencyName(topLevelAgency(d.fullParentPathName));

    // Beneficiary country: SAM notices for OCONUS work (embassies, FOBs,
    // foreign-aid CIF deliveries to the Caribbean) carry the target
    // country in placeOfPerformance.country. Mirroring how UNGM tags
    // beneficiaryCountry, we surface this so the country filter on
    // Discover finds e.g. "Antigua and Barbuda" SAM rows. CONUS rows
    // (state set, country=USA or unset) leave beneficiaryCountry null —
    // the us-federal jurisdiction itself is the beneficiary.
    const beneficiaryCountry = pickBeneficiaryCountry(d.placeOfPerformance);

    const documents: ScrapedDocument[] | undefined =
      d.resourceLinks && d.resourceLinks.length > 0
        ? d.resourceLinks.map((url, i) => ({
            originalUrl: url,
            documentType: 'attachment',
            title: `Attachment ${i + 1}`,
          }))
        : undefined;

    const award = d.award;
    const awardedAmount =
      award?.amount != null ? Number.parseFloat(String(award.amount)) : undefined;

    // VTC commodity bucket: prefer the NAICS-driven mapping (precise),
    // fall back to keyword classifier on title + description (catches
    // ad-hoc backfills with custom NAICS lists, or any future NAICS we
    // forgot to add to NAICS_TO_CATEGORY).
    const category =
      (d.naicsCode ? NAICS_TO_CATEGORY[d.naicsCode] : undefined) ??
      classifyVtcCategory(`${d.title} ${description ?? ''}`) ??
      undefined;

    return {
      sourceReferenceId: raw.sourceReferenceId,
      sourceUrl: raw.sourceUrl,
      title: d.title.slice(0, 500),
      description,
      referenceNumber: d.solicitationNumber,
      type: d.type ?? d.baseType,
      agencyName,
      category,
      currency: 'USD',
      publishedAt: parseSamDate(d.postedDate),
      deadlineAt: parseIsoDate(d.responseDeadLine),
      language: 'en',
      status,
      awardedAt: parseSamDate(award?.date),
      awardedAmount: Number.isFinite(awardedAmount) ? awardedAmount : undefined,
      awardedToCompanyName: award?.awardee?.name,
      beneficiaryCountry,
      rawContent: d as unknown as Record<string, unknown>,
      documents,
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
 * Returns the cabinet-level head (first segment, raw all-caps).
 * normalizeAgencyName() handles casing.
 */
function topLevelAgency(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const head = path.split('.')[0]?.trim();
  return head && head.length > 0 ? head : undefined;
}

/**
 * Acronyms that should stay all-caps after title-casing. Common-word
 * tokens like ARMY / NAVY are NOT in here (those become "Army" / "Navy"),
 * but real abbreviations like USAID / NASA / DOD / DLA do.
 */
const PRESERVE_ACRONYMS = new Set([
  'USAID', 'USDA', 'NASA', 'NSA', 'CIA', 'FBI', 'DOD', 'DHS', 'GSA',
  'EPA', 'NRC', 'NIH', 'DOE', 'DOJ', 'DOL', 'DOT', 'HHS', 'HUD',
  'FEMA', 'TSA', 'ATF', 'IRS', 'SSA', 'VA', 'USCG', 'DLA', 'SBA',
  'FAA', 'FCC', 'FDA', 'FDIC', 'FTC', 'NRO', 'NGA', 'DCMA', 'DCAA',
  'USACE', 'USAFE', 'USNAVEUR', 'USCYBERCOM', 'USSOCOM',
]);

const SMALL_WORDS = new Set(['of', 'the', 'and', 'for', 'to', 'a', 'an', 'in', 'on']);

/**
 * Convert SAM's all-caps agency strings to title case while keeping
 * known acronyms upper.
 *
 *   "DEPT OF DEFENSE"     → "Department of Defense"
 *   "DEPT OF THE ARMY"    → "Department of the Army"
 *   "USAID"               → "USAID"
 *   "GENERAL SVCS ADMIN"  → "General Svcs Admin"
 *
 * Also expands "DEPT" → "DEPARTMENT" so the result reads naturally.
 */
function normalizeAgencyName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const expanded = name.replace(/\bDEPT\.?\b/gi, 'DEPARTMENT');
  return expanded
    .split(/\s+/)
    .map((w, i) => {
      const upper = w.toUpperCase();
      if (PRESERVE_ACRONYMS.has(upper)) return upper;
      const lower = w.toLowerCase();
      if (i > 0 && SMALL_WORDS.has(lower)) return lower;
      return titleCase(lower);
    })
    .join(' ');
}

/** Title-case a single word while leaving small connectives alone. */
function titleCase(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1).toLowerCase();
}

/** "ANTIGUA AND BARBUDA" → "Antigua and Barbuda". */
function titleCasePlace(s: string | undefined): string | undefined {
  if (!s) return undefined;
  return s
    .split(/\s+/)
    .map((w, i) => (i > 0 && SMALL_WORDS.has(w.toLowerCase()) ? w.toLowerCase() : titleCase(w.toLowerCase())))
    .join(' ');
}

/**
 * Build a comma-separated "city, state, country" string with proper
 * casing. SAM emits all-caps names (`ANTIGUA AND BARBUDA`,
 * `WASHINGTON`); title-case before joining.
 */
function formatPlaceOfPerformance(p: SamRawData['placeOfPerformance']): string | undefined {
  if (!p) return undefined;
  const parts = [p.city?.name, p.state?.name, p.country?.name]
    .map((v) => titleCasePlace(v))
    .filter((v): v is string => typeof v === 'string' && v.length > 0);
  return parts.length > 0 ? parts.join(', ') : undefined;
}

/**
 * Synthesize a description when we don't have the fetched text yet.
 * Same shape as the v1 fallback so AI summary + search still have
 * something to match on.
 */
function synthesizeDescription(d: SamRawData): string | undefined {
  const parts: string[] = [];
  if (d.typeOfSetAsideDescription) parts.push(`Set-aside: ${d.typeOfSetAsideDescription}`);
  if (d.naicsCode) parts.push(`NAICS: ${d.naicsCode}`);
  if (d.classificationCode) parts.push(`PSC: ${d.classificationCode}`);
  const placeText = formatPlaceOfPerformance(d.placeOfPerformance);
  if (placeText) parts.push(`Place of performance: ${placeText}`);
  return parts.length > 0 ? parts.join('\n') : undefined;
}

/**
 * Tag US-federal notices with the beneficiary country when work is
 * performed outside the US. CONUS rows leave it null (the us-federal
 * jurisdiction is the beneficiary). country.code uses ISO3 (USA, ATG,
 * HTI…) — anything other than USA is a foreign place of performance.
 */
function pickBeneficiaryCountry(p: SamRawData['placeOfPerformance']): string | undefined {
  if (!p?.country) return undefined;
  const code = (p.country.code ?? '').toUpperCase();
  // ISO3 USA + legacy 2-char US — both signal CONUS, no beneficiary.
  if (code === 'USA' || code === 'US' || !code) return undefined;
  return titleCasePlace(p.country.name);
}

/**
 * SAM's description endpoint returns HTML. Convert to plain text with
 * paragraph breaks preserved. Cheerio is already a dep via scrapers-core
 * so this stays a one-liner with no extra parser cost.
 */
function stripHtml(html: string): string {
  const $ = loadHtml(html);
  // Inject newlines after block-level tags so the flat .text() output
  // doesn't run paragraphs together.
  $('br, p, div, li, h1, h2, h3, h4, h5, h6, tr').each((_i, el) => {
    $(el).after('\n');
  });
  return $.root()
    .text()
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stringOrUndef(v: unknown): string | undefined {
  if (v == null) return undefined;
  const s = String(v).trim();
  return s.length > 0 ? s : undefined;
}
