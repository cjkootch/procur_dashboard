/**
 * Dominican Republic — Dirección General de Contrataciones Públicas (DGCP).
 *
 * Portal:       https://comunidad.comprasdominicana.gob.do
 * Public site:  https://www.dgcp.gob.do
 * Platform:     Custom DGCP "Portal Transaccional" — server-rendered HTML
 * Listing URL:  /Public/Tendering/ContractNoticeManagement/Index
 * Detail URL:   /Public/Tendering/OpportunityDetail/Index?noticeUID={uid}
 *
 * Notes:
 *  - All public-facing copy is Spanish.
 *  - Dates appear as "27/11/2025" or "27 de noviembre de 2025".
 *  - Currency is DOP (peso dominicano) but USD is sometimes used for
 *    international RFPs (RFI/EOI). We default to DOP and let the AI
 *    pipeline fix outliers from the value text.
 *  - Selectors below mirror the DGCP markup as of late 2025; tolerant
 *    fallbacks let parsing degrade gracefully when DGCP redesigns. Run
 *    `pnpm --filter @procur/scrapers cli scrape dominican-republic` against
 *    a live fetch on first deploy to validate.
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

const PORTAL = 'https://comunidad.comprasdominicana.gob.do';
const LISTING_PATH = '/Public/Tendering/ContractNoticeManagement/Index';

export type DrRawData = {
  referenceNumber: string;
  title: string;
  agency: string;
  procedureType?: string;
  publishedText?: string;
  deadlineText?: string;
  detailUrl: string;
  noticeUid?: string;
  valueText?: string;
  currencyText?: string;
  descriptionHtml?: string;
  category?: string;
  documents?: Array<{ title: string; url: string }>;
};

type ScraperInput = {
  fixtureHtml?: {
    listing?: string;
    details?: Record<string, string>;
  };
  /** Max detail pages to fetch in one run. Default: 200. */
  maxDetails?: number;
};

const SPANISH_MONTHS: Record<string, number> = {
  enero: 1,
  febrero: 2,
  marzo: 3,
  abril: 4,
  mayo: 5,
  junio: 6,
  julio: 7,
  agosto: 8,
  septiembre: 9,
  setiembre: 9,
  octubre: 10,
  noviembre: 11,
  diciembre: 12,
};

const TZ = 'America/Santo_Domingo';

/**
 * Pre-normalize Spanish-language date strings into a form the shared
 * parseTenderDate helper recognizes. Examples handled:
 *   "27 de noviembre de 2025"    → "27/11/2025"
 *   "27 noviembre 2025"          → "27/11/2025"
 *   "27/11/2025 a las 14:30"     → "27/11/2025 14:30"
 * Numeric-only formats pass through untouched.
 */
