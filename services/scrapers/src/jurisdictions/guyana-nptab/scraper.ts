/**
 * Guyana — National Procurement and Tender Administration (NPTA).
 *
 * Portal:       https://npta.gov.gy
 * Platform:     WordPress + Ninja Tables plugin (Procurement Opportunities table)
 * Listing URL:  /procurement-opportunities/
 *
 * NPTA publishes every active and recent tender as a row in a single
 * Ninja Tables instance. Six columns: title, procuring entity,
 * bids-submission deadline, procurement method (NCB/ICB/Open), status
 * (Published/Closed/etc.), and a "Notice" cell containing the PDF
 * advert link.
 *
 * The detail document is the linked PDF — there's no per-tender HTML
 * detail page to fetch. We stop at the listing row and let the AI
 * pipeline pull the PDF for full extraction.
 *
 * Selector notes:
 *  - Each row: tr.ninja_table_row_N (data-row_id is the stable id)
 *  - Six <td>s in column order — see comment block in parseListingRow.
 *  - PDF link: cell[5] > a[href$=".pdf"]
 *
 * History note: the prior implementation pointed at nptab.gov.gy
 * (which doesn't resolve) and assumed a WordPress blog-post layout.
 * That domain typo + structural mismatch is why Trigger.dev cron
 * runs were silently 0-row before this rewrite.
 */
import {
  TenderScraper,
  absoluteUrl,
  fetchWithRetry,
  loadHtml,
  parseTenderDate,
  textOf,
  type NormalizedOpportunity,
  type RawOpportunity,
} from '@procur/scrapers-core';

const PORTAL = 'https://npta.gov.gy';
const LISTING_PATH = '/procurement-opportunities/';

export type GuyanaRawData = {
  rowId: string;
  title: string;
  agency: string;
  deadlineText: string;
  method: string;
  status: string;
  pdfUrl?: string;
  pdfTitle?: string;
};

type ScraperInput = {
  fixtureHtml?: { listing?: string };
  /** Cap rows ingested per run; 0 = no cap. Default 500 — generous since
   *  the listing typically holds ~250 active rows. */
  maxRows?: number;
};

const REFERENCE_REGEX = /\b([A-Z]{2,8}[-/][A-Z0-9-]{3,30})\b/;
const VALUE_REGEX = /(?:G\$|GYD|GY\$|EE\$-)\s*([\d,]+(?:\.\d+)?)/;

export class GuyanaNptabScraper extends TenderScraper {
  readonly jurisdictionSlug = 'guyana';
  readonly sourceName = 'guyana-npta';
  readonly portalUrl = PORTAL;

  constructor(private readonly input: ScraperInput = {}) {
    super();
  }

  async fetch(): Promise<RawOpportunity[]> {
    const html = this.input.fixtureHtml?.listing ?? (await this.fetchListing());
    return this.parseListing(html);
  }

  async parse(raw: RawOpportunity): Promise<NormalizedOpportunity | null> {
    const d = raw.rawData as unknown as GuyanaRawData;
    if (!d.title) return null;

    const valueMatch = d.title.match(VALUE_REGEX);
    const value = valueMatch?.[1] ? this.parseGyd(valueMatch[1]) : undefined;

    const referenceFromPdf = d.pdfUrl
      ? this.deriveReferenceFromPdf(d.pdfUrl)
      : undefined;
    const referenceFromTitle = d.title.match(REFERENCE_REGEX)?.[1];
    const referenceNumber = referenceFromPdf ?? referenceFromTitle;

    const documents = d.pdfUrl
      ? [
          {
            documentType: 'tender_document',
            title: d.pdfTitle ?? 'Notice of Bid',
            originalUrl: absoluteUrl(d.pdfUrl, PORTAL) ?? d.pdfUrl,
          },
        ]
      : undefined;

    return {
      sourceReferenceId: raw.sourceReferenceId,
      sourceUrl: raw.sourceUrl,
      title: d.title.slice(0, 500),
      description: d.title,
      referenceNumber,
      agencyName: d.agency,
      currency: 'GYD',
      valueEstimate: value,
      deadlineAt: parseTenderDate(d.deadlineText, 'America/Guyana') ?? undefined,
      deadlineTimezone: 'America/Guyana',
      language: 'en',
      rawContent: d as unknown as Record<string, unknown>,
      documents,
    };
  }

  private async fetchListing(): Promise<string> {
    const res = await fetchWithRetry(`${PORTAL}${LISTING_PATH}`);
    return res.text();
  }

  /**
   * Each row of the Ninja Tables instance becomes one RawOpportunity.
   * Cell order on the live portal (validated 2026-04-25):
   *   [0] Title — free text, sometimes packs multiple sub-projects with
   *       per-line G$ values; we keep the full cell text and let
   *       downstream AI tease apart sub-tenders.
   *   [1] Procuring Entity — multi-line agency name.
   *   [2] Bids Submission Deadline — date string, format varies
   *       (e.g. "02/19/26", "12/23/25 12:0:0", " ").
   *   [3] Procurement Method — NCB / ICB / Open Tender / RFQ.
   *   [4] Status — Published / Closed / etc. We surface all and let
   *       upserts mark already-closed rows with status.
   *   [5] Notice — anchor with the PDF advert; required for usefulness.
   */
  private parseListing(html: string): RawOpportunity[] {
    const $ = loadHtml(html);
    const limit = this.input.maxRows ?? 500;
    const out: RawOpportunity[] = [];

    $('tr[class*="nt_row_id_"]').each((_i, el) => {
      if (limit > 0 && out.length >= limit) return false;
      const $tr = $(el);
      const rowId = ($tr.attr('class') ?? '').match(/nt_row_id_(\d+)/)?.[1];
      if (!rowId) return;

      const $cells = $tr.find('td');
      if ($cells.length < 6) return;

      const title = textOf($cells.eq(0));
      const agency = textOf($cells.eq(1));
      const deadlineText = textOf($cells.eq(2));
      const method = textOf($cells.eq(3));
      const status = textOf($cells.eq(4));
      const $pdfLink = $cells.eq(5).find('a[href$=".pdf"], a[href*=".pdf"]').first();
      const pdfUrl = $pdfLink.attr('href');
      const pdfTitle = $pdfLink.attr('title') ?? textOf($pdfLink) ?? undefined;

      if (!title) return;

      const data: GuyanaRawData = {
        rowId,
        title,
        agency,
        deadlineText,
        method,
        status,
        pdfUrl: pdfUrl ?? undefined,
        pdfTitle: pdfTitle && pdfTitle.length > 0 ? pdfTitle : undefined,
      };

      out.push({
        sourceReferenceId: `NPTA-${rowId}`,
        sourceUrl: `${PORTAL}${LISTING_PATH}#row-${rowId}`,
        rawData: data as unknown as Record<string, unknown>,
      });
      return;
    });

    return out;
  }

  private deriveReferenceFromPdf(pdfUrl: string): string | undefined {
    const filename = pdfUrl.split('/').pop()?.replace(/\.pdf$/i, '');
    if (!filename) return undefined;
    return filename.replace(/[^A-Za-z0-9-]+/g, '-').slice(0, 80);
  }

  private parseGyd(value: string): number | undefined {
    const cleaned = value.replace(/[^0-9.]/g, '');
    const n = Number.parseFloat(cleaned);
    return Number.isFinite(n) ? n : undefined;
  }
}
