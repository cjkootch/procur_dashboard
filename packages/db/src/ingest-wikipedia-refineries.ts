/**
 * Wikipedia refineries ingest.
 *
 * Source: https://en.wikipedia.org/wiki/List_of_oil_refineries (master
 *   article) plus per-country sub-articles when --include-sub-articles
 *   is passed.
 *
 * License: CC-BY-SA-4.0 (data) — same as Wikipedia content. Attribute
 *   to Wikipedia in any redistribution.
 *
 * Approach:
 *   1. Fetch the master article's HTML via MediaWiki Parse API
 *      (action=parse, prop=text). Returns a single HTML blob with
 *      H2 country sections + wikitables.
 *   2. Parse with cheerio. For each H2 section, find the immediately-
 *      following table(s); extract one entity per data row.
 *   3. Tolerant column matching: "Refinery"/"Name", "Operator"/"Owner",
 *      "Capacity"/"bbl", "Location"/"City". Wikipedia formatting varies
 *      across the country sections we'd otherwise lose.
 *   4. Routes through findOrUpsertEntity so Wikipedia rows enrich
 *      existing curated/Wikidata/OSM entries; standalone Wikipedia
 *      rows get wiki-* slugs.
 *
 * Coverage: ~200-400 refineries from the master article. Adding
 * --include-sub-articles roughly doubles that by walking linked
 * "List of oil refineries in X" pages (US, China, India, Russia,
 * Iran, etc.).
 *
 * Run:
 *   pnpm --filter @procur/db ingest-wikipedia-refineries
 *   pnpm --filter @procur/db ingest-wikipedia-refineries -- --include-sub-articles
 */
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as cheerio from 'cheerio';
import * as schema from './schema';
import { findOrUpsertEntity } from './lib/find-or-upsert-entity';

loadEnv({ path: '../../.env.local' });
loadEnv({ path: '../../.env' });

const WIKI_API = 'https://en.wikipedia.org/w/api.php';
const MASTER_ARTICLE = 'List_of_oil_refineries';

const HEADERS: Record<string, string> = {
  'User-Agent': 'procur-research/1.0 (cole@vectortradecapital.com)',
  Accept: 'application/json',
};

/** ISO-2 lookup for country names that appear as H2 section headings.
 *  Wikipedia uses common English names; map the ones we care about. */
const COUNTRY_NAME_TO_ISO2: Record<string, string> = {
  // Europe
  'austria': 'AT', 'belarus': 'BY', 'belgium': 'BE', 'bulgaria': 'BG',
  'croatia': 'HR', 'cyprus': 'CY', 'czech republic': 'CZ', 'czechia': 'CZ',
  'denmark': 'DK', 'estonia': 'EE', 'finland': 'FI', 'france': 'FR',
  'germany': 'DE', 'greece': 'GR', 'hungary': 'HU', 'ireland': 'IE',
  'italy': 'IT', 'latvia': 'LV', 'lithuania': 'LT', 'luxembourg': 'LU',
  'malta': 'MT', 'netherlands': 'NL', 'norway': 'NO', 'poland': 'PL',
  'portugal': 'PT', 'romania': 'RO', 'russia': 'RU', 'serbia': 'RS',
  'slovakia': 'SK', 'slovenia': 'SI', 'spain': 'ES', 'sweden': 'SE',
  'switzerland': 'CH', 'turkey': 'TR', 'ukraine': 'UA',
  'united kingdom': 'GB', 'uk': 'GB', 'great britain': 'GB',
  // Americas
  'argentina': 'AR', 'bolivia': 'BO', 'brazil': 'BR', 'canada': 'CA',
  'chile': 'CL', 'colombia': 'CO', 'cuba': 'CU', 'dominican republic': 'DO',
  'ecuador': 'EC', 'jamaica': 'JM', 'mexico': 'MX', 'peru': 'PE',
  'trinidad and tobago': 'TT', 'united states': 'US',
  'united states of america': 'US', 'usa': 'US', 'venezuela': 'VE',
  // Asia
  'afghanistan': 'AF', 'azerbaijan': 'AZ', 'bahrain': 'BH', 'bangladesh': 'BD',
  'china': 'CN', 'india': 'IN', 'indonesia': 'ID', 'iran': 'IR',
  'iraq': 'IQ', 'israel': 'IL', 'japan': 'JP', 'jordan': 'JO',
  'kazakhstan': 'KZ', 'kuwait': 'KW', 'kyrgyzstan': 'KG', 'laos': 'LA',
  'lebanon': 'LB', 'malaysia': 'MY', 'mongolia': 'MN', 'myanmar': 'MM',
  'oman': 'OM', 'pakistan': 'PK', 'philippines': 'PH', 'qatar': 'QA',
  'saudi arabia': 'SA', 'singapore': 'SG', 'south korea': 'KR',
  'sri lanka': 'LK', 'syria': 'SY', 'taiwan': 'TW', 'tajikistan': 'TJ',
  'thailand': 'TH', 'turkmenistan': 'TM', 'united arab emirates': 'AE',
  'uzbekistan': 'UZ', 'vietnam': 'VN', 'yemen': 'YE',
  // Africa
  'algeria': 'DZ', 'angola': 'AO', 'cameroon': 'CM', 'chad': 'TD',
  'congo': 'CG', "côte d'ivoire": 'CI', 'cote d ivoire': 'CI',
  'ivory coast': 'CI', 'egypt': 'EG', 'equatorial guinea': 'GQ',
  'eritrea': 'ER', 'ethiopia': 'ET', 'gabon': 'GA', 'ghana': 'GH',
  'kenya': 'KE', 'libya': 'LY', 'madagascar': 'MG', 'morocco': 'MA',
  'mozambique': 'MZ', 'nigeria': 'NG', 'senegal': 'SN', 'south africa': 'ZA',
  'south sudan': 'SS', 'sudan': 'SD', 'tanzania': 'TZ', 'tunisia': 'TN',
  'uganda': 'UG', 'zambia': 'ZM', 'zimbabwe': 'ZW',
  // Oceania
  'australia': 'AU', 'new zealand': 'NZ',
};

