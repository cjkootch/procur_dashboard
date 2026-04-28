/**
 * CanadaBuys — Canadian federal government procurement.
 *
 * Portal:   https://canadabuys.canada.ca
 * Feed:     openTenderNotice-ouvertAvisAppelOffres.csv (5-6 MB, daily)
 * Auth:     None — public open data
 *
 * The CSV contains every active open tender from PSPC + dozens of
 * federal agencies (DND, CFIA, AAFC, NRCan, RCMP, etc). Bilingual
 * columns; we read the English variants. Full descriptions inline so
 * no second-pass description fetch needed (unlike SAM).
 *
 * Filtered to GSIN prefixes matching VTC's commodity categories. GSIN
 * (Goods and Services Identification Number) is Canada's procurement
 * classification — same numbering scheme as US PSC codes, so the
 * prefix lists mirror what we use for SAM:
 *
 *   89xx  Subsistence (food)
 *   91xx  Fuels and lubricants
 *   23xx  Vehicles
 *   96xx  Ores and minerals
 *
 * In addition we accept any row where `procurementCategory` is *GOOD
 * (Goods) and the gsinDescription text matches our category keywords —
 * catches rows that have a missing or off-spec GSIN code but are
 * clearly food/fuel/vehicle/mineral procurements.
 *
 * v1 covers Open tenders only. Award notices come via a separate
 * dataset (TBD) and would need a second scraper pass.
 */
import { Buffer } from 'node:buffer';
import { parse as parseCsv } from 'csv-parse/sync';
import {
  TenderScraper,
  classifyVtcCategory,
  fetchWithRetry,
  type NormalizedOpportunity,
  type RawOpportunity,
  type ScrapedDocument,
} from '@procur/scrapers-core';
import { log } from '@procur/utils/logger';

const CSV_URL =
  'https://canadabuys.canada.ca/opendata/pub/openTenderNotice-ouvertAvisAppelOffres.csv';
const PORTAL = 'https://canadabuys.canada.ca';

const HEADERS: Record<string, string> = {
  accept: 'text/csv,application/octet-stream',
  'user-agent': 'procur-scraper/1.0 (+https://discover.procur.app)',
};

/**
 * Subset of the CanadaBuys CSV columns we care about. The CSV has
 * ~70 columns of bilingual fields; we only read what maps onto
 * NormalizedOpportunity. Field names exactly match the CSV header
 * (which is itself bilingual `english-french-suffix`).
 */
type CanadaCsvRow = {
  'title-titre-eng': string;
  'referenceNumber-numeroReference': string;
  'amendmentNumber-numeroModification': string;
  'solicitationNumber-numeroSollicitation': string;
  'publicationDate-datePublication': string;
  'tenderClosingDate-appelOffresDateCloture': string;
  'expectedContractStartDate-dateDebutContratPrevue': string;
  'expectedContractEndDate-dateFinContratPrevue': string;
  'tenderStatus-appelOffresStatut-eng': string;
  'gsin-nibs': string;
  'gsinDescription-nibsDescription-eng': string;
  unspsc: string;
  'unspscDescription-eng': string;
  'procurementCategory-categorieApprovisionnement': string;
  'noticeType-avisType-eng': string;
  'procurementMethod-methodeApprovisionnement-eng': string;
  'tradeAgreements-accordsCommerciaux-eng': string;
  'regionsOfOpportunity-regionAppelOffres-eng': string;
  'regionsOfDelivery-regionsLivraison-eng': string;
  'contractingEntityName-nomEntitContractante-eng': string;
  'contactInfoName-informationsContactNom': string;
  'contactInfoEmail-informationsContactCourriel': string;
  'noticeURL-URLavis-eng': string;
  'attachment-piecesJointes-eng': string;
  'tenderDescription-descriptionAppelOffres-eng': string;
};

type CanadaInput = {
  /** Override the URL (test harnesses). Defaults to live CanadaBuys feed. */
  csvUrl?: string;
  /** Pre-fetched CSV text (test fixtures). Skips the HTTP fetch entirely. */
  fixtureCsv?: string;
  /**
   * Disable the VTC-keyword filter and ingest every Goods row instead.
   * Useful for one-off backfills when we want the full goods catalog
   * regardless of category. Caps out ~250 rows per CSV refresh.
   */
  allGoods?: boolean;
};

export class CanadaBuysScraper extends TenderScraper {
  readonly jurisdictionSlug = 'canada-federal';
  readonly sourceName = 'canada-buys';
  readonly portalUrl = PORTAL;

