/**
 * Jamaica — Government of Jamaica Electronic Procurement (GOJEP).
 *
 * Portal:       https://www.gojep.gov.jm
 * Platform:     European Dynamics e-PPS (Struts 1.x, Java)
 * Listing URL:  /epps/common/viewOpenedTenders.do
 * Detail URL:   /epps/cft/prepareViewCfTWS.do?resourceId={id}
 *
 * Status note: GOJEP has two listing surfaces:
 *   1. "Current Competitions" — what bidders look at, but it's gated
 *      behind a CAPTCHA + search form. Not programmatically accessible
 *      without auth + CAPTCHA-solving infra (which would breach ToS).
 *   2. "Opened Tenders" — public, no CAPTCHA, no auth. These are
 *      tenders whose bid-submission deadline has passed and bids have
 *      been opened. They're "historical" from a bidder's POV but rich
 *      market-intelligence data: title, agency, reference, deadline,
 *      procurement method, evaluation status.
 *
 * This scraper consumes the public surface only. The data is past the
 * close date; downstream UI should label these as `closed` so users
 * understand they're for market-intel / past-performance / proposal-
 * library purposes, not active bidding.
 *
 * Selector notes (validated 2026-04-25 against a live fetch):
 *   - Listing rows: every <tr> on the page that contains an
 *     <a href="/epps/cft/prepareViewCfTWS.do?resourceId=N"> in cell[1].
 *   - 9 cells per row:
 *       [0] index, [1] title-link, [2] reference, [3] agency,
 *       [4] closing-date (e.g. "Fri Apr 24 13:00:00 COT 2026"),
 *       [5] procurement method, [6] view-bids link, [7] empty,
 *       [8] evaluation status.
 *
 * The portal renders 10 rows per request — each scheduled run picks up
 * the most recent 10. Downstream upserts dedupe by sourceReferenceId
 * (`GOJEP-<resourceId>`), so re-running without pagination is safe and
 * incremental: new tenders appear on top of the listing as they close.
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
} from '@procur/scrapers-core';
import { fromZonedTime } from 'date-fns-tz';

const PORTAL = 'https://www.gojep.gov.jm';
const LISTING_PATH = '/epps/common/viewOpenedTenders.do';

export type JamaicaRawData = {
  resourceId: string;
  title: string;
  referenceNumber: string;
  agency: string;
  closingDateText: string;
  method: string;
  evaluationStatus: string;
  detailUrl: string;
};

type ScraperInput = {
  fixtureHtml?: { listing?: string };
  /** Cap rows ingested per run; 0 = no cap. Default 100 — well above
   *  the 10/page the portal returns, so paginated extension is a future
   *  enhancement without breaking existing callers. */
  maxRows?: number;
};

const DETAIL_HREF_REGEX = /\/epps\/cft\/prepareViewCfTWS\.do\?resourceId=(\d+)/;

/**
 * GOJEP serves dates in Java's default Date.toString() format:
 *   "Fri Apr 24 13:00:00 COT 2026"
 * The COT timezone abbreviation is whatever the JVM is running in
 * (Cuba/Colombia time — both UTC-5 like Jamaica). We strip the
 * abbreviation and treat the wall-clock as America/Jamaica.
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

export class JamaicaGojepScraper extends TenderScraper {
  readonly jurisdictionSlug = 'jamaica';
  readonly sourceName = 'jamaica-gojep';
  readonly portalUrl = PORTAL;

  constructor(private readonly input: ScraperInput = {}) {
    super();
  }

  async fetch(): Promise<RawOpportunity[]> {
    const html = this.input.fixtureHtml?.listing ?? (await this.fetchListing());
    return this.parseListing(html);
  }

  async parse(raw: RawOpportunity): Promise<NormalizedOpportunity | null> {
    const d = raw.rawData as unknown as JamaicaRawData;
    if (!d.title) return null;

    const deadline = parseGojepDate(d.closingDateText);

    return {
      sourceReferenceId: raw.sourceReferenceId,
      sourceUrl: raw.sourceUrl,
      title: d.title.slice(0, 500),
      description: d.title,
      referenceNumber: d.referenceNumber,
      agencyName: d.agency,
      currency: 'JMD',
      deadlineAt: deadline ?? undefined,
      deadlineTimezone: 'America/Jamaica',
      language: 'en',
      rawContent: d as unknown as Record<string, unknown>,
    };
  }

  private async fetchListing(): Promise<string> {
    const res = await fetchWithRetry(`${PORTAL}${LISTING_PATH}`);
    return res.text();
  }

  /**
   * Walk every <tr> on the page; keep only ones whose first anchor
   * matches the prepareViewCfTWS detail-link pattern. That single
   * heuristic discriminates listing rows from layout/header noise
   * better than relying on a table class (the portal doesn't put one
   * on the listing table).
   */
  private parseListing(html: string): RawOpportunity[] {
    const $ = loadHtml(html);
    const limit = this.input.maxRows ?? 100;
    const out: RawOpportunity[] = [];

    $('tr').each((_i, el) => {
      if (limit > 0 && out.length >= limit) return false;

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
      const referenceNumber = textOf($cells.eq(2));
      const agency = textOf($cells.eq(3));
      const closingDateText = textOf($cells.eq(4));
      const method = textOf($cells.eq(5));
      const evaluationStatus = textOf($cells.eq(8));

      if (!title || !resourceId) return;

      const detailUrl = `${PORTAL}/epps/cft/prepareViewCfTWS.do?resourceId=${resourceId}`;

      const data: JamaicaRawData = {
        resourceId,
        title,
        referenceNumber,
        agency,
        closingDateText,
        method,
        evaluationStatus,
        detailUrl,
      };

      out.push({
        sourceReferenceId: `GOJEP-${resourceId}`,
        sourceUrl: detailUrl,
        rawData: data as unknown as Record<string, unknown>,
      });
      return;
    });

    return out;
  }
}
