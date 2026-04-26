/**
 * Jamaica — GOJEP Current Competitions (authenticated).
 *
 * Portal:    https://www.gojep.gov.jm
 * Platform:  European Dynamics e-PPS (Struts/JSF, Java)
 * Scope:     **Currently open** tenders — bids still being accepted.
 *            Counterpart to `jamaica-gojep` (which only has the public
 *            Opened-Tenders + Award-Notices surfaces, both post-deadline).
 *
 * Auth:      GOJEP gates Current Competitions behind a CAPTCHA for
 *            anonymous traffic. Authenticated supplier sessions skip
 *            the CAPTCHA on the same routes. We forward a session
 *            cookie carried in `GOJEP_SESSION_COOKIE` (typically a
 *            Tomcat `JSESSIONID=...` value, optionally with extra
 *            cookies separated by `; `).
 *
 * Session lifetime is server-side. Tomcat default is 30 minutes idle,
 * with a hard cap usually 8–24h. When the session expires, GOJEP
 * 302-redirects to /epps/authenticate/login. We detect that and
 * surface a structured warning so the on-call sees "refresh the
 * cookie" rather than a silent 0-row run.
 *
 * If GOJEP_SESSION_COOKIE is unset, the scraper short-circuits to
 * an empty result with a warning — same graceful pattern as the
 * Chile ticket flow.
 */
import {
  TenderScraper,
  fetchWithRetry,
  loadHtml,
  textOf,
  type NormalizedOpportunity,
  type RawOpportunity,
} from '@procur/scrapers-core';
import { log } from '@procur/utils/logger';
import { fromZonedTime } from 'date-fns-tz';

const PORTAL = 'https://www.gojep.gov.jm';
/**
 * Best-known path for the authenticated current-competitions listing
 * on the e-PPS platform. If GOJEP rotates the slug on a redesign the
 * scraper will surface a "no rows" warning and the value can be
 * adjusted here. Kept as a constant rather than env var since it's
 * not a secret.
 */
const LISTING_PATH = '/epps/cft/listCFT.do';
/**
 * displayTag table id for Current Competitions. Page-instance specific
 * but stable across runs (same convention as the Opened-Tenders scraper
 * which uses '3680181'). We pin the most-recent observed value and
 * fall back gracefully if pagination doesn't honour it.
 */
const TABLE_ID = '3680181';

/** Pages of 10 rows per page to walk per run. 50 = ~500 records. */
const DEFAULT_MAX_PAGES = 50;

/** Match GOJEP's login form / redirect markers. Any of these => session expired. */
const LOGIN_MARKERS = [
  '/epps/authenticate/login',
  'name="j_username"',
  'name="j_password"',
];

const DETAIL_HREF_REGEX = /\/epps\/cft\/prepareViewCfTWS\.do\?resourceId=(\d+)/;

export type JamaicaCurrentRawData = {
  resourceId: string;
  title: string;
  referenceNumber: string;
  agency: string;
  publishedDateText?: string;
  closingDateText?: string;
  procedureType?: string;
  detailUrl: string;
};

type ScraperInput = {
  sessionCookie?: string;
  fixtureHtml?: { listing?: string };
  maxPages?: number;
};

/**
 * GOJEP serves dates in Java's default Date.toString() form,
 *   "Fri Apr 24 13:00:00 COT 2026"
 * (reused from jamaica-gojep). Strip the TZ token and treat the
 * wall-clock as America/Jamaica.
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

/** Heuristic for "GOJEP redirected us to /login" — applied before parsing. */
export function isLoginPage(html: string): boolean {
  return LOGIN_MARKERS.some((m) => html.includes(m));
}

export class JamaicaGojepCurrentScraper extends TenderScraper {
  readonly jurisdictionSlug = 'jamaica';
  readonly sourceName = 'jamaica-gojep-current';
  readonly portalUrl = PORTAL;

  private readonly sessionCookie: string | undefined;
  private readonly fixtureHtml: { listing?: string } | undefined;
  private readonly maxPages: number;

  constructor(input: ScraperInput = {}) {
    super();
    this.sessionCookie = input.sessionCookie ?? process.env.GOJEP_SESSION_COOKIE;
    this.fixtureHtml = input.fixtureHtml;
    this.maxPages = Math.max(1, input.maxPages ?? DEFAULT_MAX_PAGES);
  }