  constructor(private readonly input: CanadaInput = {}) {
    super();
  }

  async fetch(): Promise<RawOpportunity[]> {
    const csv = this.input.fixtureCsv ?? (await this.downloadCsv());
    const rows = parseCsv(csv, {
      columns: true,
      bom: true,
      trim: true,
      skip_empty_lines: true,
      // Some rows have stray quotes in trade-agreements lists; relax_quotes
      // makes the parser tolerant rather than aborting on the whole file.
      relax_quotes: true,
      relax_column_count: true,
    }) as CanadaCsvRow[];

    log.info('canada.csv.parsed', { totalRows: rows.length });

    const out: RawOpportunity[] = [];
    let goodsRows = 0;
    let skippedCancelled = 0;

    for (const row of rows) {
      // Status filter — CSV is ostensibly "open" only but defensive anyway.
      const status = (row['tenderStatus-appelOffresStatut-eng'] ?? '').toLowerCase();
      if (status === 'cancelled') {
        skippedCancelled += 1;
        continue;
      }

      // Primary filter: procurementCategory must indicate Goods. CanadaBuys
      // emits codes `*GD` (Goods), `*SRV` (Services), `*CNST` (Construction),
      // and combos like `*GD\n*SRV` for mixed lots. We match the substring
      // "GD" anywhere in the field.
      const category = row['procurementCategory-categorieApprovisionnement'] ?? '';
      if (!/\bGD\b|\*GD/i.test(category)) continue;
      goodsRows += 1;

      // Secondary filter: keyword match in title or structured GSIN desc.
      // Skip the 1-2k tender description body — too noisy for substring
      // matching even with word boundaries. allGoods=true bypasses this
      // for occasional full-catalog runs.
      const haystack = `${row['title-titre-eng'] ?? ''} ${row['gsinDescription-nibsDescription-eng'] ?? ''}`;
      const vtcCategory = classifyVtcCategory(haystack);
      if (!this.input.allGoods && !vtcCategory) continue;

      const noticeUrl = (row['noticeURL-URLavis-eng'] ?? '').trim();
      const ref = (row['referenceNumber-numeroReference'] ?? '').trim();
      const sourceReferenceId = ref ? `CABUYS-${ref}` : `CABUYS-${noticeUrl}`;

      // Stash the resolved category on the row so parse() can emit it
      // without re-running the regexes. Uses a non-CSV-clashing key
      // prefixed `_` to make intent obvious.
      const enriched = {
        ...row,
        _vtcCategory: vtcCategory ?? '',
      };

      out.push({
        sourceReferenceId,
        sourceUrl: noticeUrl || PORTAL,
        rawData: enriched as unknown as Record<string, unknown>,
      });
    }

    log.info('canada.fetch.filtered', {
      total: rows.length,
      goodsRows,
      kept: out.length,
      skippedCancelled,
      mode: this.input.allGoods ? 'all-goods' : 'vtc-keywords',
    });
    return out;
  }

  private async downloadCsv(): Promise<string> {
    const url = this.input.csvUrl ?? CSV_URL;
    const res = await fetchWithRetry(url, {
      method: 'GET',
      headers: HEADERS,
      timeoutMs: 120_000,
      retryableStatuses: [408, 429, 500, 502, 503, 504],
    });
    if (!res.ok) {
      throw new Error(`CanadaBuys CSV download failed: ${res.status}`);
    }
    const buf = await res.arrayBuffer();
    // CSV is UTF-8 with BOM (already handled by csv-parse `bom: true`).
    return Buffer.from(buf).toString('utf-8');
  }

  async parse(raw: RawOpportunity): Promise<NormalizedOpportunity | null> {
    const r = raw.rawData as unknown as CanadaCsvRow & { _vtcCategory?: string };
    const title = (r['title-titre-eng'] ?? '').trim();
    if (!title) return null;

    const description = synthesizeDescription(r);
    const status = mapStatus(r['tenderStatus-appelOffresStatut-eng']);

    const documents = parseAttachments(r['attachment-piecesJointes-eng']);

    // Region of delivery often signals beneficiary geography for OCONUS
    // procurements (e.g., "International" or specific country). For now
    // we leave beneficiaryCountry null and surface the region in the
    // description — when we see a real distribution of foreign rows
    // we can add country detection like SAM does.

    // VTC commodity bucket: classified at fetch time and stashed on
    // rawData so parse() doesn't re-run regexes. Empty when allGoods
    // override pulled in a row that didn't match any keyword bucket.
    const category = r._vtcCategory && r._vtcCategory.length > 0 ? r._vtcCategory : undefined;

    return {
      sourceReferenceId: raw.sourceReferenceId,
      sourceUrl: raw.sourceUrl,
      title: title.slice(0, 500),
      description,
      referenceNumber: r['solicitationNumber-numeroSollicitation'] || r['referenceNumber-numeroReference'],
      type: r['noticeType-avisType-eng'],
      agencyName: r['contractingEntityName-nomEntitContractante-eng'] || undefined,
      category,
      currency: 'CAD',
      publishedAt: parseDate(r['publicationDate-datePublication']),
      deadlineAt: parseDate(r['tenderClosingDate-appelOffresDateCloture']),
      language: 'en',
      status,
      rawContent: r as unknown as Record<string, unknown>,
      documents,
    };
  }
}