function nameToIso2(name: string): string | null {
  const k = name.trim().toLowerCase();
  return COUNTRY_NAME_TO_ISO2[k] ?? null;
}

function slugify(name: string, country: string): string {
  const base = name
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `wiki-${country.toLowerCase() || 'xx'}-${base}`;
}

function parseCapacityBpd(text: string | null): number | null {
  if (!text) return null;
  // "200,000 bbl/d", "1.36 mmbd", "300 kbd", "150,000 bpd"
  const cleaned = text.toLowerCase().replace(/\[[^\]]*\]/g, ''); // strip footnote refs
  const isMillion = /\b(mmb|mmbd|million)\b/.test(cleaned);
  const isThousand = /\b(kbd|kbpd|thousand|kb\/d|k\s*b)/.test(cleaned);
  const numMatch = cleaned.match(/([\d,.\s]+)/);
  if (!numMatch) return null;
  const n = Number.parseFloat(numMatch[1]!.replace(/[,\s]/g, ''));
  if (!Number.isFinite(n)) return null;
  if (isMillion) return Math.round(n * 1_000_000);
  if (isThousand) return Math.round(n * 1_000);
  return Math.round(n);
}

async function fetchArticleHtml(article: string): Promise<string> {
  const url = `${WIKI_API}?action=parse&page=${encodeURIComponent(
    article,
  )}&format=json&prop=text&disabletoc=true&disableeditsection=true&redirects=true`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`Wikipedia ${res.status}: ${article}`);
  const json = (await res.json()) as { parse?: { text?: { '*'?: string } } };
  const html = json.parse?.text?.['*'];
  if (!html) throw new Error(`Wikipedia: no text returned for ${article}`);
  return html;
}

type RawRow = {
  country: string;
  name: string;
  operator: string | null;
  capacityBpd: number | null;
  locationText: string | null;
  notes: string | null;
};

/**
 * Walk the article DOM, group rows by H2 section. For each H2 whose
 * text we can map to ISO-2, scan forward for tables until the next H2
 * and extract refinery rows.
 *
 * `defaultCountry` is used by sub-article callers ("List of oil
 * refineries in India") whose H2s are usually section names like
 * "Operating refineries" rather than country names — without a default,
 * those tables would be skipped because currentCountry never gets set.
 */
