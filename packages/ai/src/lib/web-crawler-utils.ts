/**
 * Crawl-side helpers for the website-intelligence pipeline.
 * Robots.txt check (cached per host), per-domain rate limiter,
 * URL canonicalization, page-kind classification, link extraction.
 */
import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import robotsParser from 'robots-parser';

export const USER_AGENT = 'procur-website-intelligence/0.1 (+https://procur.app)';

// ─── URL canonicalization ──────────────────────────────────────────

/** Strip query strings + fragment + trailing slash + lowercase host
 *  so the same logical page collapses to one canonical URL. */
export function canonicalizeUrl(input: string): string | null {
  try {
    const u = new URL(input);
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    u.search = '';
    u.hash = '';
    u.host = u.host.toLowerCase();
    let pathname = u.pathname;
    if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
    u.pathname = pathname;
    return u.toString();
  } catch {
    return null;
  }
}

export function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

// ─── Page-kind classification ──────────────────────────────────────

/** Maps URL path patterns to the page_kind taxonomy in the DB. Drives
 *  the crawl whitelist + the prioritization of LLM extraction tokens.
 *  Returns null when the path doesn't match any high-signal pattern —
 *  caller should skip those. */
export type PageKind =
  | 'home'
  | 'about'
  | 'products'
  | 'services'
  | 'operations'
  | 'assets'
  | 'investors'
  | 'sustainability'
  | 'contact'
  | 'terminals'
  | 'refineries'
  | 'fleet'
  | 'projects'
  | 'other';

const PAGE_KIND_PATTERNS: Array<{ kind: PageKind; re: RegExp }> = [
  { kind: 'about', re: /\/(about|company|who-?we-?are|overview|profile|history)(\/|$)/i },
  { kind: 'products', re: /\/(products?|portfolio|offerings?)(\/|$)/i },
  { kind: 'services', re: /\/(services?|solutions?|capabilit)/i },
  { kind: 'operations', re: /\/(operations?|business|what-?we-?do)(\/|$)/i },
  { kind: 'assets', re: /\/(assets|infrastructure|locations?)(\/|$)/i },
  { kind: 'investors', re: /\/(investors?|investor-?relations|ir|sec-filings|financials?)(\/|$)/i },
  { kind: 'sustainability', re: /\/(sustainability|esg|environment|responsibility)(\/|$)/i },
  { kind: 'contact', re: /\/(contact|reach-?us|get-?in-?touch|offices?|locations?)(\/|$)/i },
  { kind: 'terminals', re: /\/(terminals?|ports?|berths?|jett(y|ies))(\/|$)/i },
  { kind: 'refineries', re: /\/(refiner(y|ies)|process(ing)?-?plants?)(\/|$)/i },
  { kind: 'fleet', re: /\/(fleet|vessels?|ships?|tankers?|carriers?)(\/|$)/i },
  { kind: 'projects', re: /\/(projects?|developments?|case-?stud)/i },
];

/** Patterns the crawler must skip — low-signal, privacy/legal, careers,
 *  login/cart, raw image galleries. */
const SKIP_PATTERNS = [
  /\/(privacy|legal|terms|cookies?|gdpr|disclaimer|copyright)(\/|$)/i,
  /\/(careers?|jobs?|apply|hiring|life-?at-?)/i,
  /\/(login|signin|sign-?up|register|account|cart|checkout)(\/|$)/i,
  /\/(blog|news|press|media|stories|articles?)(\/|$)/i,
  /\/(gallery|galleries|photos?|images?|videos?|downloads?)(\/|$)/i,
  /\/(search|sitemap|feed|rss|atom)(\/|$|\.)/i,
  /\.(pdf|zip|docx?|xlsx?|pptx?|jpg|jpeg|png|gif|svg|webp|mp4|mov)$/i,
];

export function classifyPage(url: string): PageKind | null {
  let path: string;
  try {
    path = new URL(url).pathname || '/';
  } catch {
    return null;
  }
  if (SKIP_PATTERNS.some((re) => re.test(path))) return null;
  if (path === '/' || path === '') return 'home';
  for (const { kind, re } of PAGE_KIND_PATTERNS) {
    if (re.test(path)) return kind;
  }
  return null;
}

