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
   * <div role="row" data-noticeid="..."> with all metadata flattened
   * into one big concatenated text blob. Confirmed against live data
   * (UNDP-SUR-00166 and others), the format is:
   *
   *   [<button>] <TITLE> <deadline-date> <time> (GMT ±N) <sort> <publish-date> <agency> <type> <ref> <country> [Open in a new window]
   *
   * KEY INSIGHT (cost three deploys to figure out): the TITLE comes
   * BEFORE the first date, not after. Earlier versions assumed the
   * leading date was a strippable prefix and the title was after it.
   * It's the opposite. Use the first occurrence of dd-Mmm-yyyy as a
   * splitter — title is everything before it, metadata everything
   * after.
   */
  private parseSearchHtml(html: string): RawOpportunity[] {
    const $ = loadHtml(html);
    const out: RawOpportunity[] = [];

    $('div[data-noticeid], div[data-notice-id], div[data-id]').each((_i, el) => {
      const $row = $(el);
      const id = $row.attr('data-noticeid') ?? $row.attr('data-notice-id') ?? $row.attr('data-id');
      if (!id) return;

      // Strip every known UNGM aria-label / tooltip / button-text
      // pattern. UNGM flattens all this accessibility text into the
      // row's textContent because every interactive element has both
      // an icon (visible) and a screen-reader-only span. Each pattern
      // here was discovered the hard way after seeing it leak into a
      // title in production.
      const cleaned = collapseWhitespace($row.text())
        // External-link icon (multiple per row).
        .replace(/\bOpen in a new window\b/g, ' ')
        // Save bookmark button — logged-in variant.
        .replace(/\bUnsave this procurement opportunity\.?/gi, ' ')
        .replace(/\bSave this procurement opportunity\.?/gi, ' ')
        // Save bookmark button — anonymous variant (trigger.dev workers).
        .replace(
          /\bSubscribe to UNGM Pro to be able to save procurement opportunities\.?/gi,
          ' ',
        )
        // Sustainability badge.
        .replace(
          /\bThis procurement opportunity meets the requirements to be considered as sustainable\.?/gi,
          ' ',
        )
        // Notice link aria-label / hint text.
        .replace(
          /\bClick on the procurement opportunity to learn more\.?/gi,
          ' ',
        )
        .replace(/\s+/g, ' ')
        .trim();

      // Find the FIRST dd-Mmm-yyyy. That's the deadline date and the
      // splitter between title (before) and structured metadata (after).
      const firstDateMatch = cleaned.match(/\b(\d{1,2}-[A-Za-z]{3}-\d{4})\b/);
      if (!firstDateMatch || firstDateMatch.index == null) {
        // No date in the row — skip. UNGM rows always have a deadline
        // date; if missing, this is probably a header row or layout
        // artifact we shouldn't ingest.
        return;
      }

      const title = cleaned.slice(0, firstDateMatch.index).trim();
      if (!title) return;
      const tail = cleaned.slice(firstDateMatch.index);

      // Parse the post-title region. Best-effort — UNGM's per-notice
      // markup varies. If a field doesn't extract cleanly the AI enrich
      // pipeline usually fills the gap from the AI summary.
      const parsed = parseUngmTail(tail);

      const data: UngmRawData = {
        noticeId: id,
        title,
        reference: parsed.reference,
        agency: parsed.agency,
        noticeType: parsed.noticeType,
        countries: parsed.country ? [parsed.country] : undefined,
        publishedDateUtc: parsed.publishedDateUtc,
        deadlineDateUtc: parsed.deadlineDateUtc,
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
 * Parse the post-title region of a UNGM notice row. Format observed:
 *
 *   <deadline-date> <time> (GMT ±N) <sort-decimal> <publish-date> <agency-tokens> <type-phrase> <ref?> <country?>
 *
 * Example (UNDP-SUR-00166 from a real card):
 *   "27-Apr-2026 20:00 (GMT -4.00) 0.0961783311375 13-Apr-2026 UNDP Request for proposal UNDP-SUR-00166 Suriname"
 *
 * Best-effort extraction: anything we can't confidently identify is
 * left undefined for the AI enrich pipeline to fill in from context.
 */
function parseUngmTail(tail: string): {
  deadlineDateUtc?: string;
  publishedDateUtc?: string;
  agency?: string;
  noticeType?: string;
  reference?: string;
  country?: string;
} {
  // 1. Deadline: <date> <time> (GMT ±N)
  const deadlineMatch = tail.match(
    /^(\d{1,2}-[A-Za-z]{3}-\d{4})\s+(\d{1,2}:\d{2})\s+\(GMT\s*([+-]?\d+(?:\.\d+)?)\)\s*/,
  );
  if (!deadlineMatch) {
    return {};
  }
  const deadlineDateUtc = composeDeadlineIso(
    `${deadlineMatch[1]} ${deadlineMatch[2]}`,
    deadlineMatch[3],
  );
  let rest = tail.slice(deadlineMatch[0].length).trim();

  // 2. Sort decimal (UI sort score we don't care about).
  const sortMatch = rest.match(/^[\d.]+\s+/);
  if (sortMatch) rest = rest.slice(sortMatch[0].length);

  // 3. Optional second date — the publish date (dd-Mmm-yyyy, no time).
  let publishedDateUtc: string | undefined;
  const publishMatch = rest.match(/^(\d{1,2}-[A-Za-z]{3}-\d{4})\s+/);
  if (publishMatch) {
    publishedDateUtc = composeDeadlineIso(`${publishMatch[1]} 00:00`, '0');
    rest = rest.slice(publishMatch[0].length);
  }

  // 4. Reference number — UN refs follow patterns like UNDP-SUR-00166,
  // LRPS-2026-9203289, RFP/2026/12345. Pull the first such token from
  // anywhere in the remaining tail (it doesn't always come last).
  let reference: string | undefined;
  const refMatch = rest.match(/\b([A-Z][A-Z0-9]{1,}(?:[-/][A-Z0-9]+)+)\b/);
  if (refMatch && refMatch.index != null) {
    reference = refMatch[1];
    // Splice the ref out so what's left is just agency + type + country.
    rest = (rest.slice(0, refMatch.index) + rest.slice(refMatch.index + refMatch[0].length)).replace(/\s+/g, ' ').trim();
  }

  // 5. Country — typically the last token(s) in the tail. Hard to detect
  // reliably without a country lookup. Skip in v1; AI enrich can pull
  // it from rawContent.

  // 6. Agency — heuristic: the first ALL-CAPS token is usually the
  // agency code (UNDP, WFP, UNHCR, FAO, etc.). The notice-type phrase
  // ("Request for proposal", "Invitation to bid") follows.
  let agency: string | undefined;
  let noticeType: string | undefined;
  const agencyMatch = rest.match(/^([A-Z]{2,}(?:-[A-Z]{2,})?)\s+(.+)$/);
  if (agencyMatch) {
    agency = agencyMatch[1];
    noticeType = agencyMatch[2]?.trim();
  } else if (rest.length > 0) {
    // Couldn't find an obvious agency code — stash whatever's left as
    // notice type so it's at least visible somewhere.
    noticeType = rest;
  }

  return {
    deadlineDateUtc,
    publishedDateUtc,
    agency,
    noticeType,
    reference,
  };
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
