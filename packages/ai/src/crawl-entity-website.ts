/**
 * Website intelligence crawler — Component agreed-scope from chat.
 *
 * For one entity (or all entities matching a country filter), crawl
 * up to 10 high-signal pages from `known_entities.primary_domain`,
 * extract structured facts + summaries via Sonnet, persist to
 * entity_web_pages / entity_web_facts / entity_web_summaries.
 *
 * Pipeline per entity:
 *   1. Look up primary_domain. Skip if null.
 *   2. Fetch homepage. Discover same-host links.
 *   3. Filter via classifyPage — keep only high-signal page kinds,
 *      reject blogs / privacy / careers / login / images.
 *   4. Cap at 10 pages. Fetch each, respecting:
 *        - robots.txt (per-host cache)
 *        - 1-sec polite delay between requests on same host
 *        - 8-sec request timeout
 *   5. Strip HTML → plain text. Hash. Skip pages under 200 chars.
 *   6. Upload page text to Vercel Blob (when BLOB_READ_WRITE_TOKEN
 *      is set; otherwise just store hash + skip blob_url).
 *   7. Single Sonnet pass over concatenated text → facts + summaries.
 *   8. Wipe + insert facts (ON DELETE CASCADE handles fact cleanup
 *      when a page row is replaced; summaries replace by UNIQUE
 *      conflict).
 *
 * Re-crawl behavior: --refresh forces a full re-crawl + re-extract.
 * Without --refresh, pages with matching content_hash skip
 * re-extraction (the LLM call is the expensive part).
 *
 * Run from repo root:
 *   pnpm --filter @procur/ai crawl-entity-website --slug=fuel-buyer:msc-cruises
 *   pnpm --filter @procur/ai crawl-entity-website --slug=... --refresh
 *   pnpm --filter @procur/ai crawl-entity-website --country=JM --limit=20
 *   pnpm --filter @procur/ai crawl-entity-website --slug=... --dry-run
 */
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { sql } from 'drizzle-orm';
import { put } from '@vercel/blob';
import { db } from '@procur/db/client';
import {
  USER_AGENT,
  HostRateLimiter,
  RobotsCache,
  canonicalizeUrl,
  classifyPage,
  extractSameHostLinks,
  extractTextFromHtml,
  hostOf,
  sha256,
  type PageKind,
} from './lib/web-crawler-utils';
import {
  extractWebsiteIntelligence,
  type WebsiteIntelligenceOutputT,
} from './tasks/extract-website-intelligence';

loadEnv({ path: '../../.env.local' });
loadEnv({ path: '../../.env' });

const MAX_PAGES_PER_ENTITY = 10;
const MAX_TEXT_PER_PAGE_CHARS = 20_000;
const MIN_TEXT_TO_KEEP = 200;
const FETCH_TIMEOUT_MS = 8_000;
const REQUEST_DELAY_MS = 1_000;
const MODEL_VERSION = 'claude-sonnet-4-6';

type EntityRow = {
  slug: string;
  name: string;
  country: string;
  primary_domain: string | null;
};

type CrawlOptions = {
  refresh: boolean;
  dryRun: boolean;
  perEntityLimit: number;
};

async function loadEntities(args: {
  slug: string | null;
  country: string | null;
  limit: number | null;
}): Promise<EntityRow[]> {
  if (args.slug) {
    const rows = (await db.execute(sql`
      SELECT slug, name, country, primary_domain
        FROM known_entities WHERE slug = ${args.slug}
    `)) as unknown as EntityRow[];
    return rows;
  }
  const limitClause = args.limit != null ? sql`LIMIT ${args.limit}` : sql``;
  const rows = (await (args.country
    ? db.execute(sql`
        SELECT slug, name, country, primary_domain
          FROM known_entities
         WHERE primary_domain IS NOT NULL
           AND country = ${args.country}
         ORDER BY slug ${limitClause}
      `)
    : db.execute(sql`
        SELECT slug, name, country, primary_domain
          FROM known_entities
         WHERE primary_domain IS NOT NULL
         ORDER BY slug ${limitClause}
      `))) as unknown as EntityRow[];
  return rows;
}

