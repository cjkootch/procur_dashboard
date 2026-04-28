/**
 * Dominican Republic — Dirección General de Contrataciones Públicas (DGCP).
 *
 * Portal:       https://comunidad.comprasdominicana.gob.do
 * Platform:     Vortal "Portal Transaccional" — server-rendered HTML over
 *               an ASP.NET WebForms backend.
 * Listing URL:  /Public/Tendering/ContractNoticeManagement/Index
 *               (returns 100 rows ordered RequestOnlinePublishingDateDESC)
 * Detail URL:   /Public/Tendering/OpportunityDetail/Index?noticeUID={uid}
 *
 * The listing already exposes everything we need for a card — agency,
 * reference, title, phase, published, deadline, value+currency text.
 * No detail-page fetch in the default path; that keeps the run to a
 * single HTTP round-trip for ~100 active opportunities. We can light up
 * detail enrichment later if we need attached PDFs or full descriptions.
 *
 * Pagination is gated behind a session-scoped POST (mkey-based); the
 * GET endpoint always returns the most recent 100 with newest first,
 * which on a 4-hourly cron covers DGCP's actual publishing rhythm.
 */
import {
  TenderScraper,
  fetchWithRetry,
  loadHtml,
  parseTenderDate,
  textOf,
  type NormalizedOpportunity,
  type RawOpportunity,
  classifyVtcCategory,
} from '@procur/scrapers-core';

const PORTAL = 'https://comunidad.comprasdominicana.gob.do';
const LISTING_PATH = '/Public/Tendering/ContractNoticeManagement/Index';

export type DrRawData = {
  referenceNumber: string;
  title: string;
  agency: string;
  countryCode: string;
  phaseCode?: string;
  publishedText?: string;
  deadlineText?: string;
  valueText?: string;
  noticeUid?: string;
  detailUrl: string;
};

type ScraperInput = {
  fixtureHtml?: { listing?: string };
};

const SPANISH_MONTHS: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
  julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10,
  noviembre: 11, diciembre: 12,
};

const TZ = 'America/Santo_Domingo';

/**
 * Pre-normalize Spanish-language and Vortal-decorated date strings into
 * a form parseTenderDate recognizes. Examples handled:
 *   "27 de noviembre de 2025"          → "27/11/2025"
 *   "24/04/2026 18:00 (UTC -4 hours)"  → "24/04/2026 18:00"
 *   "27/11/2025 a las 14:30"           → "27/11/2025 14:30"
 */
export function parseDrDate(input: string | null | undefined): Date | null {
  if (!input) return null;
  const cleaned = input
    .toLowerCase()
    .replace(/\s*\(utc[^)]*\)\s*/g, ' ')
    .replace(/\s+a las\s+/g, ' ')
    .replace(/h(?:ora)?s?\.?$/g, '')
    .replace(/\s+/g, ' ')
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

  return parseTenderDate(cleaned, TZ);
}

/**
 * Vortal expresses currencies as English/Spanish words rather than codes
 * — "1,500,000 Dominican Pesos" or "5,000.00 Dollars". Map the trailing
 * label to an ISO currency code; default DOP otherwise.
 */
function detectCurrency(valueText: string | undefined): string {
  if (!valueText) return 'DOP';
  const lower = valueText.toLowerCase();
  if (/\b(?:us\s*dollar|dollar|usd|us\$)/.test(lower)) return 'USD';
  if (/\b(?:euro|eur)\b/.test(lower)) return 'EUR';
  if (/\b(?:dominican\s*peso|peso\s*dominican|peso|dop|rd\$)/.test(lower)) return 'DOP';
  return 'DOP';
}

/**
 * Parse a number out of strings like "1,500,000" / "1.500.000,75" /
 * "5,000.00". Heuristic: rightmost separator with 1-2 trailing digits
 * is the decimal mark; otherwise treat all separators as thousands.
 */
