/**
 * Jamaica GOJEP awards extractor.
 *
 * Source: https://www.gojep.gov.jm publishes contract-award notices on
 * the Award Notices surface. Each notice is a PDF; the awardee name +
 * CPV codes + contract price live inside the PDF, not the search HTML.
 *
 * This extractor is the TS port of `scripts/scrapers/caribbean_fuel/
 * gojep_scraper.py`. The Python script proved the parsing rules; this
 * version wires them into the production AwardsExtractor pipeline.
 *
 * Workflow per run:
 *  1. Page through /epps/viewCaNotices.do for each fuel keyword.
 *  2. Dedupe by resourceId (same award appears under multiple keywords).
 *  3. For each resourceId, download the contract-award PDF and extract
 *     text via unpdf.
 *  4. Regex out awardee + CPV codes + contract price + currency + date.
 *  5. Apply the title/CPV is_fuel_supply filter.
 *  6. Map to NormalizedAward and yield.
 *
 * Volume is small — ~19 fuel-supply awards in the Python sample. The
 * cron lives at monthly cadence to give GOJEP time to publish the
 * prior month's award PDFs.
 */
import { extractText, getDocumentProxy } from 'unpdf';
import {
  AwardsExtractor,
  classifyAwardByUnspsc,
  convertToUsd,
  loadHtml,
  textOf,
  fetchWithRetry,
  type NormalizedAward,
} from '@procur/scrapers-core';

const PORTAL = 'gojep_jm';
const BASE = 'https://www.gojep.gov.jm';
const SEARCH_PATH = '/epps/viewCaNotices.do';

const FUEL_KEYWORDS = [
  'fuel',
  'diesel',
  'petroleum',
  'gasoline',
  'gasoil',
  'kerosene',
  'bunker',
  'LPG',
  'liquid petroleum',
  'ULSD',
] as const;

/**
 * CPV codes that indicate actual fuel supply (vs equipment/services).
 * Mirrors the FUEL_CPV_CODES set in gojep_scraper.py.
 */
const FUEL_CPV_CODES = new Set<string>([
  '09000000', '09100000', '09110000', '09120000', '09122000', '09122100',
  '09122110', '09130000', '09131000', '09131100', '09132000', '09132100',
  '09132200', '09133000', '09134000', '09134100', '09134200', '09134210',
  '09134220', '09134230', '09134231', '09134232', '09135000', '09135100',
  '09135110', '09140000', '09200000', '09210000', '09230000', '09240000',
  '09241000', '09242000', '09243000',
]);

/**
 * CPV → supplier-graph category tag mapping. CPV is the EU-style
 * Common Procurement Vocabulary; GOJEP uses it instead of UNSPSC.
 * Ranges chosen for high-confidence direct mapping; ambiguous codes
 * are deliberately left unmapped to avoid false positives.
 */
function classifyCpvCodes(codes: readonly string[]): string[] {
  const tags = new Set<string>();
  for (const code of codes) {
    if (code.startsWith('09134')) tags.add('diesel');
    else if (code.startsWith('09132')) tags.add('gasoline');
    else if (code.startsWith('09131')) tags.add('jet-fuel');
    else if (code.startsWith('09133') || code === '09122000' || code === '09122100' || code === '09122110')
      tags.add('lpg');
    else if (code === '09135100' || code === '09135110') tags.add('heating-oil');
    else if (code === '09135000') tags.add('heavy-fuel-oil');
    else if (code === '09230000') tags.add('crude-oil');
    else if (code.startsWith('091') || code.startsWith('092')) tags.add('heavy-fuel-oil');
  }
  return Array.from(tags);
}

const EXCLUDE_PHRASES = [
  'generator', 'filter housing', 'hose', 'fitting', 'pipeline',
  'rehabilitation', 'inspection', 'bunker gear', 'bunker boots',
  'bunkers hill', 'testing', 'color dye', 'coloring dye', 'id dyes',
  'audit', 'sampling bucket', 'calibration', 'training', 'lubricant',
  'lube', 'construction', 'tank construction', 'labour for terminal',
];

