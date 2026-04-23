/**
 * Guyana — National Procurement and Tender Administration Board (NPTAB).
 *
 * Portal:       https://nptab.gov.gy
 * Platform:     WordPress + custom post type for tenders
 * Listing URL:  /invitations-for-bids/
 * Detail URL:   /?p=<postId>   or /invitations-for-bids/<slug>/
 *
 * NPTAB publishes tenders as news-style posts. Structure varies per
 * ministry; some include tables, others plain paragraphs. Parsing is
 * tolerant: if a labelled table exists we use it, otherwise we fall
 * back to regex extraction on paragraph text, and leave the rest for
 * the AI pipeline to refine post-ingest.
 *
 * Selector notes (validate against live fetch):
 *  - Listing: article.type-tender, article.post, li.tender-item
 *  - Post title: h2.entry-title a, h1.entry-title
 *  - Post body: div.entry-content
 *  - Date: time.entry-date, span.posted-on time
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

const PORTAL = 'https://nptab.gov.gy';
const LISTING_PATH = '/invitations-for-bids/';

export type GuyanaRawData = {
  title: string;
  detailUrl: string;
  publishedText?: string;
  bodyText: string;
  bodyHtml: string;
  agencyGuess?: string;
  deadlineText?: string;
  valueText?: string;
  referenceHint?: string;
  documents?: Array<{ title: string; url: string }>;
};

type ScraperInput = {
  fixtureHtml?: {
    listing?: string;
    posts?: Record<string, string>;
  };
  maxPosts?: number;
};

const DEADLINE_REGEX =
  /(?:closing|deadline|must\s+be\s+(?:submitted|received)|bids\s+due|submission(?:\s+of\s+bids)?)[^\n]{0,80}?([0-9]{1,2}[-/ ][A-Za-z0-9]{2,9}[-/ ][0-9]{2,4})/i;

const AGENCY_REGEX =
  /(?:Ministry of [A-Z][A-Za-z& ,]+|Regional Democratic Council[^,.;]*|Guyana [A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*|National [A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*)/;

const VALUE_REGEX = /(?:G\$|GYD|GY\$)\s*([\d,]+(?:\.\d+)?)/;

const REFERENCE_REGEX = /\b([A-Z]{2,8}[-/][A-Z0-9]{1,6}[-/][A-Z0-9]{1,6}[-/]?[A-Z0-9]{0,8})\b/;

export class GuyanaNptabScraper extends TenderScraper {
  readonly jurisdictionSlug = 'guyana';
  readonly sourceName = 'guyana-nptab';
  readonly portalUrl = PORTAL;

  constructor(private readonly input: ScraperInput = {}) {
    super();
  }

  async fetch(): Promise<RawOpportunity[]> {
    const listingHtml = this.input.fixtureHtml?.listing ?? (await this.fetchPath(LISTING_PATH));
    const postUrls = this.parseListing(listingHtml);

    const limit = this.input.maxPosts ?? 50;
    const results: RawOpportunity[] = [];

    for (const url of postUrls.slice(0, limit)) {
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
    const d = raw.rawData as unknown as GuyanaRawData;
    if (!d.title) return null;

    const valueMatch = d.valueText ?? d.bodyText.match(VALUE_REGEX)?.[0];
    const value = valueMatch ? this.parseGyd(valueMatch) : undefined;

    return {
      sourceReferenceId: raw.sourceReferenceId,
      sourceUrl: raw.sourceUrl,
      title: d.title,
      description: d.bodyText.slice(0, 2000),
      referenceNumber: d.referenceHint,
      agencyName: d.agencyGuess,
      currency: 'GYD',
      valueEstimate: value,
      publishedAt: parseTenderDate(d.publishedText, 'America/Guyana') ?? undefined,
      deadlineAt: parseTenderDate(d.deadlineText, 'America/Guyana') ?? undefined,
      deadlineTimezone: 'America/Guyana',
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

    $('article.type-tender a, article.post h2.entry-title a, li.tender-item a').each(
      (_i, el) => {
        const href = $(el).attr('href');
        const abs = absoluteUrl(href ?? null, PORTAL);
        if (abs && abs.includes(PORTAL)) urls.add(abs);
      },
    );

    return Array.from(urls);
  }

  private parsePost(html: string, url: string): GuyanaRawData | null {
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
    const valueText = bodyText.match(VALUE_REGEX)?.[0];
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
      referenceHint,
      documents: documents.length > 0 ? documents : undefined,
    };
  }

  private derivedReferenceId(url: string): string {
    const parsed = new URL(url);
    if (parsed.searchParams.has('p')) return `NPTAB-p${parsed.searchParams.get('p')}`;
    const slug = parsed.pathname.replace(/\/$/, '').split('/').pop() ?? url;
    return `NPTAB-${slug.slice(0, 40)}`;
  }

  private parseGyd(value: string): number | undefined {
    const cleaned = value.replace(/[^0-9.]/g, '');
    const n = Number.parseFloat(cleaned);
    return Number.isFinite(n) ? n : undefined;
  }
}
