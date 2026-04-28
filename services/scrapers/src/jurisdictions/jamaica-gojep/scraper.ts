/**
 * Jamaica — Government of Jamaica Electronic Procurement (GOJEP).
 *
 * Portal:       https://www.gojep.gov.jm
 * Platform:     European Dynamics e-PPS (Struts 1.x, Java)
 *
 * GOJEP exposes three relevant surfaces:
 *
 *   1. "Current Competitions" — what bidders look at, gated behind a
 *      CAPTCHA + search form. Programmatically inaccessible without
 *      authenticated CAPTCHA-solving infra (which would breach ToS).
 *
 *   2. "Opened Tenders" — public, no CAPTCHA, no auth. Tenders past
 *      bid-submission deadline; bids have been opened. Surface: 9-col
 *      table with title, reference, agency, closing-date, method,
 *      evaluation status. ~7,457 paginated pages × 10 rows ≈ 74K
 *      historical records.
 *
 *   3. "Contract Award Notices" — public, no CAPTCHA, no auth. Awards
 *      that have been published. Surface: 7-col table with procedure,
 *      agency, title-link, **awarded value**, award-date, PDF notice.
 *      ~1,120 paginated pages × 10 rows ≈ 11K award records.
 *
 * This scraper consumes (2) + (3). Both feed `opportunities`; surface 3
 * upserts on the same `GOJEP-<resourceId>` after surface 2 so the
 * awarded-value field wins where both surfaces describe the same
 * resourceId.
 *
 * Pagination is DisplayTag-style: `?d-{tableId}-p={page}`. The tableId
 * is page-instance-specific (3680181 for Opened Tenders, 16531 for
 * Award Notices at time of audit) but stable across runs.
 *
 * Detail page (`prepareViewCfTWS.do?resourceId=N`) requires auth
 * (returns the e-PPS welcome page when fetched anonymously). We rely
 * on the listing for v1 metadata; richer per-tender content needs a
 * partnership / authenticated session.
 *
 * History: prior version pointed at /epps/cft/listContracts.do (500s)
 * and assumed a different table class. Both stale.
 */
import {
  TenderScraper,
  fetchWithRetry,
  loadHtml,
  textOf,
  type NormalizedOpportunity,
  type RawOpportunity,
  classifyVtcCategory,
} from '@procur/scrapers-core';
import { fromZonedTime } from 'date-fns-tz';

const PORTAL = 'https://www.gojep.gov.jm';
const OPENED_PATH = '/epps/common/viewOpenedTenders.do';
const AWARDS_PATH = '/epps/viewCaNotices.do';
// Display-tag table ids on the live portal at the time of this commit.
// If GOJEP rotates them on a redesign, parseListing still works because
// it derives them from the response body before paging.
const OPENED_TABLE_ID = '3680181';
const AWARDS_TABLE_ID = '16531';

export type JamaicaSurface = 'opened-tenders' | 'award-notices';

export type JamaicaRawData = {
  surface: JamaicaSurface;
  resourceId: string;
  title: string;
  referenceNumber: string;
  agency: string;
  closingDateText?: string;
  awardDateText?: string;
  awardedValue?: string;
  method?: string;
  evaluationStatus?: string;
  awardNoticePdfUrl?: string;
  detailUrl: string;
};

type ScraperInput = {
  fixtureHtml?: { listing?: string; awards?: string };
  /** Pages of Opened Tenders to walk per run. Default 10 → 100 records.
   *  Bump for backfill (max ~7,457). */
  maxOpenedPages?: number;
  /** Pages of Award Notices to walk per run. Default 10 → 100 records.
   *  Bump for backfill (max ~1,120). */
  maxAwardPages?: number;
};

const DETAIL_HREF_REGEX = /\/epps\/cft\/prepareViewCfTWS\.do\?resourceId=(\d+)/;
const PDF_HREF_REGEX = /\/epps\/notices\/downloadNoticeForES\.do\?resourceId=(\d+)/;

/**
 * GOJEP serves dates in Java's default Date.toString() format:
 *   "Fri Apr 24 13:00:00 COT 2026"
 * The COT abbreviation is whatever the JVM is running in (Cuba/Colombia
 * — both UTC-5 like Jamaica). We strip the abbreviation and treat the
 * wall-clock as America/Jamaica.
 */
const GOJEP_DATE_REGEX =
  /^[A-Za-z]+\s+(?<mon>[A-Za-z]+)\s+(?<day>\d{1,2})\s+(?<h>\d{1,2}):(?<m>\d{1,2}):(?<s>\d{1,2})\s+\w+\s+(?<year>\d{4})\s*$/;