export function parseDrDate(input: string | null | undefined): Date | null {
  if (!input) return null;
  const cleaned = input
    .toLowerCase()
    .replace(/\s+a las\s+/g, ' ')
    .replace(/h(?:ora)?s?\.?$/g, '')
    .trim();

  const longFormat = cleaned.match(
    /^(\d{1,2})\s+(?:de\s+)?([a-záéíóúñ]+)\s+(?:de\s+)?(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/i,
  );
  if (longFormat) {
    const [, day, monthName, year, hour, minute] = longFormat;
    const month = SPANISH_MONTHS[monthName ?? ''];
    if (month && day && year) {
      const padded = `${day.padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`;
      const withTime = hour && minute ? `${padded} ${hour.padStart(2, '0')}:${minute}` : padded;
      return parseTenderDate(withTime, TZ);
    }
  }

  // Numeric formats may also carry the "a las HH:mm" suffix; pass the
  // stripped form through to the shared parser.
  return parseTenderDate(cleaned, TZ);
}

const VALUE_REGEX = /(?:RD\$|DOP|US\$|USD)\s*([\d.,]+)/i;

export class DrDgcpScraper extends TenderScraper {
  readonly jurisdictionSlug = 'dominican-republic';
  readonly sourceName = 'dr-dgcp';
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
    const d = raw.rawData as unknown as DrRawData;
    if (!d.title || !d.referenceNumber) return null;

    const valueMatch = d.valueText?.match(VALUE_REGEX);
    const valueEstimate = valueMatch?.[1] ? this.parseDopOrUsd(valueMatch[1]) : undefined;
    // If the value text mentions USD/US$, treat as USD; else default to DOP.
    const currency =
      d.currencyText?.toUpperCase().includes('USD') ||
      d.valueText?.toUpperCase().match(/USD|US\$/)
        ? 'USD'
        : 'DOP';

    return {
      sourceReferenceId: d.referenceNumber,
      sourceUrl: raw.sourceUrl,
      title: d.title,
      description: d.descriptionHtml?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
      referenceNumber: d.referenceNumber,
      type: d.procedureType,
      agencyName: d.agency,
      category: d.category,
      currency,
      valueEstimate,
      publishedAt: parseDrDate(d.publishedText) ?? undefined,
      deadlineAt: parseDrDate(d.deadlineText) ?? undefined,
      deadlineTimezone: TZ,
      language: 'es',
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

  private parseListingRows(html: string): DrRawData[] {
    const $ = loadHtml(html);
    const rows: DrRawData[] = [];

    // DGCP renders the public list as either a table.dataTable (current
    // markup) or a div.notice-card grid (some redesigns). We try both.
    $('table.dataTable tbody tr, table.tableNoticeList tbody tr').each((_i, el) => {
      const $row = $(el);
      const $cells = $row.find('td');
      if ($cells.length < 4) return;

      const referenceNumber = textOf($cells.eq(0));
      const $titleLink = $cells.eq(1).find('a').first();
      const title = textOf($titleLink) || textOf($cells.eq(1));
      const relHref = $titleLink.attr('href') ?? '';
      const detailUrl = absoluteUrl(relHref, PORTAL) ?? relHref;
      const agency = textOf($cells.eq(2));
      const procedureType = $cells.length > 4 ? textOf($cells.eq(3)) : undefined;
      const publishedText = textOf($cells.eq($cells.length - 2));
      const deadlineText = textOf($cells.eq($cells.length - 1));

      if (!referenceNumber || !title || !detailUrl) return;

      const noticeUid = this.extractNoticeUid(detailUrl);

      rows.push({
        referenceNumber,
        title,
        agency,
        procedureType,
        publishedText,
        deadlineText,
        detailUrl,
        noticeUid,
      });
    });

    if (rows.length === 0) {
      // Fallback: notice cards
      $('div.notice-card, article.notice-item').each((_i, el) => {
        const $card = $(el);
        const $titleLink = $card.find('a.notice-title, h3 a').first();
        const title = textOf($titleLink);
        const relHref = $titleLink.attr('href') ?? '';
        const detailUrl = absoluteUrl(relHref, PORTAL) ?? relHref;
        const referenceNumber = textOf($card.find('.notice-reference, .reference'));
        const agency = textOf($card.find('.notice-agency, .agency'));
        const publishedText = textOf($card.find('.notice-published, .published'));
        const deadlineText = textOf($card.find('.notice-deadline, .deadline'));
        if (!title || !detailUrl) return;
        rows.push({
          referenceNumber: referenceNumber || `DGCP-${this.extractNoticeUid(detailUrl) ?? title.slice(0, 20)}`,
          title,
          agency,
          publishedText,
          deadlineText,
          detailUrl,
          noticeUid: this.extractNoticeUid(detailUrl),
        });
      });
    }

    return rows;
  }

  private parseDetail(html: string, row: DrRawData): DrRawData {
    const $ = loadHtml(html);

    // DGCP detail pages use labelled rows: <dt>Label</dt><dd>Value</dd>
    // or two-column tables.
    const fields: Record<string, string> = {};
    $('dl.notice-detail dt, dl.detail-list dt').each((_i, el) => {
      const label = textOf($(el)).replace(/:$/, '').toLowerCase();
      const value = textOf($(el).next('dd'));
      if (label) fields[label] = value;
    });
    $('table.detail-table tr, table.notice-detail tr').each((_i, el) => {
      const $cells = $(el).find('td, th');
      if ($cells.length !== 2) return;
      const label = textOf($cells.eq(0)).replace(/:$/, '').toLowerCase();
      const value = textOf($cells.eq(1));
      if (label) fields[label] = value;
    });

    const documents: Array<{ title: string; url: string }> = [];
    $('a[href*=".pdf"], a[href*="DownloadAttachment"], a[href*="GetAttachment"]').each((_i, el) => {
      const $a = $(el);
      const title = textOf($a) || 'Documento';
      const href = $a.attr('href');
      if (href) documents.push({ title, url: href });
    });

    return {
      ...row,
      valueText:
        fields['valor estimado'] ??
        fields['monto estimado'] ??
        fields['presupuesto'] ??
        fields['valor del contrato'],
      currencyText: fields['moneda'] ?? fields['divisa'],
      category: fields['categoría'] ?? fields['categoria'] ?? fields['rubro'],
      procedureType:
        fields['tipo de procedimiento'] ??
        fields['modalidad'] ??
        fields['tipo'] ??
        row.procedureType,
      descriptionHtml:
        $('div.notice-description, div.descripcion, dd.description').first().html() ?? undefined,
      documents: documents.length > 0 ? documents : undefined,
    };
  }

  private extractNoticeUid(url: string): string | undefined {
    try {
      const u = new URL(url, PORTAL);
      return u.searchParams.get('noticeUID') ?? u.searchParams.get('noticeUid') ?? undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Parse a Spanish-format number string. DR uses "1.234.567,89" (period
   * thousand separator, comma decimal) but values copied from US sources
   * may use the inverse "1,234,567.89". Heuristic: if the rightmost
   * separator is ',' and there are 1-2 digits after it, it's a decimal;
   * otherwise treat all separators as thousands.
   */
  private parseDopOrUsd(raw: string): number | undefined {
    const trimmed = raw.trim();
    const lastComma = trimmed.lastIndexOf(',');
    const lastDot = trimmed.lastIndexOf('.');
    let normalized = trimmed;
    if (lastComma > lastDot && /,\d{1,2}$/.test(trimmed)) {
      normalized = trimmed.replace(/\./g, '').replace(',', '.');
    } else if (lastDot > lastComma && /\.\d{1,2}$/.test(trimmed)) {
      normalized = trimmed.replace(/,/g, '');
    } else {
      normalized = trimmed.replace(/[.,]/g, '');
    }
    const n = Number.parseFloat(normalized);
    return Number.isFinite(n) ? n : undefined;
  }
}