export function parseDrAmount(raw: string): number | undefined {
  const match = raw.match(/[\d.,]+/);
  if (!match) return undefined;
  const trimmed = match[0];
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

/**
 * Vortal phase codes look like
 *   "ProcedureProfile_DGCP-01-ComprasMenores_Phase_TenderingPhase_Label"
 * Extract the human-meaningful procedure modality (the "ComprasMenores"
 * fragment) when possible.
 */
function readableProcedureType(phaseCode: string | undefined): string | undefined {
  if (!phaseCode) return undefined;
  const m = phaseCode.match(/_(?:DGCP|Profile)-\d+-([A-Za-zÁÉÍÓÚÑáéíóúñ]+)_Phase/);
  if (m?.[1]) return m[1];
  return phaseCode.length > 80 ? undefined : phaseCode;
}

export class DrDgcpScraper extends TenderScraper {
  readonly jurisdictionSlug = 'dominican-republic';
  readonly sourceName = 'dr-dgcp';
  readonly portalUrl = PORTAL;

  constructor(private readonly input: ScraperInput = {}) {
    super();
  }

  async fetch(): Promise<RawOpportunity[]> {
    const html = this.input.fixtureHtml?.listing ?? (await this.fetchListing());
    const rows = this.parseListingRows(html);

    return rows.map((row) => ({
      sourceReferenceId: row.referenceNumber,
      sourceUrl: row.detailUrl,
      rawData: row as unknown as Record<string, unknown>,
    }));
  }

  async parse(raw: RawOpportunity): Promise<NormalizedOpportunity | null> {
    const d = raw.rawData as unknown as DrRawData;
    if (!d.title || !d.referenceNumber) return null;

    // DGCP carries a few non-DR cross-listings (e.g., regional
    // procurements where the tendering authority is foreign). Skip
    // anything where the country column isn't DO so the DR jurisdiction
    // doesn't get polluted.
    if (d.countryCode && d.countryCode.toUpperCase() !== 'DO') return null;

    const valueEstimate = d.valueText ? parseDrAmount(d.valueText) : undefined;
    const currency = detectCurrency(d.valueText);

    return {
      sourceReferenceId: d.referenceNumber,
      sourceUrl: raw.sourceUrl,
      title: d.title,
      referenceNumber: d.referenceNumber,
      type: readableProcedureType(d.phaseCode),
      agencyName: d.agency,
      // Spanish-language source; cross-language keywords only.
      category: classifyVtcCategory(d.title) ?? undefined,
      currency,
      valueEstimate,
      publishedAt: parseDrDate(d.publishedText) ?? undefined,
      deadlineAt: parseDrDate(d.deadlineText) ?? undefined,
      deadlineTimezone: TZ,
      language: 'es',
      rawContent: d as unknown as Record<string, unknown>,
    };
  }

  private async fetchListing(): Promise<string> {
    const res = await fetchWithRetry(`${PORTAL}${LISTING_PATH}`);
    return res.text();
  }

  private parseListingRows(html: string): DrRawData[] {
    const $ = loadHtml(html);
    const rows: DrRawData[] = [];

    $('table.VortalGrid tr[id*="_grdResultList_tr"]').each((_i, el) => {
      const $row = $(el);
      const rawHtml = $.html($row);
      const $cells = $row.find('td');
      // Header row has 0 td (uses th); data rows have 10 cells.
      if ($cells.length < 8) return;

      const countryCode = textOf($cells.eq(0));
      const agency = textOf($cells.eq(1));
      const referenceNumber = textOf($cells.eq(2));
      const title = textOf($cells.eq(3));
      const phaseCode = textOf($cells.eq(4));
      const publishedText = textOf($cells.eq(5));
      const deadlineText = textOf($cells.eq(6));
      const valueText = textOf($cells.eq(7));

      if (!referenceNumber || !title) return;

      // The clickable "Detail" cell carries the modal-open onclick which
      // includes the noticeUID — we reconstruct the canonical permalink
      // off that. Fall back to the listing URL if the row is anomalous.
      // The inline JS reads:
      //   'noticeUID=' + 'DO1.NTC.1705653'
      const uidMatch = rawHtml.match(/'noticeUID='\s*\+\s*'([^']+)'/);
      const noticeUid = uidMatch?.[1];
      const detailUrl = noticeUid
        ? `${PORTAL}/Public/Tendering/OpportunityDetail/Index?noticeUID=${encodeURIComponent(noticeUid)}`
        : `${PORTAL}${LISTING_PATH}`;

      rows.push({
        referenceNumber,
        title,
        agency,
        countryCode,
        phaseCode: phaseCode || undefined,
        publishedText: publishedText || undefined,
        deadlineText: deadlineText || undefined,
        valueText: valueText || undefined,
        noticeUid,
        detailUrl,
      });
    });

    return rows;
  }
}
