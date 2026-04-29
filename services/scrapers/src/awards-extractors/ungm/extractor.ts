/**
 * UNGM (UN Global Marketplace) awards extractor.
 *
 * Source:
 *   POST https://www.ungm.org/Public/Notice/Search        — list
 *   GET  https://www.ungm.org/Public/Notice/{id}          — detail HTML
 *
 * Distinct from the existing UNGM scraper at
 * services/scrapers/src/jurisdictions/ungm/scraper.ts which pulls
 * forward-looking opportunity notices into `opportunities`. This
 * extractor filters to NoticeTypeName containing "Contract Award" and
 * builds award rows by parsing the HTML detail page for each.
 *
 * Coverage:
 *   - WFP (World Food Programme) is the largest UN food procurement
 *     entity — tens of millions of USD of food awards annually.
 *   - UNHCR + UNICEF post fuel awards for field operations.
 *   - WHO, UN-OPS, UNFPA post mixed procurement.
 *   - For our use case (Libyan crude buyer ID), UN volume on crude is
 *     near zero. Real value of this extractor is in food + diesel.
 *
 * Two-step pipeline:
 *   1. POST search with NoticeTypes filtered to award-relevant codes
 *   2. For each result, GET the detail page and regex out
 *      contractor name + value + currency
 *
 * Detail-page HTML structure varies by notice type. We use multiple
 * selector fallbacks; rows where parsing fails are skipped (logged so
 * we know the corpus we're missing). The extractor does NOT invent
 * data — without an awardee the row stays out of the supplier-graph.
 */
import {
  AwardsExtractor,
  classifyAwardByUnspsc,
  convertToUsd,
  fetchWithRetry,
  loadHtml,
  textOf,
  type NormalizedAward,
} from '@procur/scrapers-core';

const PORTAL = 'ungm_un';
const PORTAL_HOST = 'https://www.ungm.org';
const SEARCH_PATH = '/Public/Notice/Search';

/**
 * UNGM NoticeTypeName values that indicate an award has been made.
 * Values from observed UNGM responses; extend if new types appear in
 * the unmapped-types log at run end.
 */
const AWARD_NOTICE_TYPE_KEYWORDS = ['contract award', 'award notice'];

const COMMON_HEADERS: Record<string, string> = {
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 ' +
    '(KHTML, like Gecko) Version/18.5 Safari/605.1.15',
  accept: '*/*',
  'accept-language': 'en-US,en;q=0.9',
  'x-requested-with': 'XMLHttpRequest',
  origin: PORTAL_HOST,
  referer: `${PORTAL_HOST}/Public/Notice`,
};

function buildSearchBody(pageIndex: number, pageSize: number): Record<string, unknown> {
  return {
    PageIndex: pageIndex,
    PageSize: pageSize,
    Title: '',
    Description: '',
    Reference: '',
    PublishedFrom: '',
    PublishedTo: '',
    DeadlineFrom: '',
    DeadlineTo: '',
    Countries: [],
    Agencies: [],
    UNSPSCs: [],
    NoticeTypes: [],
    SortField: 'PublishedDate',
    SortAscending: false,
    isPicker: false,
    IsSustainable: false,
    IsActive: false, // include closed/awarded notices
    NoticeDisplayType: null,
    NoticeSearchTotalLabelId: 'noticeSearchTotal',
    TypeOfCompetitions: [],
  };
}

type UngmSearchNotice = {
  Id?: number | string;
  Title?: string;
  Reference?: string;
  AgencyName?: string;
  NoticeTypeName?: string;
  PublishedDateUtc?: string;
  DeadlineDateUtc?: string;
  Countries?: Array<{ Name?: string; Code?: string }>;
  UNSPSCs?: Array<{ Code?: string; Name?: string }>;
};

type UngmSearchResponse = {
  Notices?: UngmSearchNotice[];
  Results?: UngmSearchNotice[];
  TotalRecords?: number;
};

export type UngmAwardsExtractorOptions = {
  /** Pages to walk per run. Default 5 (UNGM search has page-size 100 max). */
  maxPages?: number;
  /** Search page size — UNGM accepts up to ~100. */
  pageSize?: number;
  /** Inject fixture for tests — array of search notices + per-detail HTML. */
  fixture?: {
    notices: UngmSearchNotice[];
    detailHtmlByNoticeId?: Record<string, string>;
  };
};

