/**
 * Chile — Mercado Público (authenticated supplier session).
 *
 * Counterpart to `chile-mp` which depends on the v1 API ticket. The
 * supplier dashboard at mercadopublico.cl exposes the same licitaciones
 * data without the ticket — auth is handled via Keycloak SSO cookies
 * (`ASP.NET_SessionId` + `access_token_ccr`).
 *
 * The session cookie value is carried in `MERCADO_PUBLICO_SESSION_COOKIE`
 * as a real `Cookie:` header payload (`name=value; name=value`). Missing
 * cookie short-circuits to 0 rows + a warning, same graceful pattern as
 * the GOJEP and Chile-ticket flows.
 *
 * Sessions on ASP.NET expire ~20 min idle / 8h hard cap by default; we
 * detect the Keycloak login redirect and emit
 * `chile_session.session_expired` so the on-call hook can fire.
 *
 * The listing path + grid selectors are best guesses based on the
 * Procurement/Modules/RFB convention. First cron run + structured
 * logs will confirm or surface a drift to fix.
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
import { log } from '@procur/utils/logger';

const PORTAL = 'https://www.mercadopublico.cl';
/**
 * Public preview search page. When unauthenticated, Mercado Público
 * gates this behind a CAPTCHA; an authenticated supplier session
 * receives the rendered grid directly.
 */
const LISTING_PATH =
  '/Procurement/Modules/RFB/StepsProcessRFB/PreviewBidsList.aspx';
const TZ = 'America/Santiago';

/** Markers indicating Keycloak punted us to the login flow. */
const LOGIN_MARKERS = [
  '/auth/realms/',
  'kc-form-login',
  'id="kc-login"',
  'name="login-form"',
  '/Account/Login',
];

export type ChileMpSessionRow = {
  codigoExterno: string;
  title: string;
  agency?: string;
  publishedText?: string;
  deadlineText?: string;
  valueText?: string;
  detailUrl: string;
};

type ScraperInput = {
  sessionCookie?: string;
  fixtureHtml?: { listing?: string };
};

export function isLoginPage(html: string): boolean {
  return LOGIN_MARKERS.some((m) => html.includes(m));
}

/**
 * Mercado Público's grid serialises money as Spanish-style "1.234.567"
 * (period thousand-sep, no decimal) or "1.234.567,89" — same heuristic
 * as the DR scraper applies.
 */
/**
 * Mercado Público's grid renders dates as `dd-MM-yyyy` or
 * `dd-MM-yyyy HH:mm`. parseTenderDate covers the slash form but not the
 * dash-with-time form, so swap dashes between digits to slashes before
 * handing off.
 */
function normalizeDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.replace(/(\d{1,2})-(\d{1,2})-(\d{4})/, '$1/$2/$3');
}

