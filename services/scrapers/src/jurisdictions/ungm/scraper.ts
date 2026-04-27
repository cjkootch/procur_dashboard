/**
 * United Nations Global Marketplace (UNGM).
 *
 * Portal:   https://www.ungm.org
 * Surface:  Public Notices search
 *
 * Real API contract — captured from a live browser cURL after several
 * speculative misses:
 *
 *   POST https://www.ungm.org/Public/Notice/Search
 *   Content-Type: application/json
 *   X-Requested-With: XMLHttpRequest
 *   Cookie: <session + antiforgery cookies from a prior GET to /Public/Notice>
 *   Body: { PageIndex, PageSize, Title, Description, Reference, PublishedFrom,
 *           PublishedTo, DeadlineFrom, DeadlineTo, Countries, Agencies, UNSPSCs,
 *           NoticeTypes, SortField: "Deadline", SortAscending, isPicker,
 *           IsSustainable, IsActive, NoticeDisplayType, NoticeSearchTotalLabelId,
 *           TypeOfCompetitions }
 *
 * Critical: every field above is required. Omit any and .NET's model binder
 * returns a generic 500 from the framework — no useful body. (Hours of
 * speculation taught me this.)
 *
 * Date fields use `dd-MMM-yyyy` format (e.g. `27-Apr-2026`) when set, or
 * empty string when unfiltered. SortField is "Deadline", not "DeadlineUtc".
 *
 * Document attachments on UNGM notices typically require a registered
 * supplier account — skipped in v1.
 */
import {
  TenderScraper,
  fetchWithRetry,
  loadHtml,
  textOf,
  type NormalizedOpportunity,
  type RawOpportunity,
} from '@procur/scrapers-core';
import { log } from '@procur/utils/logger';

const PORTAL = 'https://www.ungm.org';
const SEARCH_PATH = '/Public/Notice/Search';
const NOTICE_DETAIL_PATH = '/Public/Notice'; // /<id>

const COMMON_HEADERS: Record<string, string> = {
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 ' +
    '(KHTML, like Gecko) Version/18.5 Safari/605.1.15',
  accept: '*/*',
  'accept-language': 'en-US,en;q=0.9',
  'x-requested-with': 'XMLHttpRequest',
  origin: PORTAL,
  referer: `${PORTAL}/Public/Notice`,
};

export type UngmRawData = {
  noticeId: string;
  title: string;
  reference?: string;
  description?: string;
  agency?: string;
  noticeType?: string;
  countries?: string[];
  unspscCodes?: string[];
  publishedDateUtc?: string;
  deadlineDateUtc?: string;
};

type UngmInput = {
  fixtureJson?: unknown;
  /** Pages to walk per run. */
  maxPages?: number;
  /** Page size — UNGM accepts up to ~100. */
  pageSize?: number;
};

/**
 * Build the JSON body matching UNGM's documented contract. Every field
 * here is required by their model binder; missing any returns 500.
 */
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
    SortField: 'Deadline',
    SortAscending: true,
    isPicker: false,
    IsSustainable: false,
    IsActive: true,
    NoticeDisplayType: null,
    NoticeSearchTotalLabelId: 'noticeSearchTotal',
    TypeOfCompetitions: [],
  };
}

export class UngmScraper extends TenderScraper {
  readonly jurisdictionSlug = 'un';
  readonly sourceName = 'ungm-public';
  readonly portalUrl = PORTAL;

  constructor(private readonly input: UngmInput = {}) {
    super();
  }