export class UngmAwardsExtractor extends AwardsExtractor {
  // UNGM has no national jurisdiction in the schema; we use a synthetic
  // 'un' slug. Verify it's seeded — without it the AwardsExtractor base
  // throws on startup.
  readonly jurisdictionSlug = 'un';
  readonly sourcePortal = PORTAL;

  constructor(private readonly options: UngmAwardsExtractorOptions = {}) {
    super();
  }

  async *streamAwards(): AsyncIterable<NormalizedAward> {
    const unmappedTypes = new Set<string>();

    if (this.options.fixture) {
      yield* this.processNotices(
        this.options.fixture.notices,
        this.options.fixture.detailHtmlByNoticeId ?? {},
        unmappedTypes,
        true,
      );
      return;
    }

    const cookieHeader = await this.bootstrapCookies();
    console.log(
      `UNGM: bootstrap cookies ${cookieHeader ? `set (${cookieHeader.split('; ').length} cookies)` : 'EMPTY — request will likely 4xx'}`,
    );
    const pageSize = this.options.pageSize ?? 100;
    const maxPages = this.options.maxPages ?? 5;

    const allAwardNotices: UngmSearchNotice[] = [];
    let totalSearchHits = 0;
    let exitReason = 'completed-all-pages';
    pageLoop: for (let page = 0; page < maxPages; page += 1) {
      const body = buildSearchBody(page, pageSize);
      let res: Response;
      try {
        res = await fetchWithRetry(`${PORTAL_HOST}${SEARCH_PATH}`, {
          method: 'POST',
          headers: {
            ...COMMON_HEADERS,
            'content-type': 'application/json',
            ...(cookieHeader ? { cookie: cookieHeader } : {}),
          },
          body: JSON.stringify(body),
          timeoutMs: 45_000,
          retryableStatuses: [408, 429, 502, 503, 504],
        });
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        console.warn(`UNGM: page ${page} fetch threw: ${m}`);
        exitReason = `fetch-threw-page-${page}`;
        break;
      }
      if (!res.ok) {
        const sample = await res.text().catch(() => '');
        console.warn(
          `UNGM: page ${page} HTTP ${res.status} ${res.statusText}. ` +
            `body[:300]: ${sample.slice(0, 300)}`,
        );
        exitReason = `http-${res.status}-page-${page}`;
        break;
      }

      const text = await res.text();
      let payload: UngmSearchResponse;
      try {
        payload = JSON.parse(text) as UngmSearchResponse;
      } catch {
        console.warn(
          `UNGM: page ${page} got HTTP 200 but body is not JSON. ` +
            `Length=${text.length}. body[:300]: ${text.slice(0, 300)}`,
        );
        exitReason = `non-json-page-${page}`;
        break;
      }
      const items = payload.Notices ?? payload.Results ?? [];
      totalSearchHits += items.length;
      if (page === 0) {
        const responseKeys = Object.keys(payload).join(', ');
        console.log(
          `UNGM: page 0 returned ${items.length} notices ` +
            `(TotalRecords=${payload.TotalRecords ?? 'n/a'}, ` +
            `keys=[${responseKeys}])`,
        );
      }
      if (items.length === 0) {
        if (page === 0) {
          console.warn(
            `UNGM: page 0 returned zero notices — server returned a valid ` +
              `response but with an empty Notices/Results array. Sample of ` +
              `body[:300]: ${text.slice(0, 300)}`,
          );
        }
        exitReason = `empty-page-${page}`;
        break pageLoop;
      }

      for (const n of items) {
        const noticeType = (n.NoticeTypeName ?? '').toLowerCase();
        if (AWARD_NOTICE_TYPE_KEYWORDS.some((kw) => noticeType.includes(kw))) {
          allAwardNotices.push(n);
        } else if (noticeType) {
          unmappedTypes.add(n.NoticeTypeName ?? '');
        }
      }
      if (items.length < pageSize) {
        exitReason = `final-page-${page}-short`;
        break;
      }
    }

    console.log(
      `UNGM: search done. exit=${exitReason}, ` +
        `total_search_hits=${totalSearchHits}, ` +
        `award_matches=${allAwardNotices.length}, ` +
        `unmapped_types=${unmappedTypes.size}`,
    );

    yield* this.processNotices(allAwardNotices, {}, unmappedTypes, false);

    if (unmappedTypes.size > 0) {
      console.warn(
        `UNGM: ${unmappedTypes.size} non-award notice types skipped (informational):`,
      );
      for (const t of unmappedTypes) console.warn(`  ${t}`);
    }
  }