function extractRefineriesFromHtml(
  html: string,
  defaultCountry: string | null = null,
): RawRow[] {
  const $ = cheerio.load(html);
  const out: RawRow[] = [];

  // Iterate over all H2s and tables in document order. Modern Wikipedia
  // wraps H2 in <div class="mw-heading mw-heading2"><h2>...</h2></div>;
  // older articles have bare <h2>. Find all of them via .find() and
  // sort by document position so we process them in render order.
  const heads = $('h2');
  const tables = $('table.wikitable');
  if (heads.length === 0 && tables.length === 0) return out;

  // Build a single ordered list of {kind, $node, position} where position
  // is determined by walking the DOM in tree order. cheerio doesn't
  // expose document position directly, so we use compareDocumentPosition-
  // equivalent logic via index in a flat list of all candidates.
  type Item = { kind: 'h2' | 'table'; el: unknown };
  const items: Item[] = [];
  $('h2, table.wikitable').each((_i, el) => {
    const tag = (el as { tagName?: string }).tagName?.toLowerCase();
    if (tag === 'h2') items.push({ kind: 'h2', el });
    else if (tag === 'table') items.push({ kind: 'table', el });
  });

  let currentCountry: string | null = defaultCountry;

  for (const item of items) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const $node = $(item.el as any);
    if (item.kind === 'h2') {
      // Heading text — try .mw-headline (older), then the h2's own text.
      const heading =
        $node.find('.mw-headline').first().text().trim() ||
        $node.text().trim();
      // Strip "[edit]" trailing text that some Wikipedia HTML includes
      const cleaned = heading.replace(/\[edit\]\s*$/i, '').trim();
      const mapped = nameToIso2(cleaned);
      // On sub-articles ("List of oil refineries in India"), section
      // headings like "Operating refineries" don't map. Fall back to
      // the article-level default rather than losing the country.
      currentCountry = mapped ?? defaultCountry;
      continue;
    }

    if (!currentCountry) continue;

    const headers: string[] = [];
    $node
      .find('tr')
      .first()
      .find('th')
      .each((_j, th) => {
        headers.push($(th).text().trim().toLowerCase());
      });

    const colIdx = (...candidates: string[]): number => {
      for (let i = 0; i < headers.length; i += 1) {
        for (const cand of candidates) {
          if (headers[i]!.includes(cand)) return i;
        }
      }
      return -1;
    };

    const nameCol = colIdx('refinery', 'name');
    const operatorCol = colIdx('operator', 'owner', 'company');
    const capacityCol = colIdx('capacity', 'bbl', 'bpd');
    const locationCol = colIdx('location', 'city', 'place', 'state', 'province');
    const notesCol = colIdx('note', 'remark', 'status');

    if (nameCol < 0) continue;

    $node.find('tr').slice(1).each((_j, tr) => {
      const cells = $(tr).find('td');
      if (cells.length === 0) return;
      const get = (i: number) =>
        i >= 0 && i < cells.length ? $(cells.get(i)!).text().trim() : '';
      const name = get(nameCol).replace(/\[[^\]]*\]/g, '').trim();
      if (!name) return;
      const operator = get(operatorCol).replace(/\[[^\]]*\]/g, '').trim() || null;
      const capacityBpd = parseCapacityBpd(get(capacityCol));
      const locationText = get(locationCol) || null;
      const notes = get(notesCol) || null;

      out.push({
        country: currentCountry!,
        name,
        operator,
        capacityBpd,
        locationText,
        notes,
      });
    });
  }

  return out;
}

/**
 * Master article links to per-country sub-articles via "Main article:"
 * hatnotes. Use the query API's links endpoint with pllimit=max
 * (=500) and paginate via plcontinue — action=parse&prop=links is
 * capped at the default 10 and won't surface the long tail.
 */
async function findSubArticles(): Promise<string[]> {
  const titles: string[] = [];
  let plcontinue: string | null = null;
  // Cap pages to keep this from running away if Wikipedia restructures.
  for (let page = 0; page < 20; page += 1) {
    const params = new URLSearchParams({
      action: 'query',
      format: 'json',
      titles: MASTER_ARTICLE.replace(/_/g, ' '),
      prop: 'links',
      pllimit: 'max',
      redirects: '1',
    });
    if (plcontinue) params.set('plcontinue', plcontinue);
    const res = await fetch(`${WIKI_API}?${params}`, { headers: HEADERS });
    if (!res.ok) break;
    const json = (await res.json()) as {
      query?: {
        pages?: Record<
          string,
          { links?: Array<{ ns: number; title: string }> }
        >;
      };
      continue?: { plcontinue?: string };
    };
    const pages = json.query?.pages ?? {};
    for (const p of Object.values(pages)) {
      for (const l of p.links ?? []) {
        if (l.ns === 0) titles.push(l.title);
      }
    }
    plcontinue = json.continue?.plcontinue ?? null;
    if (!plcontinue) break;
  }
  return titles.filter((t) => /^List of oil refineries in /i.test(t));
}

