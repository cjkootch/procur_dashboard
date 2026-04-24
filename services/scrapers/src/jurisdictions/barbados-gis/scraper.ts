/**
 * Barbados — Government Information Service procurement notices.
 *
 * Portal:       https://gisbarbados.gov.bb
 * Procurement:  Notices appear under /category/notices/ and
 *               /category/tenders/. Some are also cross-posted to
 *               https://bppd.gov.bb (Barbados Public Procurement Dept).
 *
 * Status: ⚠ scaffolded — selectors below are conservative and based on
 * the WordPress patterns shared with Guyana NPTAB, but have not been
 * validated against a live fetch. The seed entry ships with
 * active=false; flip it on after running:
 *
 *   pnpm --filter @procur/scrapers cli scrape barbados
 *
 * against the live portal, comparing the count of returned rows with
 * the visible listing, and tightening selectors as needed.
 *
 * Defaults to currency BBD; the value parser also recognizes USD and
 * XCD (Eastern Caribbean Dollar — used in some regional procurements).
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

const PORTAL = 'https://gisbarbados.gov.bb';
const LISTING_PATHS = ['/category/notices/', '/category/tenders/'];

export type BarbadosRawData = {
  title: string;
  detailUrl: string;
  publishedText?: string;
  bodyText: string;
  bodyHtml: string;
  agencyGuess?: string;
  deadlineText?: string;
  valueText?: string;
  currencyHint?: 'BBD' | 'USD' | 'XCD';
  referenceHint?: string;
  documents?: Array<{ title: string; url: string }>;
};

type ScraperInput = {
  fixtureHtml?: {
    listings?: Record<string, string>;
    posts?: Record<string, string>;
  };
  maxPosts?: number;
};

const DEADLINE_REGEX =
  /(?:closing|deadline|tenders?\s+close|bids\s+(?:must\s+be\s+(?:received|submitted)|due))[^\n]{0,80}?([0-9]{1,2}[\s\-/.][A-Za-z0-9]{2,9}[\s\-/.][0-9]{2,4})/i;

const VALUE_REGEX = /(BDS\$|BBD|US\$|USD|EC\$|XCD)\s*([\d,]+(?:\.\d+)?)/i;

const AGENCY_REGEX =
  /(?:Ministry of [A-Z][A-Za-z& ,]+|Barbados [A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,3}|Department of [A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,3})/;

const REFERENCE_REGEX =
  /\b([A-Z]{2,8}(?:[-/][A-Z0-9]{1,8}){2,4})\b/;

export class BarbadosGisScraper extends TenderScraper {
  readonly jurisdictionSlug = 'barbados';
  readonly sourceName = 'barbados-gis';
  readonly portalUrl = PORTAL;

  constructor(private readonly input: ScraperInput = {}) {
    super();
  }

  async fetch(): Promise<RawOpportunity[]> {
    const postUrls = new Set<string>();

    for (const path of LISTING_PATHS) {
      const html = this.input.fixtureHtml?.listings?.[path] ?? (await this.fetchPath(path));
      for (const url of this.parseListing(html)) postUrls.add(url);
    }

    const limit = this.input.maxPosts ?? 50;
    const results: RawOpportunity[] = [];

    for (const url of Array.from(postUrls).slice(0, limit)) {
      const html =
        this.input.fixtureHtml?.posts?.[url] ?? (await this.fetchPath(new URL(url).pathname));
      const raw = this.parsePost(html, url);
      if (!raw) continue;

      const referenceId = raw.referenceHint ?? this.derivedReferenceId(url);
      results.push({
        sourceReferenceId: referenceId,
        sourceUrl: url,
        rawData: raw as unknown as Record<string, unknown>,
      });
    }

    return results;
  }

  async parse(raw: RawOpportunity): Promise<NormalizedOpportunity | null> {
    const d = raw.rawData as unknown as BarbadosRawData;
    if (!d.title) return null;

    const valueMatch = d.valueText ?? d.bodyText.match(VALUE_REGEX)?.[0];
    const value = valueMatch ? this.parseValue(valueMatch) : undefined;
    const currency = d.currencyHint ?? this.detectCurrency(valueMatch) ?? 'BBD';

    return {
      sourceReferenceId: raw.sourceReferenceId,
      sourceUrl: raw.sourceUrl,
      title: d.title,
      description: d.bodyText.slice(0, 2000),
      referenceNumber: d.referenceHint,
      agencyName: d.agencyGuess,
      currency,
      valueEstimate: value,
      publishedAt: parseTenderDate(d.publishedText, 'America/Barbados') ?? undefined,
      deadlineAt: parseTenderDate(d.deadlineText, 'America/Barbados') ?? undefined,
      deadlineTimezone: 'America/Barbados',
      language: 'en',
      rawContent: d as unknown as Record<string, unknown>,
      documents: d.documents?.map((doc) => ({
        documentType: 'tender_document',
        title: doc.title,
        originalUrl: absoluteUrl(doc.url, PORTAL) ?? doc.url,
      })),
    };
  }

  private async fetchPath(path: string): Promise<string> {
    const res = await fetchWithRetry(`${PORTAL}${path}`);
    return res.text();
  }

  private parseListing(html: string): string[] {
    const $ = loadHtml(html);
    const urls = new Set<string>();

    // WordPress-style article archive — each post in <article> with a
    // permalink in h2.entry-title > a. Falls back to .post a.
    $('article.post h2.entry-title a, article a.entry-link, .post-title a').each((_i, el) => {
      const href = $(el).attr('href');
      const abs = absoluteUrl(href ?? null, PORTAL);
      if (abs && abs.includes(PORTAL)) urls.add(abs);
    });

    return Array.from(urls);
  }

  private parsePost(html: string, url: string): BarbadosRawData | null {
    const $ = loadHtml(html);
    const title =
      textOf($('h1.entry-title').first()) ||
      textOf($('h2.entry-title').first()) ||
      textOf($('h1').first());
    if (!title) return null;

    const publishedText =
      $('time.entry-date').attr('datetime') ??
      $('time').attr('datetime') ??
      textOf($('time').first()) ??
      undefined;

    const $body = $('div.entry-content, article .entry-content').first();
    const bodyText = textOf($body);
    const bodyHtml = $body.html() ?? '';

    const documents: Array<{ title: string; url: string }> = [];
    $body.find('a[href$=".pdf"], a[href$=".docx"], a[href$=".doc"]').each((_i, el) => {
      const $a = $(el);
      const docTitle = textOf($a) || 'Attachment';
      const href = $a.attr('href');
      if (href) documents.push({ title: docTitle, url: href });
    });

    const deadlineText = bodyText.match(DEADLINE_REGEX)?.[1];
    const valueMatch = bodyText.match(VALUE_REGEX);
    const valueText = valueMatch?.[0];
    const currencyHint = this.detectCurrency(valueText);
    const agencyGuess = bodyText.match(AGENCY_REGEX)?.[0];
    const referenceHint = bodyText.match(REFERENCE_REGEX)?.[1];

    return {
      title,
      detailUrl: url,
      publishedText,
      bodyText,
      bodyHtml,
      agencyGuess,
      deadlineText,
      valueText,
      currencyHint,
      referenceHint,
      documents: documents.length > 0 ? documents : undefined,
    };
  }

  private detectCurrency(value: string | undefined): 'BBD' | 'USD' | 'XCD' | undefined {
    if (!value) return undefined;
    const upper = value.toUpperCase();
    if (upper.includes('USD') || upper.includes('US$')) return 'USD';
    if (upper.includes('EC$') || upper.includes('XCD')) return 'XCD';
    if (upper.includes('BBD') || upper.includes('BDS$')) return 'BBD';
    return undefined;
  }

  private derivedReferenceId(url: string): string {
    const parsed = new URL(url);
    const slug = parsed.pathname.replace(/\/$/, '').split('/').pop() ?? url;
    return `BB-${slug.slice(0, 40)}`;
  }

  private parseValue(value: string): number | undefined {
    const cleaned = value.replace(/[^0-9.]/g, '');
    const n = Number.parseFloat(cleaned);
    return Number.isFinite(n) ? n : undefined;
  }
}