  private async *processNotices(
    notices: UngmSearchNotice[],
    fixtureDetailHtml: Record<string, string>,
    _unmappedTypes: Set<string>,
    isFixture: boolean,
  ): AsyncGenerator<NormalizedAward> {
    for (const n of notices) {
      const id = n.Id != null ? String(n.Id) : '';
      if (!id || !n.Title) continue;

      const detailUrl = `${PORTAL_HOST}/Public/Notice/${id}`;
      let html: string | null = null;
      if (isFixture) {
        html = fixtureDetailHtml[id] ?? null;
      } else {
        try {
          const res = await fetchWithRetry(detailUrl, {
            headers: { ...COMMON_HEADERS, accept: 'text/html,*/*' },
            timeoutMs: 30_000,
          });
          if (res.ok) html = await res.text();
        } catch {
          // detail fetch failed — skip this row
        }
      }

      const detail = html ? parseDetailPage(html) : null;
      if (!detail || !detail.awardee) continue; // No awardee = unusable

      const unspscCodes =
        n.UNSPSCs?.map((c) => String(c.Code ?? '').trim()).filter(Boolean) ?? [];
      const tags = classifyAwardByUnspsc(unspscCodes);
      // Fall back to title-based classification — UNGM frequently has
      // sparse UNSPSC tagging.
      if (tags.length === 0) {
        const titleLower = n.Title.toLowerCase();
        if (/\b(diesel|gasoil|gas oil)\b/.test(titleLower)) tags.push('diesel');
        else if (/\b(petrol|gasoline)\b/.test(titleLower)) tags.push('gasoline');
        else if (/\bjet fuel\b/.test(titleLower)) tags.push('jet-fuel');
        else if (/\b(food|grain|wheat|maize|rice|cereal|sorghum|cooking oil)\b/.test(titleLower))
          tags.push('food-commodities');
      }
      if (tags.length === 0) continue;

      const buyerCountryName = n.Countries?.[0]?.Name ?? '';
      const buyerCountry = mapCountryNameToIso2(buyerCountryName) ?? 'UN';

      const awardDate = (n.PublishedDateUtc ?? '').slice(0, 10) ||
        new Date().toISOString().slice(0, 10);

      yield {
        award: {
          sourcePortal: PORTAL,
          sourceAwardId: id,
          sourceUrl: detailUrl,
          rawPayload: {
            notice_type: n.NoticeTypeName,
            agency: n.AgencyName,
            reference: n.Reference,
            unspsc_codes: unspscCodes,
          },
          buyerName: n.AgencyName ?? 'UN UNKNOWN',
          buyerCountry,
          title: n.Title,
          commodityDescription: n.Title,
          unspscCodes,
          categoryTags: tags,
          contractValueNative: detail.contractValue,
          contractCurrency: detail.contractCurrency,
          contractValueUsd:
            detail.contractValue != null
              ? convertToUsd(detail.contractValue, detail.contractCurrency, awardDate)
              : null,
          awardDate,
          status: 'active',
        },
        awardees: [
          {
            supplier: {
              sourcePortal: PORTAL,
              sourceReferenceId: `${PORTAL}::name::${detail.awardee}`,
              organisationName: detail.awardee,
              country: detail.awardeeCountry ?? null,
            },
            role: 'prime',
            aliases: [detail.awardee],
          },
        ],
      };
    }
  }

  private async bootstrapCookies(): Promise<string | null> {
    try {
      const res = await fetchWithRetry(`${PORTAL_HOST}/Public/Notice`, {
        headers: { ...COMMON_HEADERS, accept: 'text/html,*/*' },
        timeoutMs: 30_000,
      });
      const setCookie = res.headers.get('set-cookie') ?? '';
      if (!setCookie) return null;
      // Naive cookie aggregation — split on commas not inside Expires=...
      const cookies = setCookie
        .split(/,(?=[^;]+=)/g)
        .map((c) => c.split(';')[0]?.trim())
        .filter((c): c is string => Boolean(c));
      return cookies.join('; ');
    } catch {
      return null;
    }
  }
}

// ─── Detail-page parsing ─────────────────────────────────────────────

export type ParsedUngmDetail = {
  awardee: string | null;
  awardeeCountry: string | null;
  contractValue: number | null;
  contractCurrency: string | null;
};