function startUrlForDomain(domain: string): string {
  // primary_domain may be 'msc.com' or 'https://msc.com' — normalize.
  const trimmed = domain.trim().replace(/\/+$/, '');
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

type FetchedPage = {
  url: string;
  kind: PageKind;
  text: string;
  title: string | null;
  contentHash: string;
  httpStatus: number;
};

type SkippedPage = {
  url: string;
  kind: PageKind;
  httpStatus: number | null;
  skipReason: string;
};

async function fetchOne(
  url: string,
  rateLimiter: HostRateLimiter,
): Promise<{ ok: true; status: number; html: string } | { ok: false; status: number | null; reason: string }> {
  const host = hostOf(url);
  if (!host) return { ok: false, status: null, reason: 'invalid_host' };
  await rateLimiter.wait(host);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
      },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, status: res.status, reason: `http_${res.status}` };
    const ct = (res.headers.get('content-type') ?? '').toLowerCase();
    if (!ct.includes('html')) return { ok: false, status: res.status, reason: `mime_${ct.split(';')[0] || 'unknown'}` };
    const html = await res.text();
    return { ok: true, status: res.status, html };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, status: null, reason: `fetch_error:${(err as Error).name}` };
  }
}

async function maybeUploadBlob(
  entitySlug: string,
  url: string,
  text: string,
): Promise<string | null> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return null;
  try {
    const key = `entity-web/${entitySlug}/${sha256(url).slice(0, 16)}.txt`;
    const blob = await put(key, Buffer.from(text, 'utf8'), {
      access: 'public',
      contentType: 'text/plain; charset=utf-8',
      addRandomSuffix: true,
    });
    return blob.url;
  } catch (err) {
    console.warn(`  blob upload failed for ${url}: ${(err as Error).message}`);
    return null;
  }
}

async function persistPage(
  entitySlug: string,
  page: FetchedPage,
  blobUrl: string | null,
): Promise<string> {
  // Insert / update the page row, return its id for facts FK.
  const result = (await db.execute(sql`
    INSERT INTO entity_web_pages (
      entity_slug, url, page_kind, http_status, content_hash, text_length,
      blob_url, title, fetched_at, robots_allowed
    ) VALUES (
      ${entitySlug}, ${page.url}, ${page.kind}, ${page.httpStatus},
      ${page.contentHash}, ${page.text.length}, ${blobUrl}, ${page.title},
      now(), true
    )
    ON CONFLICT (entity_slug, url) DO UPDATE SET
      page_kind = EXCLUDED.page_kind,
      http_status = EXCLUDED.http_status,
      content_hash = EXCLUDED.content_hash,
      text_length = EXCLUDED.text_length,
      blob_url = COALESCE(EXCLUDED.blob_url, entity_web_pages.blob_url),
      title = EXCLUDED.title,
      fetched_at = now(),
      robots_allowed = true,
      updated_at = now()
    RETURNING id;
  `)) as unknown as Array<{ id: string }>;
  if (!result[0]) throw new Error('page upsert returned no id');
  return result[0].id;
}