const SUPPLY_PHRASES = [
  'supply of', 'supply and delivery', 'delivery of',
  'procurement of fuel', 'procurement of diesel', 'procurement of gasoline',
  'procurement of petroleum', 'procurement of liquid petroleum',
  'procurement of diesel oil', 'supply, delivery', 'purchase of',
  'framework: purchase',
];

function isFuelSupply(title: string, cpv: string[]): boolean {
  const t = title.toLowerCase();
  const hasFuelCpv = cpv.some((c) => FUEL_CPV_CODES.has(c));
  if (EXCLUDE_PHRASES.some((p) => t.includes(p))) {
    return hasFuelCpv;
  }
  if (SUPPLY_PHRASES.some((p) => t.includes(p))) return true;
  return hasFuelCpv;
}

type SearchRow = {
  resourceId: string;
  title: string;
  buyer: string;
  valueRaw: string;
  dateRaw: string;
  pdfUrl: string | null;
};

type ParsedPdf = {
  awardee?: string;
  cpvCodes: string[];
  contractPrice?: number;
  currency?: string;
  awardDate?: string;
};

export type GojepAwardsExtractorOptions = {
  /** Cap pages per keyword (safety). Default 20. */
  maxPagesPerKeyword?: number;
  /** Cap concurrent PDF fetches (server is rate-sensitive). Default 2. */
  pdfConcurrency?: number;
};

export class JamaicaGojepAwardsExtractor extends AwardsExtractor {
  readonly jurisdictionSlug = 'jamaica';
  readonly sourcePortal = PORTAL;

  constructor(private readonly options: GojepAwardsExtractorOptions = {}) {
    super();
  }

  async *streamAwards(): AsyncIterable<NormalizedAward> {
    const seen = new Map<string, SearchRow>();

    for (const keyword of FUEL_KEYWORDS) {
      const maxPages = this.options.maxPagesPerKeyword ?? 20;
      for (let page = 1; page <= maxPages; page += 1) {
        const url = `${BASE}${SEARCH_PATH}?cftTitle=${encodeURIComponent(keyword)}&d-16531-p=${page}`;
        let html: string;
        try {
          const res = await fetchWithRetry(url);
          html = await res.text();
        } catch {
          break;
        }
        const rows = parseSearchRows(html);
        if (rows.length === 0) break;
        for (const r of rows) seen.set(r.resourceId, r);
        if (rows.length < 10) break;
      }
    }

    for (const row of seen.values()) {
      if (!row.pdfUrl) continue;
      let parsed: ParsedPdf;
      try {
        parsed = await downloadAndParsePdf(row.pdfUrl);
      } catch {
        continue;
      }
      if (!parsed.awardee) continue;
      if (!isFuelSupply(row.title, parsed.cpvCodes)) continue;

      // Prefer CPV-derived tags; fall back to the UNSPSC classifier
      // (won't match anything for CPV-only data, but keeps the function
      // composable when other portals send mixed schemes).
      const cpvTags = classifyCpvCodes(parsed.cpvCodes);
      const tags = cpvTags.length > 0 ? cpvTags : classifyAwardByUnspsc([]);
      if (tags.length === 0) continue;

      const awardDate = normalizeDate(parsed.awardDate ?? row.dateRaw);
      const native = parsed.contractPrice ?? null;
      const currency = (parsed.currency ?? 'JMD').toUpperCase();

      yield {
        award: {
          sourcePortal: PORTAL,
          sourceAwardId: row.resourceId,
          sourceUrl: row.pdfUrl,
          rawPayload: {
            resource_id: row.resourceId,
            keyword_match: row.title,
            cpv_codes: parsed.cpvCodes,
          },
          buyerName: row.buyer || 'UNKNOWN',
          buyerCountry: 'JM',
          title: row.title,
          commodityDescription: row.title,
          cpvCodes: parsed.cpvCodes,
          categoryTags: tags,
          contractValueNative: native,
          contractCurrency: currency,
          contractValueUsd: convertToUsd(native, currency, awardDate),
          awardDate,
          status: 'active',
        },
        awardees: [
          {
            supplier: {
              sourcePortal: PORTAL,
              sourceReferenceId: `${PORTAL}::name::${parsed.awardee}`,
              organisationName: parsed.awardee,
              country: 'JM',
            },
            role: 'prime',
            aliases: [parsed.awardee],
          },
        ],
      };
    }
  }
}

