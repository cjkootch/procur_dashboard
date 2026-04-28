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
  classifyVtcCategory,
} from '@procur/scrapers-core';
import { log } from '@procur/utils/logger';
import { fromZonedTime } from 'date-fns-tz';

const PORTAL = 'https://www.gojep.gov.jm';
/**
 * Authenticated current-competitions listing on the e-PPS platform.
 * `searchSelect=8` is GOJEP's "open competitions" filter; the
 * `isCurrentCompetitions=true` flag scopes the response to in-progress
 * tenders. Confirmed via live inspection of an authenticated session.
 *
 * The query already carries `?` so any pagination param appends with `&`.
 */
const LISTING_PATH = '/epps/quickSearchAction.do?isCurrentCompetitions=true&searchSelect=8';
/**
 * displayTag table id used for pagination on the Current Competitions
 * search results. Stable across runs on the same e-PPS instance.
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
  description?: string;
  agency: string;
  publishedDateText?: string;
  closingDateText?: string;
  category?: string;
  procedureType?: string;
  detailUrl: string;
};

type ScraperInput = {
  sessionCookie?: string;
  fixtureHtml?: { listing?: string };
  maxPages?: number;
};

/**
 * GOJEP's authenticated Current Competitions table renders dates as
 *   "18/05/2026 11:00:00"  (dd/MM/yyyy HH:mm:ss)
 * — local Jamaica wall-clock, no TZ suffix. (The public Opened-Tenders
 * surface that jamaica-gojep consumes uses a different Java
 * Date.toString() format; the two scrapers therefore parse separately.)
 */
const GOJEP_DATE_REGEX =
  /^(?<day>\d{1,2})\/(?<mon>\d{1,2})\/(?<year>\d{4})(?:\s+(?<h>\d{1,2}):(?<m>\d{1,2})(?::(?<s>\d{1,2}))?)?\s*$/;

export function parseGojepCurrentDate(input: string | undefined): Date | undefined {
  if (!input) return undefined;
  const m = input.trim().match(GOJEP_DATE_REGEX);
  if (!m?.groups) return undefined;
  const { day, mon, year, h, m: min, s } = m.groups;
  if (!day || !mon || !year) return undefined;
  const iso =
    `${year}-${mon.padStart(2, '0')}-${day.padStart(2, '0')}` +
    `T${(h ?? '00').padStart(2, '0')}:${(min ?? '00').padStart(2, '0')}:${(s ?? '00').padStart(2, '0')}`;
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
      description: d.description ?? d.title,
      // GOJEP doesn't expose a separate procurement-reference; the
      // resourceId in the URL is the only stable identifier.
      referenceNumber: d.resourceId,
      type: d.procedureType,
      category:
        d.category ??
        classifyVtcCategory(`${d.title} ${d.description ?? ''}`) ??
        undefined,
      agencyName: d.agency,
      currency: 'JMD',
      publishedAt: parseGojepCurrentDate(d.publishedDateText),
      deadlineAt: parseGojepCurrentDate(d.closingDateText),
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
    // LISTING_PATH already carries `?...`, so pagination uses `&`.
    const url = `${PORTAL}${LISTING_PATH}&d-${TABLE_ID}-p=${page}`;
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

    // GOJEP's Current Competitions list is a vanilla <tr> grid with
    // alternating Even/Odd row classes; rather than hunt for a stable
    // table class we anchor on rows that actually carry a detail link.
    const $rows = $('tr').filter(
      (_i, el) => $(el).find('a[href*="prepareViewCfTWS"]').length > 0,
    );

    $rows.each((_i, el) => {
      const $row = $(el);
      const $cells = $row.find('td');
      if ($cells.length < 5) return;

      const $link = $row.find('a[href*="prepareViewCfTWS"]').first();
      const href = $link.attr('href') ?? '';
      const idMatch = href.match(DETAIL_HREF_REGEX);
      if (!idMatch?.[1]) return;
      const resourceId = idMatch[1];
      const detailUrl = href.startsWith('http') ? href : `${PORTAL}${href}`;

      // Cell layout (verified from authenticated session, Apr 2026):
      //   0: row index            (skip)
      //   1: title link
      //   2: procuring entity
      //   3: <img title="..."> with full description
      //   4: closing date          ("18/05/2026 11:00:00")
      //   5: contract type         ("Goods" / "Services" / "Works")
      //   6: procedure             ("Open - NCB" / "Restricted")
      //   7: phase (hidden)
      //   8: notice PDF link (hidden)
      //   9: published date        ("24/04/2026 16:10:21")
      const title = textOf($link).trim();
      const agency = textOf($cells.eq(2));
      const description =
        $cells.eq(3).find('img[title]').attr('title')?.trim() || textOf($cells.eq(3));
      const closingDateText = textOf($cells.eq(4));
      const category = $cells.length > 5 ? textOf($cells.eq(5)) : undefined;
      const procedureType = $cells.length > 6 ? textOf($cells.eq(6)) : undefined;
      const publishedDateText =
        $cells.length > 9 ? textOf($cells.eq(9)) : undefined;

      if (!title) return;

      rows.push({
        resourceId,
        title,
        description: description || undefined,
        agency,
        publishedDateText: publishedDateText || undefined,
        closingDateText: closingDateText || undefined,
        category: category || undefined,
        procedureType: procedureType || undefined,
        detailUrl,
      });
    });

    return rows;
  }
}