export function parseChileAmount(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const m = raw.match(/[\d.,]+/);
  if (!m) return undefined;
  const trimmed = m[0];
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

const CODIGO_EXTERNO_REGEX = /\b\d{2,6}-\d{1,4}-[A-Z]{1,3}\d{2,4}\b/;
const DETAIL_HREF_REGEX = /[Ii]dlicitacion=([\w-]+)/;

export class ChileMpSessionScraper extends TenderScraper {
  readonly jurisdictionSlug = 'chile';
  readonly sourceName = 'chile-mp-session';
  readonly portalUrl = PORTAL;

  private readonly sessionCookie: string | undefined;
  private readonly fixtureHtml: { listing?: string } | undefined;

  constructor(input: ScraperInput = {}) {
    super();
    this.sessionCookie = input.sessionCookie ?? process.env.MERCADO_PUBLICO_SESSION_COOKIE;
    this.fixtureHtml = input.fixtureHtml;
  }

  async fetch(): Promise<RawOpportunity[]> {
    if (!this.sessionCookie && !this.fixtureHtml) {
      log.warn('chile_session.skipped_no_cookie', {
        message:
          'MERCADO_PUBLICO_SESSION_COOKIE not set — log in to mercadopublico.cl, copy the ASP.NET_SessionId + access_token_ccr cookies, set as a Trigger.dev env var.',
      });
      return [];
    }

    const html = this.fixtureHtml?.listing ?? (await this.fetchListing());

    if (isLoginPage(html)) {
      log.warn('chile_session.session_expired', {
        message:
          'Mercado Público responded with a login page — refresh MERCADO_PUBLICO_SESSION_COOKIE in Trigger.dev env.',
      });
      return [];
    }

    const rows = this.parseListing(html);
    if (rows.length === 0) {
      log.warn('chile_session.empty_first_page', {
        bytes: html.length,
        note:
          'No rows parsed — may indicate a layout change. Inspect the run logs and adjust LISTING_PATH or the cell-selector candidates.',
      });
    }

    return rows.map((row) => ({
      sourceReferenceId: row.codigoExterno,
      sourceUrl: row.detailUrl,
      rawData: row as unknown as Record<string, unknown>,
    }));
  }

  async parse(raw: RawOpportunity): Promise<NormalizedOpportunity | null> {
    const r = raw.rawData as unknown as ChileMpSessionRow;
    if (!r.title || !r.codigoExterno) return null;

    const valueEstimate = parseChileAmount(r.valueText);

    return {
      sourceReferenceId: r.codigoExterno,
      sourceUrl: raw.sourceUrl,
      title: r.title.slice(0, 500),
      referenceNumber: r.codigoExterno,
      agencyName: r.agency,
      // Spanish-language source; cross-language keywords only.
      category: classifyVtcCategory(r.title) ?? undefined,
      currency: 'CLP',
      valueEstimate,
      publishedAt: parseTenderDate(normalizeDate(r.publishedText), TZ) ?? undefined,
      deadlineAt: parseTenderDate(normalizeDate(r.deadlineText), TZ) ?? undefined,
      deadlineTimezone: TZ,
      language: 'es',
      rawContent: r as unknown as Record<string, unknown>,
    };
  }

  private async fetchListing(): Promise<string> {
    const res = await fetchWithRetry(`${PORTAL}${LISTING_PATH}`, {
      headers: {
        Cookie: this.sessionCookie!,
        // Match a current Chrome UA — Mercado Público's WAF / bot
        // protection rejects generic Node fetch UAs.
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es-CL,es;q=0.9,en;q=0.8',
      },
    });
    return res.text();
  }

  private parseListing(html: string): ChileMpSessionRow[] {
    const $ = loadHtml(html);
    const rows: ChileMpSessionRow[] = [];

    // Mercado Público's grid renders as an ASP.NET DataGrid. Selectors
    // try the common WebForms classes then any tbody with a row link
    // pointing at DetailsAcquisition.aspx.
    const candidateSelectors = [
      'table#grdResultBidList tr',
      'table.grdResult tr',
      'table.gridResult tr',
      'tr[id*="grdResult"]',
      'tbody tr',
    ];
    let $rows = $('');
    for (const selector of candidateSelectors) {
      $rows = $(selector);
      if ($rows.length > 0) break;
    }

    $rows.each((_i, el) => {
      const $row = $(el);
      const $cells = $row.find('td');
      if ($cells.length < 3) return;

      const $link = $row.find('a[href*="DetailsAcquisition"]').first();
      const href = $link.attr('href') ?? '';
      const idMatch = href.match(DETAIL_HREF_REGEX);
      // Fallback: scan the whole row text for a Chilean codigoExterno
      // pattern (e.g. "1234-56-LR26") if the link doesn't expose it.
      const rowText = textOf($row);
      const codigoExterno = idMatch?.[1] ?? rowText.match(CODIGO_EXTERNO_REGEX)?.[0];
      if (!codigoExterno) return;

      const detailUrl = href.startsWith('http')
        ? href
        : href
          ? `${PORTAL}${href.startsWith('/') ? href : `/${href}`}`
          : `${PORTAL}/Procurement/Modules/RFB/StepsProcessRFB/DetailsAcquisition.aspx?idlicitacion=${encodeURIComponent(codigoExterno)}`;

      // Cell layout on the supplier search grid is conventionally:
      //   id-or-icon | title | agency | published | closing | value
      // We map by index but tolerate variable column counts.
      const titleCellIdx = $cells.length >= 6 ? 1 : 0;
      const title = textOf($link) || textOf($cells.eq(titleCellIdx));
      const agency = textOf($cells.eq(Math.min(2, $cells.length - 1)));
      const publishedText =
        $cells.length >= 5 ? textOf($cells.eq($cells.length - 3)) : undefined;
      const deadlineText =
        $cells.length >= 4 ? textOf($cells.eq($cells.length - 2)) : undefined;
      const valueText = $cells.length >= 5 ? textOf($cells.eq($cells.length - 1)) : undefined;

      if (!title) return;

      rows.push({
        codigoExterno,
        title,
        agency: agency || undefined,
        publishedText: publishedText || undefined,
        deadlineText: deadlineText || undefined,
        valueText: valueText || undefined,
        detailUrl,
      });
    });

    return rows;
  }
}