// ─── Link extraction ───────────────────────────────────────────────

/** Pull same-host hrefs out of a page, canonicalize, dedupe. Skips
 *  non-http(s), mailto, tel, anchors-only. */
export function extractSameHostLinks(html: string, baseUrl: string): string[] {
  const $ = cheerio.load(html);
  const baseHost = hostOf(baseUrl);
  if (!baseHost) return [];
  const seen = new Set<string>();
  $('a[href]').each((_, el) => {
    const raw = $(el).attr('href');
    if (!raw) return;
    let abs: string;
    try {
      abs = new URL(raw, baseUrl).toString();
    } catch {
      return;
    }
    const can = canonicalizeUrl(abs);
    if (!can) return;
    if (hostOf(can) !== baseHost) return;
    seen.add(can);
  });
  return [...seen];
}

/** Strip script + style + nav-chrome, return plain text + title. */
export function extractTextFromHtml(html: string): { text: string; title: string | null } {
  const $ = cheerio.load(html);
  $('script, style, noscript, svg, nav, header, footer, aside').remove();
  const title = $('title').first().text().trim() || null;
  // Body text — collapse whitespace.
  const raw = $('body').text() || $.text();
  const text = raw.replace(/\s+/g, ' ').trim();
  return { text, title };
}

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

// ─── Per-domain rate limiter ───────────────────────────────────────

/** Polite-crawler rate limiter — no more than 1 request per delayMs
 *  per host. Single-process (in-memory) so don't run multiple
 *  crawlers against the same host concurrently. */
export class HostRateLimiter {
  private nextOkAt = new Map<string, number>();
  constructor(private readonly delayMs: number = 1000) {}

  async wait(host: string): Promise<void> {
    const now = Date.now();
    const next = this.nextOkAt.get(host) ?? 0;
    if (next > now) {
      await new Promise((r) => setTimeout(r, next - now));
    }
    this.nextOkAt.set(host, Math.max(now, next) + this.delayMs);
  }
}

// ─── Robots.txt cache ──────────────────────────────────────────────

type RobotsRecord = {
  /** robots-parser result; null when fetch failed so we treat as allowed. */
  parser: ReturnType<typeof robotsParser> | null;
  fetchedAt: number;
};

/** Per-host robots.txt fetch + parse, cached for the process lifetime.
 *  Practical not paranoid: if robots.txt is unreachable we treat as
 *  allow-all (most sites don't have one). */
export class RobotsCache {
  private cache = new Map<string, RobotsRecord>();
  constructor(
    private readonly fetchTimeoutMs: number = 8_000,
    private readonly userAgent: string = USER_AGENT,
  ) {}

  async isAllowed(url: string): Promise<{ allowed: boolean; reason: string | null }> {
    const u = (() => {
      try {
        return new URL(url);
      } catch {
        return null;
      }
    })();
    if (!u) return { allowed: false, reason: 'invalid_url' };
    const host = u.host.toLowerCase();
    let record = this.cache.get(host);
    if (!record) {
      record = await this.fetch(host, u.protocol);
      this.cache.set(host, record);
    }
    if (!record.parser) return { allowed: true, reason: null }; // missing robots = allow
    const ok = record.parser.isAllowed(url, this.userAgent);
    if (ok === false) return { allowed: false, reason: 'robots_disallowed' };
    return { allowed: true, reason: null };
  }

  private async fetch(host: string, protocol: string): Promise<RobotsRecord> {
    const robotsUrl = `${protocol}//${host}/robots.txt`;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.fetchTimeoutMs);
      const res = await fetch(robotsUrl, {
        method: 'GET',
        headers: { 'User-Agent': this.userAgent },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) return { parser: null, fetchedAt: Date.now() };
      const body = await res.text();
      return { parser: robotsParser(robotsUrl, body), fetchedAt: Date.now() };
    } catch {
      return { parser: null, fetchedAt: Date.now() };
    }
  }
}