  async fetch(): Promise<RawOpportunity[]> {
    if (this.input.fixtureJson) {
      return this.parseSearchResponse(this.input.fixtureJson);
    }

    const out: RawOpportunity[] = [];
    const pageSize = this.input.pageSize ?? 100;
    const maxPages = this.input.maxPages ?? 5;

    // Bootstrap: GET /Public/Notice once to capture session cookies
    // (especially `ASP.NET_SessionId` and `__RequestVerificationToken`).
    // Without these the search POST returns a generic 500 from inside
    // the antiforgery filter.
    const cookieHeader = await this.bootstrapCookies();

    for (let page = 0; page < maxPages; page += 1) {
      const body = buildSearchBody(page, pageSize);
      const res = await fetchWithRetry(`${PORTAL}${SEARCH_PATH}`, {
        method: 'POST',
        headers: {
          ...COMMON_HEADERS,
          'content-type': 'application/json',
          ...(cookieHeader ? { cookie: cookieHeader } : {}),
        },
        body: JSON.stringify(body),
        timeoutMs: 45_000,
        // 500 stays out of retry — UNGM's 500s are consistent client
        // errors (model-binder rejects), not transient server hiccups.
        retryableStatuses: [408, 429, 502, 503, 504],
      });

      const text = await res.text();
      if (!res.ok) {
        const ct = res.headers.get('content-type') ?? '';
        const preview = text.slice(0, 2000).replace(/\s+/g, ' ');
        log.error('ungm.search.http_error', {
          status: res.status,
          page,
          contentType: ct,
          haveCookie: Boolean(cookieHeader),
          bodyPreview: preview,
        });
        throw new Error(
          `UNGM search returned ${res.status} on page ${page}. content-type=${ct}. cookie=${Boolean(cookieHeader)}. body[0..2000]: ${preview}`,
        );
      }

      const contentType = res.headers.get('content-type') ?? '';
      let pageRows: RawOpportunity[];
      if (contentType.includes('application/json') || text.trimStart().startsWith('{')) {
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          log.error('ungm.search.bad_json', { page, bodyPreview: text.slice(0, 500) });
          throw new Error(`UNGM search page ${page}: response claimed JSON but failed to parse`);
        }
        pageRows = this.parseSearchResponse(json);
      } else {
        pageRows = this.parseSearchHtml(text);
      }

      if (page === 0) {
        // Larger sample (3000 chars) so if the cell-level parser is
        // mis-targeting fields we can see the actual structure of one
        // notice row and target-fix on the next deploy.
        log.info('ungm.search.first_page', {
          contentType,
          length: text.length,
          rowsParsed: pageRows.length,
          sample: text.slice(0, 3000),
        });

        // Also: log a normalized parse of the first row so we can
        // verify which fields were picked up vs missed.
        if (pageRows.length > 0) {
          log.info('ungm.search.first_row', {
            sample: pageRows[0],
          });
        }
      }

      if (pageRows.length === 0) break;
      out.push(...pageRows);
    }