async function persistSkip(
  entitySlug: string,
  page: SkippedPage,
  robotsAllowed: boolean,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO entity_web_pages (
      entity_slug, url, page_kind, http_status, fetched_at,
      robots_allowed, skip_reason
    ) VALUES (
      ${entitySlug}, ${page.url}, ${page.kind}, ${page.httpStatus},
      now(), ${robotsAllowed}, ${page.skipReason}
    )
    ON CONFLICT (entity_slug, url) DO UPDATE SET
      http_status = EXCLUDED.http_status,
      fetched_at = now(),
      robots_allowed = EXCLUDED.robots_allowed,
      skip_reason = EXCLUDED.skip_reason,
      updated_at = now();
  `);
}

async function persistExtraction(
  entitySlug: string,
  pageIdByUrl: Map<string, string>,
  out: WebsiteIntelligenceOutputT,
): Promise<{ factsInserted: number; summariesUpserted: number }> {
  // Wipe existing facts for this entity (they'll be replaced with the
  // fresh extraction). Summaries are unique-conflicted on
  // (entity, kind, model_version) so they overwrite cleanly.
  await db.execute(sql`
    DELETE FROM entity_web_facts WHERE entity_slug = ${entitySlug};
  `);

  let factsInserted = 0;
  for (const f of out.facts) {
    const sourcePageId = pageIdByUrl.get(f.sourceUrl) ?? null;
    await db.execute(sql`
      INSERT INTO entity_web_facts (
        entity_slug, fact_type, value, evidence_text, confidence,
        source_page_id, source_url, model_version
      ) VALUES (
        ${entitySlug}, ${f.factType}, ${f.value.slice(0, 300)},
        ${f.evidenceText.slice(0, 500)}, ${f.confidence.toFixed(2)},
        ${sourcePageId}, ${f.sourceUrl}, ${MODEL_VERSION}
      );
    `);
    factsInserted += 1;
  }

  let summariesUpserted = 0;
  for (const s of out.summaries) {
    if (!s.content || s.content.trim().length === 0) continue;
    await db.execute(sql`
      INSERT INTO entity_web_summaries (
        entity_slug, section_kind, content, model_version
      ) VALUES (
        ${entitySlug}, ${s.sectionKind}, ${s.content.slice(0, 4000)},
        ${MODEL_VERSION}
      )
      ON CONFLICT (entity_slug, section_kind, model_version)
      DO UPDATE SET
        content = EXCLUDED.content,
        generated_at = now(),
        updated_at = now();
    `);
    summariesUpserted += 1;
  }
  return { factsInserted, summariesUpserted };
}

async function shouldRecrawl(
  entitySlug: string,
  refresh: boolean,
): Promise<boolean> {
  if (refresh) return true;
  // Heuristic: if any page row exists newer than 90 days, skip.
  const recent = (await db.execute(sql`
    SELECT 1 FROM entity_web_pages
     WHERE entity_slug = ${entitySlug}
       AND fetched_at > now() - INTERVAL '90 days'
     LIMIT 1;
  `)) as unknown as Array<{ '?column?': number }>;
  return recent.length === 0;
}

async function crawlOne(
  entity: EntityRow,
  rateLimiter: HostRateLimiter,
  robots: RobotsCache,
  options: CrawlOptions,
): Promise<void> {
  if (!entity.primary_domain) {
    console.log(`  ${entity.slug}: no primary_domain — skip`);
    return;
  }

  if (!options.dryRun) {
    const should = await shouldRecrawl(entity.slug, options.refresh);
    if (!should) {
      console.log(`  ${entity.slug}: fresh data <90d, skip (use --refresh to force)`);
      return;
    }
  }

  const startUrl = canonicalizeUrl(startUrlForDomain(entity.primary_domain));
  if (!startUrl) {
    console.log(`  ${entity.slug}: invalid primary_domain ${entity.primary_domain}`);
    return;
  }
  console.log(`\n${entity.slug} (${entity.name}) — crawling ${startUrl}`);

  const seedHostCheck = await robots.isAllowed(startUrl);
  if (!seedHostCheck.allowed) {
    console.log(`  robots disallows root — abort: ${seedHostCheck.reason}`);
    return;
  }

  const seedFetch = await fetchOne(startUrl, rateLimiter);
  if (!seedFetch.ok) {
    console.log(`  homepage fetch failed: ${seedFetch.reason}`);
    return;
  }

  // Discover candidate URLs from the homepage. Always include the
  // homepage itself.
  const candidates = new Set<string>([startUrl]);
  for (const link of extractSameHostLinks(seedFetch.html, startUrl)) {
    if (classifyPage(link)) candidates.add(link);
  }

  // Cap at MAX_PAGES_PER_ENTITY, prioritizing diverse page-kind coverage.
  const ranked = [...candidates]
    .map((u) => ({ url: u, kind: classifyPage(u) ?? 'other' as PageKind }))
    .sort((a, b) => (a.kind === 'home' ? -1 : 0) - (b.kind === 'home' ? -1 : 0));
  const seenKinds = new Set<PageKind>();
  const picked: Array<{ url: string; kind: PageKind }> = [];
  for (const c of ranked) {
    if (picked.length >= options.perEntityLimit) break;
    // Prefer one of each kind first; allow duplicates after.
    if (seenKinds.has(c.kind) && picked.length >= 5) continue;
    picked.push(c);
    seenKinds.add(c.kind);
  }
  console.log(`  ${picked.length} candidate pages — kinds: ${[...new Set(picked.map((p) => p.kind))].join(', ')}`);

  const fetched: FetchedPage[] = [];
  // Reuse the homepage HTML we already have for the seed.
  for (const c of picked) {
    let html: string;
    let httpStatus: number;
    if (c.url === startUrl) {
      html = seedFetch.html;
      httpStatus = seedFetch.status;
    } else {
      const robotsOk = await robots.isAllowed(c.url);
      if (!robotsOk.allowed) {
        if (!options.dryRun) {
          await persistSkip(
            entity.slug,
            { url: c.url, kind: c.kind, httpStatus: null, skipReason: robotsOk.reason ?? 'robots_disallowed' },
            false,
          );
        }
        console.log(`    ✗ ${c.url} — ${robotsOk.reason}`);
        continue;
      }
      const r = await fetchOne(c.url, rateLimiter);
      if (!r.ok) {
        if (!options.dryRun) {
          await persistSkip(
            entity.slug,
            { url: c.url, kind: c.kind, httpStatus: r.status, skipReason: r.reason },
            true,
          );
        }
        console.log(`    ✗ ${c.url} — ${r.reason}`);
        continue;
      }
      html = r.html;
      httpStatus = r.status;
    }
    const { text: rawText, title } = extractTextFromHtml(html);
    const text = rawText.slice(0, MAX_TEXT_PER_PAGE_CHARS);
    if (text.length < MIN_TEXT_TO_KEEP) {
      if (!options.dryRun) {
        await persistSkip(
          entity.slug,
          { url: c.url, kind: c.kind, httpStatus, skipReason: `text_too_short:${text.length}` },
          true,
        );
      }
      console.log(`    ✗ ${c.url} — text_too_short:${text.length}`);
      continue;
    }
    const contentHash = sha256(text);
    fetched.push({ url: c.url, kind: c.kind, text, title, contentHash, httpStatus });
    console.log(`    ✓ ${c.url} — ${text.length} chars [${c.kind}]`);
  }

  if (fetched.length === 0) {
    console.log('  no usable pages — aborting extraction');
    return;
  }

  if (options.dryRun) {
    console.log(`\n  (dry run — would extract from ${fetched.length} pages, no writes)`);
    return;
  }

  const pageIdByUrl = new Map<string, string>();
  for (const p of fetched) {
    const blobUrl = await maybeUploadBlob(entity.slug, p.url, p.text);
    const id = await persistPage(entity.slug, p, blobUrl);
    pageIdByUrl.set(p.url, id);
  }

  console.log(`  extracting via Sonnet over ${fetched.length} pages…`);
  const out = await extractWebsiteIntelligence({
    entityName: entity.name,
    countryHint: entity.country,
    pages: fetched.map((f) => ({ kind: f.kind, url: f.url, text: f.text })),
  });

  const counts = await persistExtraction(entity.slug, pageIdByUrl, out);
  console.log(
    `  extracted ${counts.factsInserted} facts + ${counts.summariesUpserted} summaries`,
  );
  if (out.notes) console.log(`  notes: ${out.notes}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const slugArg = args.find((a) => a.startsWith('--slug='));
  const countryArg = args.find((a) => a.startsWith('--country='));
  const limitArg = args.find((a) => a.startsWith('--limit='));
  const refresh = args.includes('--refresh');
  const dryRun = args.includes('--dry-run');
  const perEntityLimitArg = args.find((a) => a.startsWith('--max-pages='));

  const slug = slugArg ? slugArg.split('=')[1] ?? '' : null;
  const country = countryArg ? (countryArg.split('=')[1] ?? '').toUpperCase() || null : null;
  const limit = limitArg ? Number.parseInt(limitArg.split('=')[1] ?? '0', 10) : null;
  const perEntityLimit = perEntityLimitArg
    ? Math.max(1, Math.min(MAX_PAGES_PER_ENTITY, Number.parseInt(perEntityLimitArg.split('=')[1] ?? '10', 10)))
    : MAX_PAGES_PER_ENTITY;

  if (!slug && !country) {
    console.error(
      'Usage: pnpm --filter @procur/ai crawl-entity-website [options]\n' +
        '  --slug=<entity-slug>     Crawl one entity\n' +
        '  --country=CC             Crawl all entities in country (ISO-2)\n' +
        '  --limit=N                Cap total entities crawled (with --country)\n' +
        '  --max-pages=N            Cap pages per entity (default 10, max 10)\n' +
        '  --refresh                Force re-crawl even if data <90d old\n' +
        '  --dry-run                Print what would happen, no writes\n',
    );
    process.exit(1);
  }

  const entities = await loadEntities({ slug, country, limit });
  if (entities.length === 0) {
    console.log('no matching entities (with primary_domain) — exiting.');
    return;
  }
  console.log(`crawl-entity-website — ${entities.length} entity(s), refresh=${refresh}, dryRun=${dryRun}, perEntityLimit=${perEntityLimit}`);

  const rateLimiter = new HostRateLimiter(REQUEST_DELAY_MS);
  const robots = new RobotsCache();

  for (const entity of entities) {
    try {
      await crawlOne(entity, rateLimiter, robots, { refresh, dryRun, perEntityLimit });
    } catch (err) {
      console.error(`  ${entity.slug} failed: ${(err as Error).message}`);
    }
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
