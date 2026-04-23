/**
 * Jamaica — Government of Jamaica Electronic Procurement (GOJEP).
 *
 * Portal:       https://www.gojep.gov.jm
 * Platform:     European Dynamics e-PPS (Struts 1.x, Java)
 * Listing URL:  /epps/cft/listContracts.do
 * Detail URL:   /epps/cft/viewCurrentNotice.do?noticeId={id}
 *
 * Strategy: fetch the public "Current competitions" listing page,
 * parse each tender row out of the results table, then fetch each
 * detail page for full metadata. e-PPS returns server-rendered HTML;
 * no Playwright needed.
 *
 * Selector notes (validate against a live fetch before first prod run):
 *  - Listings: table.table_gridviewer > tbody > tr[id^="rowId"]
 *  - Columns:  td.td_upper_table
 *  - Detail link: td a[href*="viewCurrentNotice.do"]
 *  - Reference: first td text
 *  - Title:     td.td_upper_table a (second column)
 *  - Agency:    td.td_upper_table (third column)
 *  - Published: td.td_upper_table (fourth column, date)
 *  - Closing:   td.td_upper_table (fifth column, date)
 *  - Value:     not shown in list; extract from detail page.
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

const PORTAL = 'https://www.gojep.gov.jm';
const LISTING_PATH = '/epps/cft/listContracts.do';

export type JamaicaRawData = {
  referenceNumber: string;
  title: string;
  agency: string;
  publishedText: string;
  deadlineText: string;
  detailUrl: string;
  valueText?: string;
  descriptionHtml?: string;
  type?: string;
  documents?: Array<{ title: string; url: string }>;
};

type ScraperInput = {
  /** Skip the network fetch and parse this HTML instead. Used by tests. */
  fixtureHtml?: {
    listing?: string;
    details?: Record<string, string>;
  };
  /** Max detail pages to fetch in one run. Default: 200. */
  maxDetails?: number;
};

export class JamaicaGojepScraper extends TenderScraper {
  readonly jurisdictionSlug = 'jamaica';
  readonly sourceName = 'jamaica-gojep';
  readonly portalUrl = PORTAL;

  constructor(private readonly input: ScraperInput = {}) {
    super();
  }

  async fetch(): Promise<RawOpportunity[]> {
    const listingHtml = this.input.fixtureHtml?.listing ?? (await this.fetchListing());
    const rows = this.parseListingRows(listingHtml);

    const limit = this.input.maxDetails ?? 200;
    const results: RawOpportunity[] = [];
    for (const row of rows.slice(0, limit)) {
      const detailHtml =
        this.input.fixtureHtml?.details?.[row.detailUrl] ?? (await this.fetchDetail(row.detailUrl));
      const detail = this.parseDetail(detailHtml, row);

      results.push({
        sourceReferenceId: detail.referenceNumber,
        sourceUrl: row.detailUrl,
        rawData: detail as unknown as Record<string, unknown>,
      });
    }
    return results;
  }

  async parse(raw: RawOpportunity): Promise<NormalizedOpportunity | null> {
    const d = raw.rawData as unknown as JamaicaRawData;
    if (!d.title || !d.referenceNumber) return null;

    const valueEstimate = d.valueText ? this.parseJmd(d.valueText) : undefined;

    return {
      sourceReferenceId: d.referenceNumber,
      sourceUrl: raw.sourceUrl,
      title: d.title,
      description: d.descriptionHtml?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
      referenceNumber: d.referenceNumber,
      type: d.type,
      agencyName: d.agency,
      currency: 'JMD',
      valueEstimate,
      publishedAt: parseTenderDate(d.publishedText, 'America/Jamaica') ?? undefined,
      deadlineAt: parseTenderDate(d.deadlineText, 'America/Jamaica') ?? undefined,
      deadlineTimezone: 'America/Jamaica',
      language: 'en',
      rawContent: d as unknown as Record<string, unknown>,
      documents: d.documents?.map((doc) => ({
        documentType: 'tender_document',
        title: doc.title,
        originalUrl: absoluteUrl(doc.url, PORTAL) ?? doc.url,
      })),
    };
  }

  private async fetchListing(): Promise<string> {
    const res = await fetchWithRetry(`${PORTAL}${LISTING_PATH}`);
    return res.text();
  }

  private async fetchDetail(url: string): Promise<string> {
    const res = await fetchWithRetry(url);
    return res.text();
  }

  private parseListingRows(html: string): JamaicaRawData[] {
    const $ = loadHtml(html);
    const rows: JamaicaRawData[] = [];

    $('table.table_gridviewer tr[id^="rowId"], table.results tr.tableRow').each((_i, el) => {
      const $row = $(el);
      const $cells = $row.find('td');
      if ($cells.length < 4) return;

      const referenceNumber = textOf($cells.eq(0));
      const $titleLink = $cells.eq(1).find('a').first();
      const title = textOf($titleLink);
      const relHref = $titleLink.attr('href') ?? '';
      const detailUrl = absoluteUrl(relHref, PORTAL) ?? relHref;
      const agency = textOf($cells.eq(2));
      const publishedText = textOf($cells.eq(3));
      const deadlineText = textOf($cells.eq(4));

      if (!referenceNumber || !title || !detailUrl) return;

      rows.push({
        referenceNumber,
        title,
        agency,
        publishedText,
        deadlineText,
        detailUrl,
      });
    });

    return rows;
  }

  private parseDetail(html: string, row: JamaicaRawData): JamaicaRawData {
    const $ = loadHtml(html);

    // e-PPS detail pages use a labelled two-column layout
    // where each row is <tr><td>Label</td><td>Value</td></tr>.
    const fields: Record<string, string> = {};
    $('table.table_details tr, table.detailsTable tr').each((_i, el) => {
      const $cells = $(el).find('td');
      if ($cells.length !== 2) return;
      const label = textOf($cells.eq(0)).replace(/:$/, '').toLowerCase();
      const value = textOf($cells.eq(1));
      if (label) fields[label] = value;
    });

    const documents: Array<{ title: string; url: string }> = [];
    $('a[href*=".pdf"], a[href*="viewAttachmentAction.do"]').each((_i, el) => {
      const $a = $(el);
      const title = textOf($a);
      const href = $a.attr('href');
      if (href && title) documents.push({ title, url: href });
    });

    return {
      ...row,
      valueText: fields['estimated value'] ?? fields['contract value'] ?? fields['value'],
      type: fields['procedure type'] ?? fields['type'] ?? row.type,
      descriptionHtml:
        $('div.description, div#descriptionBlock, td.description').first().html() ?? undefined,
      documents: documents.length > 0 ? documents : undefined,
    };
  }

  private parseJmd(value: string): number | undefined {
    const cleaned = value.replace(/[^0-9.,]/g, '').replace(/,/g, '');
    const n = Number.parseFloat(cleaned);
    return Number.isFinite(n) ? n : undefined;
  }
}
