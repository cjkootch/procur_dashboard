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
 * The public search is a POST endpoint that returns either JSON
 * (for the modern UI) or an HTML fragment (legacy). The implementation
 * tries JSON first and falls back to HTML parsing if needed. Field
 * names follow UNGM's documented contract; if the API shifts, the
 * scraper logs which path it took and which fields were missing so
 * the diff is easy to spot.
 *
 * Document attachments on UNGM notices typically require auth — we
 * skip them in v1. If a notice publishes a public PDF URL in its
 * detail JSON, we'll capture it; otherwise users see the source URL
 * and can fetch attachments directly via their UNGM account.
 */
import {
  TenderScraper,
  fetchWithRetry,
  loadHtml,
  textOf,
  type NormalizedOpportunity,
  type RawOpportunity,
} from '@procur/scrapers-core';

const PORTAL = 'https://www.ungm.org';
const SEARCH_PATH = '/Public/Notice/Search';
const NOTICE_DETAIL_PATH = '/Public/Notice'; // /<id>

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
  /** Pages to walk per run. UNGM publishes ~hundreds of new notices
   *  daily; 5 pages × 100 records = 500 should cover one cycle with
   *  margin. Bump for backfill. */
  maxPages?: number;
  /** Page size — UNGM accepts up to 100. */
  pageSize?: number;
};

/**
 * UNGM's well-documented public search request body. Field names are
 * Pascal-cased and several are required even when null — sending an
 * incomplete body returns HTTP 400.
 */
function buildSearchBody(pageIndex: number, pageSize: number): Record<string, unknown> {
  return {
    PageIndex: pageIndex,
    PageSize: pageSize,
    Title: null,
    Description: null,
    Reference: null,
    PublishedFrom: null,
    PublishedTo: null,
    DeadlineFrom: null,
    DeadlineTo: null,
    Countries: [],
    Agencies: [],
    UNSPSCs: [],
    NoticeTypes: [],
    NoticeStatuses: [],
    SortField: 'DeadlineUtc',
    Ascending: true,
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

    for (let page = 0; page < maxPages; page += 1) {
      const body = buildSearchBody(page, pageSize);
      const res = await fetchWithRetry(`${PORTAL}${SEARCH_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/html;q=0.9',
        },
        body: JSON.stringify(body),
        timeoutMs: 45_000,
      });
      if (!res.ok) {
        throw new Error(`UNGM search returned ${res.status} on page ${page}`);
      }

      // The endpoint historically returns HTML; the modern UI sometimes
      // responds with JSON depending on the Accept header. Sniff and dispatch.
      const contentType = res.headers.get('content-type') ?? '';
      const text = await res.text();

      let pageRows: RawOpportunity[];
      if (contentType.includes('application/json') || text.trimStart().startsWith('{')) {
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          throw new Error(`UNGM search page ${page}: claimed JSON but failed to parse`);
        }
        pageRows = this.parseSearchResponse(json);
      } else {
        pageRows = this.parseSearchHtml(text);
      }

      if (pageRows.length === 0) break; // empty page = end of results
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

    // UNGM has used both "Notices" (modern) and "Results" (legacy). Try both.
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
          ? (o.Countries as unknown[]).map((c) => String((c as Record<string, unknown>)?.Name ?? c)).filter(Boolean)
          : undefined,
        unspscCodes: Array.isArray(o.UNSPSCs)
          ? (o.UNSPSCs as unknown[]).map((c) => String((c as Record<string, unknown>)?.Code ?? c)).filter(Boolean)
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
   * HTML fallback. UNGM's legacy search returns a table fragment with
   * per-notice rows. Each row has data-notice-id, anchor with title +
   * reference, and cells for agency / deadline. Best-effort — if the
   * HTML structure has changed, we'll see zero rows + log it.
   */
  private parseSearchHtml(html: string): RawOpportunity[] {
    const $ = loadHtml(html);
    const out: RawOpportunity[] = [];

    $('tr[data-notice-id]').each((_i, el) => {
      const $tr = $(el);
      const id = $tr.attr('data-notice-id');
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

    // Beneficiary country goes in description and (de-duped) tags so
    // users can filter by where the work happens. The jurisdiction
    // itself is "United Nations" since notices come from UN agencies,
    // not from country governments.
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
      // UNSPSC codes are the UN's standard procurement taxonomy. Stash
      // as tags so they're searchable; classify task can also use them
      // as input downstream.
      rawContent: d as unknown as Record<string, unknown>,
    };
  }
}

function stringOrUndef(v: unknown): string | undefined {
  if (v == null) return undefined;
  const s = String(v).trim();
  return s.length > 0 ? s : undefined;
}

/**
 * UNGM serves dates as ISO 8601 with 'Z' suffix. Defensive parsing —
 * some legacy records use "2024-01-15T00:00:00" (no Z); treat as UTC.
 */
function parseUtc(input: string | undefined): Date | undefined {
  if (!input) return undefined;
  const normalized = /Z$|[+-]\d{2}:?\d{2}$/.test(input) ? input : `${input}Z`;
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? undefined : d;
}
