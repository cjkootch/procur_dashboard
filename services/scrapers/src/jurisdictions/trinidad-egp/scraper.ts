/**
 * Trinidad & Tobago — eGP.
 *
 * Portal:   https://egp.gov.tt
 * Platform: modern JavaScript SPA; listing content is client-rendered.
 *
 * We use a pluggable PageFetcher so the scraper is testable:
 *  - Prod: PlaywrightFetcher (Chromium headless, waits for network-idle)
 *  - Tests: FixturePageFetcher (pre-resolved HTML in memory)
 *
 * Selector notes (validate against live fetch):
 *  - Listing rows: [data-testid="tender-row"], tr.tender-row
 *  - Title link:  [data-testid="tender-title"] a
 *  - Detail sections: [data-testid="tender-field"][data-label="..."]
 */
import {
  TenderScraper,
  absoluteUrl,
  loadHtml,
  parseTenderDate,
  parseMoney,
  textOf,
  type NormalizedOpportunity,
  type RawOpportunity,
} from '@procur/scrapers-core';

const PORTAL = 'https://egp.gov.tt';
const LISTING_PATH = '/public/notices';

export type TrinidadRawData = {
  referenceNumber: string;
  title: string;
  agency?: string;
  type?: string;
  detailUrl: string;
  publishedText?: string;
  deadlineText?: string;
  valueText?: string;
  description?: string;
  documents?: Array<{ title: string; url: string }>;
};

export interface PageFetcher {
  /** Navigate to url, wait for it to settle, return fully-rendered HTML. */
  fetchRendered(url: string): Promise<string>;
}

type ScraperInput = {
  fetcher?: PageFetcher;
  maxDetails?: number;
};

export class TrinidadEgpScraper extends TenderScraper {
  readonly jurisdictionSlug = 'trinidad-and-tobago';
  readonly sourceName = 'trinidad-egp';
  readonly portalUrl = PORTAL;

  constructor(private readonly input: ScraperInput = {}) {
    super();
  }

  async fetch(): Promise<RawOpportunity[]> {
    const fetcher = this.input.fetcher ?? (await this.defaultFetcher());
    const listingHtml = await fetcher.fetchRendered(`${PORTAL}${LISTING_PATH}`);
    const rows = this.parseListing(listingHtml);

    const limit = this.input.maxDetails ?? 100;
    const results: RawOpportunity[] = [];

    for (const row of rows.slice(0, limit)) {
      const detailHtml = await fetcher.fetchRendered(row.detailUrl);
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
    const d = raw.rawData as unknown as TrinidadRawData;
    if (!d.title || !d.referenceNumber) return null;

    const value = d.valueText ? parseMoney(d.valueText) : null;

    return {
      sourceReferenceId: d.referenceNumber,
      sourceUrl: raw.sourceUrl,
      title: d.title,
      description: d.description,
      referenceNumber: d.referenceNumber,
      type: d.type,
      agencyName: d.agency,
      currency: 'TTD',
      valueEstimate: value ?? undefined,
      publishedAt: parseTenderDate(d.publishedText, 'America/Port_of_Spain') ?? undefined,
      deadlineAt: parseTenderDate(d.deadlineText, 'America/Port_of_Spain') ?? undefined,
      deadlineTimezone: 'America/Port_of_Spain',
      language: 'en',
      rawContent: d as unknown as Record<string, unknown>,
      documents: d.documents?.map((doc) => ({
        documentType: 'tender_document',
        title: doc.title,
        originalUrl: absoluteUrl(doc.url, PORTAL) ?? doc.url,
      })),
    };
  }

  private parseListing(html: string): TrinidadRawData[] {
    const $ = loadHtml(html);
    const rows: TrinidadRawData[] = [];

    $('[data-testid="tender-row"], tr.tender-row').each((_i, el) => {
      const $row = $(el);
      const $titleLink = $row
        .find('[data-testid="tender-title"] a, a.tender-title-link')
        .first();
      const title = textOf($titleLink);
      const relHref = $titleLink.attr('href') ?? '';
      const detailUrl = absoluteUrl(relHref, PORTAL) ?? relHref;
      const referenceNumber = textOf($row.find('[data-field="reference"], .reference').first());
      const agency = textOf($row.find('[data-field="agency"], .agency').first());
      const deadlineText = textOf($row.find('[data-field="closing-date"], .closing-date').first());

      if (!title || !detailUrl || !referenceNumber) return;

      rows.push({ referenceNumber, title, agency, deadlineText, detailUrl });
    });

    return rows;
  }

  private parseDetail(html: string, row: TrinidadRawData): TrinidadRawData {
    const $ = loadHtml(html);
    const getField = (label: string): string | undefined => {
      const byData = textOf($(`[data-testid="tender-field"][data-label="${label}"]`).first());
      if (byData) return byData;
      // Fallback: dt/dd or label/value pairs
      const $dt = $(`dt:contains("${label}")`).first();
      if ($dt.length > 0) return textOf($dt.next('dd'));
      return undefined;
    };

    const documents: Array<{ title: string; url: string }> = [];
    $('a[href$=".pdf"], a[data-testid="document-link"]').each((_i, el) => {
      const $a = $(el);
      const title = textOf($a) || 'Attachment';
      const href = $a.attr('href');
      if (href) documents.push({ title, url: href });
    });

    return {
      ...row,
      type: getField('Procurement Method') ?? getField('Type') ?? row.type,
      agency: getField('Procuring Entity') ?? row.agency,
      publishedText: getField('Published') ?? getField('Date Published'),
      deadlineText: getField('Closing Date') ?? getField('Submission Deadline') ?? row.deadlineText,
      valueText: getField('Estimated Value') ?? getField('Budget'),
      description: textOf($('[data-testid="tender-description"], .tender-description').first()),
      documents: documents.length > 0 ? documents : undefined,
    };
  }

  private async defaultFetcher(): Promise<PageFetcher> {
    const { PlaywrightFetcher } = await import('./playwright-fetcher');
    return new PlaywrightFetcher();
  }
}