    return out;
  }

  /**
   * GET /Public/Notice once and collect the Set-Cookie headers as a
   * Cookie request header for subsequent POSTs. UNGM's antiforgery
   * filter requires the session + antiforgery cookies even for
   * "anonymous" POSTs.
   */
  private async bootstrapCookies(): Promise<string | null> {
    try {
      const res = await fetchWithRetry(`${PORTAL}/Public/Notice`, {
        method: 'GET',
        headers: COMMON_HEADERS,
        timeoutMs: 30_000,
        retryableStatuses: [408, 429, 502, 503, 504],
      });
      if (!res.ok) {
        log.warn('ungm.bootstrap.non_ok', { status: res.status });
        return null;
      }
      // Drain the body so the connection doesn't sit idle.
      await res.text();

      const setCookies = collectSetCookieHeaders(res);
      const cookieHeader = setCookies.length > 0 ? setCookies.join('; ') : null;
      log.info('ungm.bootstrap', {
        haveCookie: Boolean(cookieHeader),
        cookieCount: setCookies.length,
      });
      return cookieHeader;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn('ungm.bootstrap.failed', { error: msg });
      return null;
    }
  }

  /**
   * JSON path. UNGM's search returns either a partial-rendered HTML
   * fragment or a JSON envelope depending on Accept headers — defensive
   * on both. Field names per browser inspection:
   *   { Notices: [{ Id, Title, Reference, AgencyName, NoticeTypeName,
   *                 PublishedDateUtc, DeadlineDateUtc, Countries: [...] }],
   *     TotalRecords }
   */
  private parseSearchResponse(payload: unknown): RawOpportunity[] {
    const out: RawOpportunity[] = [];
    if (!payload || typeof payload !== 'object') return out;

    const obj = payload as Record<string, unknown>;
    const notices =
      (Array.isArray(obj.Notices) ? obj.Notices : null) ??
      (Array.isArray(obj.Results) ? obj.Results : null) ??
      (Array.isArray(obj) ? obj : null);
    if (!notices) return out;

    for (const n of notices) {
      if (!n || typeof n !== 'object') continue;
      const o = n as Record<string, unknown>;
      const id = String(o.Id ?? o.NoticeId ?? '').trim();
      const title = String(o.Title ?? '').trim();
      if (!id || !title) continue;

      const data: UngmRawData = {
        noticeId: id,
        title,
        reference: stringOrUndef(o.Reference ?? o.NoticeReference),
        description: stringOrUndef(o.Description ?? o.Summary),
        agency: stringOrUndef(o.AgencyName ?? o.AgencyDisplayName ?? o.UNAgency),
        noticeType: stringOrUndef(o.NoticeTypeName ?? o.NoticeType),
        countries: Array.isArray(o.Countries)
          ? (o.Countries as unknown[])
              .map((c) => String((c as Record<string, unknown>)?.Name ?? c))
              .filter(Boolean)
          : undefined,
        unspscCodes: Array.isArray(o.UNSPSCs)
          ? (o.UNSPSCs as unknown[])
              .map((c) => String((c as Record<string, unknown>)?.Code ?? c))
              .filter(Boolean)
          : undefined,
        publishedDateUtc: stringOrUndef(o.PublishedDateUtc ?? o.PublishedOn),
        deadlineDateUtc: stringOrUndef(o.DeadlineDateUtc ?? o.DeadlineOn),
      };

      out.push({
        sourceReferenceId: `UNGM-${id}`,
        sourceUrl: `${PORTAL}${NOTICE_DETAIL_PATH}/${id}`,
        rawData: data as unknown as Record<string, unknown>,
      });
    }

    return out;
  }

  /**
   * HTML path — UNGM's actual response. Each notice is a top-level
   * <div role="row" data-noticeid="297630"> with nested <div role="cell">
   * children. Field positions are guessed from typical UNGM column
   * layout; if any are wrong, the diagnostic log will surface a longer
   * sample for adjustment.
   */
  private parseSearchHtml(html: string): RawOpportunity[] {
    const $ = loadHtml(html);
    const out: RawOpportunity[] = [];

    $('div[data-noticeid], div[data-notice-id], div[data-id]').each((_i, el) => {
      const $row = $(el);
      const id = $row.attr('data-noticeid') ?? $row.attr('data-notice-id') ?? $row.attr('data-id');
      if (!id) return;

      // UNGM's CSS-grid rows render the notice metadata as one big text
      // blob in a single cell, with the title link rendered as an
      // external-link ICON whose anchor text is just "Open in a new
      // window" (screen-reader). Targeting anchors by href / text was
      // fundamentally the wrong approach. Instead: take ALL text from
      // the row and extract title via the consistent format:
      //
      //   <date> <time> (GMT ±N.NN) <decimal-sort-num> · <ref?> <TITLE> Open in a new window
      //
      // The "Open in a new window" suffix is screen-reader text from
      // every external-link icon — strip it. The leading date/number
      // prefix is rendered alongside the title because UNGM uses a
      // single flex cell. Strip it too. What remains is ref + title.

      const rawText = collapseWhitespace($row.text());
      const cleaned = rawText
        // Drop every "Open in a new window" screen-reader cue (multiple
        // can appear if the row has more than one external-link icon).
        .replace(/\bOpen in a new window\b/g, ' ')
        // Drop the bookmark button labels that match anywhere.
        .replace(/\bUnsave this procurement opportunity\.?/gi, ' ')
        .replace(/\bSave this procurement opportunity\.?/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      // Pull out the deadline (date + GMT offset) and the sort score so
      // we can drop them from the title. Format observed:
      //   "27-Apr-2026 23:59 (GMT -4.00) 0.291591816..."
      const deadlineMatch = cleaned.match(
        /^(\d{1,2}-[A-Za-z]{3}-\d{4})\s+(\d{1,2}:\d{2})\s+\(GMT\s*([+-]?\d+(?:\.\d+)?)\)\s*[\d.]+\s*[·\-]?\s*/,
      );

      let titleAndRef = cleaned;
      let deadlineRaw: string | undefined;
      let timezoneOffset: string | undefined;
      if (deadlineMatch) {
        deadlineRaw = `${deadlineMatch[1]} ${deadlineMatch[2]}`;
        timezoneOffset = deadlineMatch[3];
        titleAndRef = cleaned.slice(deadlineMatch[0].length).trim();
      }

      // Try to peel off a leading reference number — UN refs commonly
      // look like "LRPS-2026-9203289", "UNDP-HND-00602",
      // "RFP/2026/12345", etc. Two or more uppercase letters, dashes
      // or slashes, ending in digits.
      let reference: string | undefined;
      const refMatch = titleAndRef.match(
        /^([A-Z][A-Z0-9]{1,}(?:[-/][A-Z0-9]+)+)\s+/,
      );
      if (refMatch) {
        reference = refMatch[1];
        titleAndRef = titleAndRef.slice(refMatch[0].length).trim();
      }

      const title = titleAndRef.trim();
      if (!title) return;

      const cellByClass = (suffix: string): string | undefined => {
        const $hit = $row.find(`[class*="${suffix}"]`).first();
        const t = textOf($hit);
        return t ? collapseWhitespace(t) : undefined;
      };

      const data: UngmRawData = {
        noticeId: id,
        title,
        reference: reference ?? cellByClass('reference'),
        agency: cellByClass('agency'),
        noticeType: cellByClass('noticetype') ?? cellByClass('type') ?? undefined,
        // Compose a deadline ISO string from "27-Apr-2026 23:59" + offset.
        deadlineDateUtc: composeDeadlineIso(deadlineRaw, timezoneOffset),
        publishedDateUtc: cellByClass('published') ?? cellByClass('publishdate'),
        countries: undefined,
      };

      out.push({
        sourceReferenceId: `UNGM-${id}`,
        sourceUrl: `${PORTAL}${NOTICE_DETAIL_PATH}/${id}`,
        rawData: data as unknown as Record<string, unknown>,
      });
    });

    return out;
  }

  async parse(raw: RawOpportunity): Promise<NormalizedOpportunity | null> {
    const d = raw.rawData as unknown as UngmRawData;
    if (!d.title) return null;

    const publishedAt = parseUtc(d.publishedDateUtc);
    const deadlineAt = parseUtc(d.deadlineDateUtc);

    const countriesLine =
      d.countries && d.countries.length > 0 ? `Countries: ${d.countries.join(', ')}` : null;
    const description = [d.description, countriesLine].filter(Boolean).join('\n\n') || undefined;

    return {
      sourceReferenceId: raw.sourceReferenceId,
      sourceUrl: raw.sourceUrl,
      title: d.title.slice(0, 500),
      description,
      referenceNumber: d.reference,
      type: d.noticeType,
      agencyName: d.agency,
      currency: 'USD',
      publishedAt: publishedAt ?? undefined,
      deadlineAt: deadlineAt ?? undefined,
      deadlineTimezone: 'UTC',
      language: 'en',
      rawContent: d as unknown as Record<string, unknown>,
    };
  }
}