/**
 * "List of oil refineries in the United States" → "US".
 * Returns null if the country fragment isn't in our ISO map.
 */
function countryFromSubArticleTitle(title: string): string | null {
  const m = title.match(/^List of oil refineries in (.+)$/i);
  if (!m) return null;
  const fragment = m[1]!.replace(/^the\s+/i, '').trim();
  return nameToIso2(fragment);
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');

  const args = process.argv.slice(2);
  const includeSubArticles = args.includes('--include-sub-articles');

  console.log(`Fetching ${MASTER_ARTICLE}...`);
  const masterHtml = await fetchArticleHtml(MASTER_ARTICLE);
  let rawRows = extractRefineriesFromHtml(masterHtml);
  console.log(`  ${rawRows.length} rows from master article`);

  if (includeSubArticles) {
    const subArticles = await findSubArticles();
    console.log(`  Found ${subArticles.length} per-country sub-articles`);
    for (const sub of subArticles) {
      try {
        const html = await fetchArticleHtml(sub.replace(/ /g, '_'));
        // Sub-article H2s are usually section names ("Operating refineries")
        // not country names. Pass the country derived from the title so all
        // tables in the article inherit it.
        const subCountry = countryFromSubArticleTitle(sub);
        const rows = extractRefineriesFromHtml(html, subCountry);
        const countryLabel = subCountry ?? '?';
        console.log(`    ${sub} [${countryLabel}]: ${rows.length} rows`);
        rawRows.push(...rows);
        // Be polite to Wikipedia — small delay between sub-article fetches
        await new Promise((r) => setTimeout(r, 500));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`    ${sub}: failed (${msg})`);
      }
    }
    console.log(`  Total after sub-articles: ${rawRows.length}`);
  }

  const client = neon(url);
  const db = drizzle(client, { schema, casing: 'snake_case' });

  let inserted = 0;
  let merged = 0;
  for (const r of rawRows) {
    const noteParts: string[] = [];
    if (r.operator) noteParts.push(`Operator: ${r.operator}`);
    if (r.capacityBpd) noteParts.push(`Capacity: ${r.capacityBpd.toLocaleString()} bpd`);
    if (r.locationText) noteParts.push(`Location: ${r.locationText}`);
    if (r.notes) noteParts.push(`Notes: ${r.notes}`);
    noteParts.push('Source: Wikipedia');

    const tags = ['refinery', 'source:wikipedia'];
    if (r.capacityBpd != null) {
      if (r.capacityBpd >= 400_000) tags.push('size:mega');
      else if (r.capacityBpd >= 200_000) tags.push('size:large');
      else if (r.capacityBpd >= 100_000) tags.push('size:mid');
      else tags.push('size:small');
    }
    const med = ['IT', 'ES', 'FR', 'GR', 'TR', 'CY', 'MT', 'HR', 'SI', 'AL'];
    if (med.includes(r.country)) tags.push('region:mediterranean');

    const result = await findOrUpsertEntity(db, {
      slug: slugify(r.name, r.country),
      // Wikipedia ranks below curated/gem/wikidata in source priority
      // (osm tier in the helper) — sufficient for "fill missing fields"
      // semantics. Map to 'osm' since it's the same precedence.
      source: 'osm',
      name: r.name,
      country: r.country,
      role: 'refiner',
      categories: ['crude-oil', 'diesel', 'gasoline', 'jet-fuel'],
      notes: noteParts.join(' · '),
      aliases: [r.name],
      tags,
      latitude: null,
      longitude: null,
      metadata: {
        operator: r.operator,
        capacity_bpd: r.capacityBpd,
        location_text: r.locationText,
        wikipedia_source: 'List_of_oil_refineries',
      },
    });
    if (result.outcome === 'inserted') inserted += 1;
    else merged += 1;
  }

  console.log(`Done. inserted=${inserted}, merged=${merged} (enriched existing rows).`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