  async fetch(): Promise<RawOpportunity[]> {
    if (!this.sessionCookie && !this.fixtureHtml) {
      log.warn('jamaica_current.skipped_no_session', {
        message:
          'GOJEP_SESSION_COOKIE not set — log in to gojep.gov.jm, copy JSESSIONID, set as a Trigger.dev env var.',
      });
      return [];
    }

    const out: RawOpportunity[] = [];
    const seen = new Set<string>();

    if (this.fixtureHtml?.listing) {
      const rows = this.parseListing(this.fixtureHtml.listing);
      for (const row of rows) out.push(this.toRaw(row));
      return out;
    }

    for (let page = 1; page <= this.maxPages; page += 1) {
      const html = await this.fetchPage(page);

      if (isLoginPage(html)) {
        log.warn('jamaica_current.session_expired', {
          page,
          message:
            'GOJEP responded with a login page — refresh GOJEP_SESSION_COOKIE in Trigger.dev env.',
        });
        break;
      }

      const rows = this.parseListing(html);
      if (rows.length === 0) {
        // Could be the natural end of pagination, OR an unexpected
        // table layout. Log on the first page so we can spot it
        // without a noisy log on every empty trailing page.
        if (page === 1) {
          log.warn('jamaica_current.empty_first_page', {
            note: 'No rows parsed on page 1 — may indicate a layout change or auth issue.',
          });
        }
        break;
      }

      let freshCount = 0;
      for (const row of rows) {
        if (seen.has(row.resourceId)) continue;
        seen.add(row.resourceId);
        out.push(this.toRaw(row));
        freshCount += 1;
      }
      // displayTag pagination occasionally re-serves the last page when
      // we walk past the end. Stop if a page contributed nothing new.
      if (freshCount === 0) break;
    }

    return out;
  }

  async parse(raw: RawOpportunity): Promise<NormalizedOpportunity | null> {
    const d = raw.rawData as unknown as JamaicaCurrentRawData;
    if (!d.title || !d.resourceId) return null;

    return {
      sourceReferenceId: d.resourceId,
      sourceUrl: raw.sourceUrl,
      title: d.title.slice(0, 500),
      description: d.title,
      referenceNumber: d.referenceNumber || undefined,
      type: d.procedureType,
      agencyName: d.agency,
      currency: 'JMD',
      publishedAt: parseGojepDate(d.publishedDateText),
      deadlineAt: parseGojepDate(d.closingDateText),
      deadlineTimezone: 'America/Jamaica',
      language: 'en',
      rawContent: d as unknown as Record<string, unknown>,
    };
  }

  private toRaw(row: JamaicaCurrentRawData): RawOpportunity {
    return {
      sourceReferenceId: row.resourceId,
      sourceUrl: row.detailUrl,
      rawData: row as unknown as Record<string, unknown>,
    };
  }

  private async fetchPage(page: number): Promise<string> {
    const url = `${PORTAL}${LISTING_PATH}?d-${TABLE_ID}-p=${page}`;
    const res = await fetchWithRetry(url, {
      headers: {
        Cookie: this.sessionCookie!,
        // Match a current Chrome UA — Java app servers sometimes block
        // generic Node fetch UAs.
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    return res.text();
  }

  private parseListing(html: string): JamaicaCurrentRawData[] {
    const $ = loadHtml(html);
    const rows: JamaicaCurrentRawData[] = [];

    // displayTag tables on e-PPS render as <table> with rows in a tbody.
    // Selector tries the common e-PPS table classes first then falls
    // back to "any table whose row links contain prepareViewCfTWS".
    const candidateSelectors = [
      'table.displaytag tbody tr',
      'table.tenderList tbody tr',
      'table.cftList tbody tr',
      'table tbody tr',
    ];
    let $rows = $('');
    for (const selector of candidateSelectors) {
      $rows = $(selector);
      if ($rows.length > 0) break;
    }

    $rows.each((_i, el) => {
      const $row = $(el);
      const $cells = $row.find('td');
      if ($cells.length < 4) return;

      // Detail link → resourceId is the only stable id GOJEP exposes.
      const $link = $row.find('a[href*="prepareViewCfTWS"]').first();
      const href = $link.attr('href') ?? '';
      const idMatch = href.match(DETAIL_HREF_REGEX);
      if (!idMatch?.[1]) return;
      const resourceId = idMatch[1];
      const detailUrl = href.startsWith('http') ? href : `${PORTAL}${href}`;

      // Cell layout on e-PPS Current Competitions is conventionally:
      //   reference | title | agency | published | closing | procedure
      // We map by index but tolerate variable column counts.
      const referenceNumber = textOf($cells.eq(0));
      const title = textOf($link) || textOf($cells.eq(1));
      const agency = textOf($cells.eq(2));
      const publishedDateText = textOf($cells.eq(3));
      const closingDateText = textOf($cells.eq(4));
      const procedureType = $cells.length > 5 ? textOf($cells.eq(5)) : undefined;

      if (!title) return;

      rows.push({
        resourceId,
        title,
        referenceNumber,
        agency,
        publishedDateText,
        closingDateText,
        procedureType,
        detailUrl,
      });
    });

    return rows;
  }
}