/**
 * Best-effort parse of a UNGM contract-award detail page.
 *
 * Awardee / "Contractor" appears under several labels depending on the
 * UN agency: "Awardee", "Contractor", "Vendor", "Supplier name".
 * Value usually appears as "Total awarded amount", "Contract value",
 * or "Estimated value" with a currency code suffix.
 *
 * Multiple selectors tried in fallback order; first non-empty match wins.
 */
export function parseDetailPage(html: string): ParsedUngmDetail {
  const $ = loadHtml(html);

  // Awardee — labeled cells only (common in agency reports). The
  // free-text regex fallback was too aggressive — it matched phrases
  // like "No awardee yet" with awardee="yet.".
  const awardee = findLabeled($, ['Awardee', 'Contractor', 'Vendor', 'Supplier']);

  const awardeeCountry =
    findLabeled($, ['Awardee country', 'Contractor country', 'Vendor country']) ??
    null;

  const valueText =
    findLabeled($, [
      'Total awarded amount',
      'Awarded amount',
      'Contract value',
      'Total contract value',
      'Estimated value',
    ]) ?? null;
  const { value, currency } = parseValueAndCurrency(valueText);

  return {
    awardee: cleanName(awardee),
    awardeeCountry: cleanName(awardeeCountry),
    contractValue: value,
    contractCurrency: currency,
  };
}

function findLabeled($: ReturnType<typeof loadHtml>, labels: string[]): string | null {
  for (const label of labels) {
    // Try common HTML patterns: <dt>Label</dt><dd>Value</dd>,
    // <th>Label</th><td>Value</td>, <span>Label</span><span>Value</span>.
    let found: string | null = null;
    $('dt, th, label, span, b, strong').each((_i, el) => {
      const text = textOf($(el)).trim();
      if (!new RegExp(`^${escapeRegex(label)}\\b`, 'i').test(text)) return;
      const $next = $(el).next();
      const value = textOf($next).trim();
      if (value && value.length > 1) {
        found = value;
        return false; // break
      }
      return undefined;
    });
    if (found) return found;
  }
  return null;
}

function parseValueAndCurrency(text: string | null): {
  value: number | null;
  currency: string | null;
} {
  if (!text) return { value: null, currency: null };
  // Common formats: "USD 1,234,567.89", "1,234.56 EUR", "$ 100,000"
  const currencyMatch = text.match(/\b(USD|EUR|GBP|CHF|JPY|CAD|AUD|DOP|JMD|INR|AED|SAR)\b/i);
  const currency = currencyMatch?.[1]?.toUpperCase() ?? null;

  const numMatch = text.match(/([\d,.\s]+)/);
  if (!numMatch) return { value: null, currency };
  const raw = numMatch[1]!.replace(/[\s,]/g, '');
  const n = Number.parseFloat(raw);
  return {
    value: Number.isFinite(n) && n > 0 ? n : null,
    currency,
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cleanName(s: string | null): string | null {
  if (!s) return null;
  const cleaned = s.replace(/\s+/g, ' ').trim();
  return cleaned.length > 0 ? cleaned : null;
}

// ─── Country mapping ─────────────────────────────────────────────────

const COUNTRY_NAME_TO_ISO2: Record<string, string> = {
  'united states': 'US',
  'united kingdom': 'GB',
  italy: 'IT',
  spain: 'ES',
  france: 'FR',
  germany: 'DE',
  greece: 'GR',
  india: 'IN',
  indonesia: 'ID',
  pakistan: 'PK',
  bangladesh: 'BD',
  'sri lanka': 'LK',
  ethiopia: 'ET',
  kenya: 'KE',
  nigeria: 'NG',
  egypt: 'EG',
  jordan: 'JO',
  lebanon: 'LB',
  syria: 'SY',
  yemen: 'YE',
  somalia: 'SO',
  'south sudan': 'SS',
  sudan: 'SD',
  ukraine: 'UA',
  afghanistan: 'AF',
  myanmar: 'MM',
  haiti: 'HT',
  switzerland: 'CH',
  'united arab emirates': 'AE',
  'saudi arabia': 'SA',
  qatar: 'QA',
  turkey: 'TR',
  brazil: 'BR',
  china: 'CN',
  japan: 'JP',
  'south korea': 'KR',
  thailand: 'TH',
  vietnam: 'VN',
  philippines: 'PH',
  malaysia: 'MY',
  singapore: 'SG',
  australia: 'AU',
  canada: 'CA',
};

function mapCountryNameToIso2(name: string): string | null {
  const k = name.trim().toLowerCase();
  return COUNTRY_NAME_TO_ISO2[k] ?? null;
}