// ─── Parsing helpers ─────────────────────────────────────────────────

function parseSearchRows(html: string): SearchRow[] {
  const $ = loadHtml(html);
  const out: SearchRow[] = [];
  $('tr').each((_i, tr) => {
    const $tr = $(tr);
    const titleLink = $tr.find('a[href*="prepareViewCfTWS.do"]').first();
    const href = titleLink.attr('href');
    if (!href) return;
    const m = href.match(/resourceId=(\d+)/);
    if (!m?.[1]) return;
    const resourceId = m[1];

    const cells = $tr.find('td');
    if (cells.length < 6) return;

    const pdfLink = $tr.find('a[href*="downloadNoticeForES.do"]').first();
    const pdfHref = pdfLink.attr('href');

    out.push({
      resourceId,
      title: textOf(titleLink),
      buyer: textOf(cells.eq(2)),
      valueRaw: textOf(cells.eq(4)),
      dateRaw: textOf(cells.eq(5)),
      pdfUrl: pdfHref ? `${BASE}${pdfHref.replace(/&amp;/g, '&')}` : null,
    });
  });
  return out;
}

async function downloadAndParsePdf(url: string): Promise<ParsedPdf> {
  const res = await fetchWithRetry(url);
  const buffer = new Uint8Array(await res.arrayBuffer());
  if (buffer.length < 4 || buffer[0] !== 0x25 || buffer[1] !== 0x50) {
    // Not a PDF — return empty.
    return { cpvCodes: [] };
  }
  const pdf = await getDocumentProxy(buffer);
  const { text: pages } = await extractText(pdf, { mergePages: true });
  const text = Array.isArray(pages) ? pages.join('\n') : (pages as unknown as string);
  return parsePdfText(text);
}

export function parsePdfText(text: string): ParsedPdf {
  const out: ParsedPdf = { cpvCodes: [] };

  // Awardee — appears after "Name of contractor (1)" then on next non-empty line
  const awardeeMatch = text.match(/Name of contractor[^\n]*\n\s*([^\n]+)/i);
  if (awardeeMatch?.[1]) out.awardee = awardeeMatch[1].trim();

  // CPV codes — 8-digit code optionally followed by hyphen + description
  const cpvMatches = Array.from(text.matchAll(/(\d{8})-[A-Za-z]/g));
  out.cpvCodes = Array.from(new Set(cpvMatches.map((m) => m[1]).filter((c): c is string => Boolean(c))));

  // Contract price + currency (price line followed by "Currency: XXX")
  const priceMatch = text.match(/Contract price[^\n]*\n\s*([\d.,]+)\s+Currency:\s*(\w+)/i);
  if (priceMatch) {
    const cleaned = priceMatch[1]?.replace(/,/g, '');
    const n = cleaned ? Number.parseFloat(cleaned) : NaN;
    if (Number.isFinite(n)) out.contractPrice = n;
    out.currency = priceMatch[2]?.trim();
  }

  // Award date dd/MM/yyyy
  const dateMatch = text.match(/Contract award date\s*\n\s*Date:\s*(\d{1,2}\/\d{1,2}\/\d{4})/);
  if (dateMatch?.[1]) out.awardDate = dateMatch[1];

  return out;
}

function normalizeDate(input: string | undefined): string {
  if (!input) return new Date().toISOString().slice(0, 10);
  // dd/MM/yyyy → YYYY-MM-DD
  const m = input.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) {
    const day = m[1]!.padStart(2, '0');
    const month = m[2]!.padStart(2, '0');
    return `${m[3]}-${month}-${day}`;
  }
  // Already ISO?
  const iso = input.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso?.[1]) return iso[1];
  return new Date().toISOString().slice(0, 10);
}