const MONTH_INDEX: Record<string, number> = {
  Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6,
  Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12,
};

function parseGojepDate(input: string | undefined): Date | undefined {
  if (!input) return undefined;
  const m = input.trim().match(GOJEP_DATE_REGEX);
  if (!m?.groups) return undefined;
  const month = MONTH_INDEX[m.groups['mon']!];
  if (!month) return undefined;
  const iso = `${m.groups['year']}-${String(month).padStart(2, '0')}-${m.groups['day']!.padStart(2, '0')}T${m.groups['h']!.padStart(2, '0')}:${m.groups['m']!.padStart(2, '0')}:${m.groups['s']!.padStart(2, '0')}`;
  try {
    return fromZonedTime(iso, 'America/Jamaica');
  } catch {
    return undefined;
  }
}

/**
 * Award value cells are scientific notation strings like "1.0759032E7".
 * Parse to JMD numeric.
 */
function parseAwardedValue(input: string | undefined): number | undefined {
  if (!input) return undefined;
  const cleaned = input.trim().replace(/,/g, '');
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export class JamaicaGojepScraper extends TenderScraper {
  readonly jurisdictionSlug = 'jamaica';
  readonly sourceName = 'jamaica-gojep';
  readonly portalUrl = PORTAL;

  constructor(private readonly input: ScraperInput = {}) {
    super();
  }

  async fetch(): Promise<RawOpportunity[]> {
    // Fixture path — single page each surface, used by tests.
    if (this.input.fixtureHtml) {
      const out: RawOpportunity[] = [];
      if (this.input.fixtureHtml.listing) {
        out.push(...this.parseOpenedTenders(this.input.fixtureHtml.listing));
      }
      if (this.input.fixtureHtml.awards) {
        out.push(...this.parseAwardNotices(this.input.fixtureHtml.awards));
      }
      return out;
    }

    // Live path — paginate both surfaces. Award Notices last so the
    // awarded value upserts on top of the opened-tender row when both
    // surfaces describe the same resourceId.
    const out: RawOpportunity[] = [];

    const openedPages = this.input.maxOpenedPages ?? 10;
    for (let p = 1; p <= openedPages; p += 1) {
      const html = await this.fetchPage(OPENED_PATH, OPENED_TABLE_ID, p);
      const rows = this.parseOpenedTenders(html);
      if (rows.length === 0) break;
      out.push(...rows);
    }

    const awardPages = this.input.maxAwardPages ?? 10;
    for (let p = 1; p <= awardPages; p += 1) {
      const html = await this.fetchPage(AWARDS_PATH, AWARDS_TABLE_ID, p);
      const rows = this.parseAwardNotices(html);
      if (rows.length === 0) break;
      out.push(...rows);
    }

    return out;
  }

  async parse(raw: RawOpportunity): Promise<NormalizedOpportunity | null> {
    const d = raw.rawData as unknown as JamaicaRawData;
    if (!d.title) return null;

    const closingDate = parseGojepDate(d.closingDateText);
    const awardDate = parseGojepDate(d.awardDateText);
    const value = parseAwardedValue(d.awardedValue);
    const isAward = d.surface === 'award-notices';

    const documents = d.awardNoticePdfUrl
      ? [
          {
            documentType: 'tender_document',
            title: 'Contract Award Notice',
            originalUrl: `${PORTAL}${d.awardNoticePdfUrl}`,
          },
        ]
      : undefined;

    return {
      sourceReferenceId: raw.sourceReferenceId,
      sourceUrl: raw.sourceUrl,
      title: d.title.slice(0, 500),
      description: d.title,
      referenceNumber: d.referenceNumber,
      agencyName: d.agency,
      category: classifyVtcCategory(d.title) ?? undefined,
      currency: 'JMD',
      // For award-notice rows, valueEstimate is the awarded value
      // (no separate budget estimate is published). Same number lands
      // in awardedAmount below, so downstream surfaces that only look
      // at valueEstimate still render. Open tenders fall through here
      // with valueEstimate undefined since GOJEP doesn't publish budgets.
      valueEstimate: value,
      // Use the award date as the deadline for past-awards rows so
      // recency sorting works. Falls back to closingDate (the bid
      // submission deadline) for opened-tender rows.
      deadlineAt: closingDate ?? awardDate ?? undefined,
      deadlineTimezone: 'America/Jamaica',
      language: 'en',
      // Surface-driven lifecycle. Award-notice surface always means the
      // contract is awarded — this is the durable signal Discover's
      // past-awards query keys off, even when parseGojepDate fails on
      // an edge-case format and awardDate ends up undefined.
      status: isAward ? 'awarded' : 'active',
      awardedAt: isAward ? awardDate : undefined,
      awardedAmount: isAward ? value : undefined,
      rawContent: d as unknown as Record<string, unknown>,
      documents,
    };
  }

  private async fetchPage(path: string, tableId: string, page: number): Promise<string> {
    const url = page === 1
      ? `${PORTAL}${path}`
      : `${PORTAL}${path}?d-${tableId}-p=${page}`;
    const res = await fetchWithRetry(url);
    return res.text();
  }

  /**
   * Opened Tenders surface — 9 cells per row:
   *   [0] index, [1] title-link, [2] reference, [3] agency,
   *   [4] closing-date, [5] procurement method, [6] view-bids link,
   *   [7] empty, [8] evaluation status.
   */
  private parseOpenedTenders(html: string): RawOpportunity[] {
    const $ = loadHtml(html);
    const out: RawOpportunity[] = [];

    $('tr').each((_i, el) => {
      const $tr = $(el);
      const $detailLink = $tr.find('a[href*="prepareViewCfTWS.do"]').first();
      const href = $detailLink.attr('href');
      if (!href) return;

      const resourceMatch = href.match(DETAIL_HREF_REGEX);
      if (!resourceMatch?.[1]) return;
      const resourceId = resourceMatch[1];

      const $cells = $tr.find('td');
      if ($cells.length < 9) return;

      const title = textOf($detailLink);
      if (!title) return;

      const data: JamaicaRawData = {
        surface: 'opened-tenders',
        resourceId,
        title,
        referenceNumber: textOf($cells.eq(2)),
        agency: textOf($cells.eq(3)),
        closingDateText: textOf($cells.eq(4)),
        method: textOf($cells.eq(5)),
        evaluationStatus: textOf($cells.eq(8)),
        detailUrl: `${PORTAL}/epps/cft/prepareViewCfTWS.do?resourceId=${resourceId}`,
      };

      out.push({
        sourceReferenceId: `GOJEP-${resourceId}`,
        sourceUrl: data.detailUrl,
        rawData: data as unknown as Record<string, unknown>,
      });
    });

    return out;
  }

  /**
   * Award Notices surface — 7 cells per row:
   *   [0] index, [1] procedure type, [2] agency, [3] title-link to
   *   the original tender, [4] awarded value (scientific notation
   *   like "1.0759032E7"), [5] award date, [6] PDF link to the
   *   contract-award notice (downloadNoticeForES.do).
   *
   * The title-link in cell[3] uses the same resourceId pattern as
   * Opened Tenders, so we share `GOJEP-<resourceId>` ids and let the
   * upsert layer dedupe + enrich.
   */
  private parseAwardNotices(html: string): RawOpportunity[] {
    const $ = loadHtml(html);
    const out: RawOpportunity[] = [];

    $('tr').each((_i, el) => {
      const $tr = $(el);
      const $titleLink = $tr.find('a[href*="prepareViewCfTWS.do"]').first();
      const href = $titleLink.attr('href');
      if (!href) return;

      const resourceMatch = href.match(DETAIL_HREF_REGEX);
      if (!resourceMatch?.[1]) return;
      const resourceId = resourceMatch[1];

      const $cells = $tr.find('td');
      if ($cells.length < 7) return;

      const title = textOf($titleLink);
      if (!title) return;

      const $pdfLink = $tr.find('a[href*="downloadNoticeForES.do"]').first();
      const pdfHref = $pdfLink.attr('href');
      const pdfMatch = pdfHref?.match(PDF_HREF_REGEX);

      const data: JamaicaRawData = {
        surface: 'award-notices',
        resourceId,
        title,
        // award-notice rows put the procedure type in cell[1] (e.g.
        // "Emergency Procedure"); reference number isn't shown. Using
        // a stable derived value so downstream views always have a
        // ref to render.
        referenceNumber: `GOJEP-AWARD-${resourceId}`,
        agency: textOf($cells.eq(2)),
        method: textOf($cells.eq(1)),
        awardedValue: textOf($cells.eq(4)),
        awardDateText: textOf($cells.eq(5)),
        awardNoticePdfUrl: pdfHref ?? undefined,
        detailUrl: `${PORTAL}/epps/cft/prepareViewCfTWS.do?resourceId=${resourceId}`,
      };

      out.push({
        sourceReferenceId: `GOJEP-${resourceId}`,
        sourceUrl: data.detailUrl,
        rawData: data as unknown as Record<string, unknown>,
      });
      // Suppress unused-var lint on pdfMatch; kept for future enrichment.
      void pdfMatch;
    });

    return out;
  }
}
