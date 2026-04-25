/**
 * Guyana — Local Content Register (LCR), administered by the
 * Petroleum Management Programme.
 *
 * Portal:       https://lcregister.petroleum.gov.gy
 * Listing URL:  /opportunities/
 *
 * The LCR is where Guyana's oil & gas operators (Esso/EEPGL, Hess,
 * CNOOC, plus tier-1 contractors like Halliburton, Saipem, Tucker,
 * Gulf Engineering, SBM Offshore, Schlumberger) publish tenders that
 * trigger Local Content Act compliance — i.e., the opportunities
 * Guyanese SMEs can actually bid on.
 *
 * Distinct from the NPTA civil-works scraper (`guyana-nptab`):
 *   - NPTA: government-procurement tenders (ministries, regional
 *     councils, public utilities). Civil works, supplies, etc.
 *   - LCR: operator-driven oil & gas tenders. Higher-value, often
 *     more frequent, tied to the Liza/Stabroek production system.
 *
 * Both target jurisdictionSlug = 'guyana' and feed the same
 * `opportunities` table; downstream queries can filter by sourceName
 * for analytics like "show me oil & gas only".
 *
 * Site is WordPress + Elementor + Dynamic.ooo's "Dynamic Content for
 * Elementor" plugin, which exposes a structured `<article>` per
 * opportunity. The listing page returns the entire active register
 * in one fetch (~200 rows, ~650KB) so no pagination needed v1.
 *
 * Per-article fields parsed (from `<div class="dce-item dce-item_X">`):
 *   - title (`dce-post-title h3 a`)
 *   - operator/author (`dce-author-business-name`)
 *   - posted date (`dce-post-date`, e.g. "Apr 22, 2026")
 *   - closing date (`dce-meta-text`, e.g. "05/22/2026")
 *   - supply category (`dce-taxonomy-supply_category`)
 *   - type of notice (`dce-taxonomy-type_of_notice`)
 *   - detail URL (`/supplier-notice/{slug}/`)
 *
 * Detail page is rate-limited from cold IPs (503 from this sandbox)
 * and the listing already carries enough metadata; v1 skips it.
 */
import {
  TenderScraper,
  fetchWithRetry,
  loadHtml,
  parseTenderDate,
  textOf,
  type NormalizedOpportunity,
  type RawOpportunity,
} from '@procur/scrapers-core';

const PORTAL = 'https://lcregister.petroleum.gov.gy';
const LISTING_PATH = '/opportunities/';

export type GuyanaLcrRawData = {
  slug: string;
  title: string;
  operator: string;
  postedDateText?: string;
  closingDateText?: string;
  supplyCategory?: string;
  noticeType?: string;
  detailUrl: string;
};

type ScraperInput = {
  fixtureHtml?: { listing?: string };
  /** Cap rows ingested per run; 0 = no cap. Default 500 — covers
   *  observed ~200-row listings with headroom. */
  maxRows?: number;
};

const SLUG_REGEX = /\/supplier-notice\/([^/]+)\/?$/;

export class GuyanaLcrScraper extends TenderScraper {
  readonly jurisdictionSlug = 'guyana';
  readonly sourceName = 'guyana-lcr';
  readonly portalUrl = PORTAL;

  constructor(private readonly input: ScraperInput = {}) {
    super();
  }

  async fetch(): Promise<RawOpportunity[]> {
    const html = this.input.fixtureHtml?.listing ?? (await this.fetchListing());
    return this.parseListing(html);
  }

  async parse(raw: RawOpportunity): Promise<NormalizedOpportunity | null> {
    const d = raw.rawData as unknown as GuyanaLcrRawData;
    if (!d.title) return null;

    const deadline = parseTenderDate(d.closingDateText, 'America/Guyana');
    const published = parseTenderDate(d.postedDateText, 'America/Guyana');

    return {
      sourceReferenceId: raw.sourceReferenceId,
      sourceUrl: raw.sourceUrl,
      title: d.title.slice(0, 500),
      description: d.title,
      // Operators are the "buying agency" in this context — Esso,
      // Halliburton, Tucker, etc. Keep them in agencyName so the UI
      // surfaces who's actually procuring.
      agencyName: d.operator,
      type: d.noticeType,
      category: d.supplyCategory,
      // Oil & gas tenders on the Stabroek block are dollar-denominated
      // by convention. Operators publish in USD; Guyana's local-content
      // suppliers invoice and report in USD.
      currency: 'USD',
      publishedAt: published ?? undefined,
      deadlineAt: deadline ?? undefined,
      deadlineTimezone: 'America/Guyana',
      language: 'en',
      rawContent: d as unknown as Record<string, unknown>,
    };
  }

  private async fetchListing(): Promise<string> {
    const res = await fetchWithRetry(`${PORTAL}${LISTING_PATH}`);
    return res.text();
  }

  /**
   * Each opportunity is one `<article>` containing several
   * `<div class="dce-item dce-item_X">` blocks. We parse by class
   * suffix rather than position because Elementor reorders the
   * blocks based on the page configuration.
   */
  private parseListing(html: string): RawOpportunity[] {
    const $ = loadHtml(html);
    const limit = this.input.maxRows ?? 500;
    const out: RawOpportunity[] = [];

    $('article').each((_i, el) => {
      if (limit > 0 && out.length >= limit) return false;

      const $art = $(el);
      const $titleLink = $art.find('.dce-post-title a').first();
      const detailHref = $titleLink.attr('href') ?? '';
      const title = textOf($titleLink);
      if (!title || !detailHref) return;

      const slugMatch = detailHref.match(SLUG_REGEX);
      const slug = slugMatch?.[1];
      if (!slug) return;

      const operator = textOf($art.find('.dce-author-business-name').first());
      const postedDateText = textOf($art.find('.dce-post-date').first());
      // Closing date sits in a `dce-meta-text` cell — the only text-meta
      // block on this page configuration.
      const closingDateText = textOf($art.find('.dce-meta-text span').first());
      const supplyCategory = textOf(
        $art.find('.dce-taxonomy-supply_category .dce-term').first(),
      );
      const noticeType = textOf(
        $art.find('.dce-taxonomy-type_of_notice .dce-term').first(),
      );

      const data: GuyanaLcrRawData = {
        slug,
        title,
        operator,
        postedDateText: postedDateText || undefined,
        closingDateText: closingDateText || undefined,
        supplyCategory: supplyCategory || undefined,
        noticeType: noticeType || undefined,
        detailUrl: detailHref,
      };

      out.push({
        sourceReferenceId: `LCR-${slug}`.slice(0, 96),
        sourceUrl: detailHref,
        rawData: data as unknown as Record<string, unknown>,
      });
      return;
    });

    return out;
  }
}
