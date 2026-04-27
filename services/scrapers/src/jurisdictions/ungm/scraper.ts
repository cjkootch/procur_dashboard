/**
 * United Nations Global Marketplace (UNGM).
 *
 * Portal:   https://www.ungm.org
 * Surface:  Public Notices search (no auth required)
 *
 * UNGM is the single procurement portal for the UN system — WFP food
 * aid, UNDP fuel, UNICEF, UN peacekeeping rations, IAEA, FAO, UNESCO,
 * etc. ~80% of notices are visible without authentication; the rest
 * require a registered supplier account. This scraper covers the
 * public surface.
 *
 * UNGM is an ASP.NET MVC app and the public search form posts as
 * `application/x-www-form-urlencoded`, NOT JSON — first-pass JSON
 * attempts came back HTTP 500 because the .NET model binder couldn't
 * deserialize. Headers also matter: their backend rejects requests
 * missing `X-Requested-With: XMLHttpRequest` and a plausible
 * Origin/Referer, treating them as anti-bot.
 *
 * Document attachments on UNGM notices typically require auth — we
 * skip them in v1.
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

const COMMON_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (compatible; ProcurBot/1.0; +https://procur.app/scraper)',
  accept: 'application/json, text/html, */*; q=0.5',
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
  /** Page size — UNGM accepts up to 100. */
  pageSize?: number;
};

/**
 * UNGM's public search expects ASP.NET MVC form-encoded body — Pascal-cased
 * field names, repeated keys for arrays. JSON returns 500 from their model
 * binder.
 */
function buildFormBody(pageIndex: number, pageSize: number): URLSearchParams {
  const body = new URLSearchParams();
  body.set('PageIndex', String(pageIndex));
  body.set('PageSize', String(pageSize));
  body.set('Title', '');
  body.set('Description', '');
  body.set('Reference', '');
  body.set('PublishedFrom', '');
  body.set('PublishedTo', '');
  body.set('DeadlineFrom', '');
  body.set('DeadlineTo', '');
  body.set('SortField', 'DeadlineUtc');
  body.set('Ascending', 'true');
  // Empty array params still need to be present so the model binder
  // doesn't throw on missing properties.
  body.set('Countries', '');
  body.set('Agencies', '');
  body.set('UNSPSCs', '');
  body.set('NoticeTypes', '');
  body.set('NoticeStatuses', '');
  return body;
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

    for (let page = 0; page < maxPages; page += 1) {
      const body = buildFormBody(page, pageSize);
      const res = await fetchWithRetry(`${PORTAL}${SEARCH_PATH}`, {
        method: 'POST',
        headers: {
          ...COMMON_HEADERS,
          'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        },
        body: body.toString(),
        timeoutMs: 45_000,
      });

      const text = await res.text();
      if (!res.ok) {
        // Embed UNGM's response body directly in the error message so
        // it surfaces in the run's errors[].message field — the
        // separate log.error path was getting swallowed by trigger.dev.
        const ct = res.headers.get('content-type') ?? '';
        const preview = text.slice(0, 600).replace(/\s+/g, ' ');
        log.error('ungm.search.http_error', {
          status: res.status,
          page,
          contentType: ct,
          bodyPreview: preview,
        });
        throw new Error(
          `UNGM search returned ${res.status} on page ${page}. content-type=${ct}. body[0..600]: ${preview}`,
        );
      }

      const contentType = res.headers.get('content-type') ?? '';
      let pageRows: RawOpportunity[];
      if (contentType.includes('application/json') || text.trimStart().startsWith('{')) {
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          log.error('ungm.search.bad_json', {
            page,
            bodyPreview: text.slice(0, 500),
          });
          throw new Error(`UNGM search page ${page}: response claimed JSON but failed to parse`);
        }
        pageRows = this.parseSearchResponse(json);
      } else {
        pageRows = this.parseSearchHtml(text);
      }

      // Log the first response so we can confirm structure on the
      // next run.
      if (page === 0) {
        log.info('ungm.search.first_page', {
          contentType,
          length: text.length,
          rowsParsed: pageRows.length,
          sample: text.slice(0, 300),
        });
      }

      if (pageRows.length === 0) break;
      out.push(...pageRows);
    }

    return out;
  }

  /**
   * JSON path — modern UNGM API. Schema (best-known):
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
   * HTML fallback — UNGM sometimes returns a table fragment for
   * .NET MVC partial views.
   */
  private parseSearchHtml(html: string): RawOpportunity[] {
    const $ = loadHtml(html);
    const out: RawOpportunity[] = [];

    $('tr[data-notice-id], tr[data-id]').each((_i, el) => {
      const $tr = $(el);
      const id = $tr.attr('data-notice-id') ?? $tr.attr('data-id');
      if (!id) return;

      const title = textOf($tr.find('a').first());
      if (!title) return;

      const $cells = $tr.find('td');
      const data: UngmRawData = {
        noticeId: id,
        title,
        reference: textOf($cells.eq(1)) || undefined,
        agency: textOf($cells.eq(2)) || undefined,
        noticeType: textOf($cells.eq(3)) || undefined,
        deadlineDateUtc: textOf($cells.eq(4)) || undefined,
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

function stringOrUndef(v: unknown): string | undefined {
  if (v == null) return undefined;
  const s = String(v).trim();
  return s.length > 0 ? s : undefined;
}

function parseUtc(input: string | undefined): Date | undefined {
  if (!input) return undefined;
  const normalized = /Z$|[+-]\d{2}:?\d{2}$/.test(input) ? input : `${input}Z`;
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? undefined : d;
}