/**
 * Pull all Set-Cookie headers from the response and return them as
 * `name=value` pairs. fetch's headers.get('set-cookie') comma-joins
 * which is ambiguous when cookie attributes contain commas
 * (Expires=Wed, 09 Jun 2027 ...). headers.getSetCookie() splits safely.
 */
function collectSetCookieHeaders(res: Response): string[] {
  const all: string[] | undefined = res.headers.getSetCookie?.();
  const list = Array.isArray(all)
    ? all
    : (res.headers.get('set-cookie') ?? '')
        .split(/,(?=\s*[A-Za-z0-9_-]+=)/)
        .map((s) => s.trim())
        .filter(Boolean);

  return list
    .map((line) => line.split(';', 1)[0]?.trim() ?? '')
    .filter(Boolean);
}

function stringOrUndef(v: unknown): string | undefined {
  if (v == null) return undefined;
  const s = String(v).trim();
  return s.length > 0 ? s : undefined;
}

function collapseWhitespace(s: string): string {
  return s.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const MONTH_INDEX_3: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * Combine UNGM's '27-Apr-2026 23:59' text + 'GMT ±N.NN' offset into
 * an ISO 8601 UTC string. Returns undefined if the input is malformed.
 *
 * UNGM's "GMT -4.00" notation means UTC offset of -4 hours; the
 * decimal portion is hours, not minutes (so "-3.30" would be ambiguous
 * but we haven't seen non-zero decimals in practice).
 */
function composeDeadlineIso(
  dateTime: string | undefined,
  gmtOffset: string | undefined,
): string | undefined {
  if (!dateTime) return undefined;
  const m = dateTime.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(\d{1,2}):(\d{2})$/);
  if (!m) return undefined;
  const day = Number.parseInt(m[1]!, 10);
  const monKey = m[2]!.toLowerCase();
  const month = MONTH_INDEX_3[monKey];
  const year = Number.parseInt(m[3]!, 10);
  const hour = Number.parseInt(m[4]!, 10);
  const minute = Number.parseInt(m[5]!, 10);
  if (month == null) return undefined;

  const offsetHours = gmtOffset != null ? Number.parseFloat(gmtOffset) : 0;
  if (Number.isNaN(offsetHours)) return undefined;

  // Convert local-with-offset to UTC: utcMs = localMs - offsetMs.
  const localMs = Date.UTC(year, month, day, hour, minute);
  const utcMs = localMs - offsetHours * 3600 * 1000;
  return new Date(utcMs).toISOString();
}

function parseUtc(input: string | undefined): Date | undefined {
  if (!input) return undefined;
  const normalized = /Z$|[+-]\d{2}:?\d{2}$/.test(input) ? input : `${input}Z`;
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? undefined : d;
}