/**
 * Combine the inline tender description with structured filter / region
 * metadata. The CSV's `tenderDescription-eng` is usually the most
 * substantive text in the row (200-2000 chars); we prepend a short
 * structured prefix for fast scanning + AI categorization.
 */
function synthesizeDescription(r: CanadaCsvRow): string | undefined {
  const lines: string[] = [];

  const gsin = r['gsin-nibs'];
  const gsinDesc = r['gsinDescription-nibsDescription-eng'];
  if (gsin || gsinDesc) {
    lines.push(`GSIN: ${[gsin, gsinDesc].filter(Boolean).join(' — ')}`);
  }

  const unspsc = r.unspsc;
  const unspscDesc = r['unspscDescription-eng'];
  if (unspsc || unspscDesc) {
    lines.push(`UNSPSC: ${[unspsc, unspscDesc].filter(Boolean).join(' — ')}`);
  }

  if (r['procurementMethod-methodeApprovisionnement-eng']) {
    lines.push(`Method: ${r['procurementMethod-methodeApprovisionnement-eng']}`);
  }

  if (r['regionsOfDelivery-regionsLivraison-eng']) {
    lines.push(`Region of delivery: ${r['regionsOfDelivery-regionsLivraison-eng']}`);
  }

  const inline = (r['tenderDescription-descriptionAppelOffres-eng'] ?? '').trim();
  if (inline) {
    lines.push('');
    lines.push(inline);
  }

  return lines.length > 0 ? lines.join('\n') : undefined;
}

/**
 * The `attachment-piecesJointes-eng` column is sometimes empty, sometimes
 * a single URL, sometimes a comma- or newline-separated list. Best-effort
 * split + URL filter keeps malformed cells from poisoning the row.
 */
function parseAttachments(s: string | undefined): ScrapedDocument[] | undefined {
  if (!s || s.trim().length === 0) return undefined;
  const candidates = s
    .split(/[\s,]+/)
    .map((u) => u.trim())
    .filter((u) => /^https?:\/\//i.test(u));
  if (candidates.length === 0) return undefined;
  return candidates.map((url, i) => ({
    originalUrl: url,
    documentType: 'attachment',
    title: `Attachment ${i + 1}`,
  }));
}

/**
 * Map CanadaBuys status text to our lifecycle enum. The CSV also has
 * "Awarded" rows in the broader feed (this one is open-only) so we
 * handle them defensively for forward-compat.
 */
function mapStatus(
  raw: string | undefined,
): NormalizedOpportunity['status'] {
  const s = (raw ?? '').toLowerCase();
  if (s.includes('award')) return 'awarded';
  if (s.includes('cancel')) return 'cancelled';
  if (s.includes('close')) return 'closed';
  return 'active';
}

/**
 * Parse CanadaBuys date columns. Two shapes show up:
 *   "2026-01-23"               (date-only — publication, contract dates)
 *   "2029-03-31T13:00:00"      (date+time, no timezone — assume Eastern)
 * Both parse cleanly via the Date ctor. The naive-time variant gets
 * Eastern (-05:00 in winter, -04:00 in DST), close enough for "closes on"
 * display without timezone jitter for users in CA/US.
 */
function parseDate(s: string | undefined): Date | undefined {
  if (!s || s.trim().length === 0) return undefined;
  const trimmed = s.trim();
  // If it has a T but no Z/offset, assume Eastern. Append -04:00 (DST)
  // as an approximation — bidirectional drift is at most 1h.
  const normalized =
    trimmed.includes('T') && !/[Z+\-]\d{2}:?\d{2}$/.test(trimmed)
      ? `${trimmed}-04:00`
      : trimmed;
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? undefined : d;
}
