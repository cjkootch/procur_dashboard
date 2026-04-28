/**
 * UK Find a Tender Service (FTS) — UK federal procurement.
 *
 * Portal:   https://www.find-tender.service.gov.uk
 * API:      https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages
 *           (no auth required for OCDS endpoints)
 * Format:   OCDS 1.1 release packages
 *
 * Replaced OJEU/TED for UK after Brexit. Single English-language source,
 * cleaner schema than TED, but the API doesn't support server-side
 * classification filtering — we pull all releases in the date window
 * and filter client-side to:
 *   1. tag includes "tender" (active opportunities; planning/award/
 *      contract releases are downstream lifecycle events we currently
 *      ignore — their parent tender notice gets ingested separately)
 *   2. mainProcurementCategory = "goods" (excludes works + services)
 *   3. CPV prefix matches VTC commodity bucket OR keyword classifier hits
 *
 * UK uses the same CPV (Common Procurement Vocabulary) scheme as TED:
 *   15xxxxxx  Food, beverages, tobacco
 *   09xxxxxx  Petroleum products, fuel, electricity
 *   34xxxxxx  Transport equipment (vehicles)
 *   14xxxxxx  Mining, basic metals, related products
 *
 * Pagination is cursor-based via `links.next`. Max page size: 100.
 */
import {
  TenderScraper,
  classifyVtcCategory,
  fetchWithRetry,
  type NormalizedOpportunity,
  type RawOpportunity,
  type ScrapedDocument,
} from '@procur/scrapers-core';
import { log } from '@procur/utils/logger';

const API_BASE = 'https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages';
const PORTAL = 'https://www.find-tender.service.gov.uk';

const VTC_CPV_PREFIXES = ['15', '09', '34', '14'];

const HEADERS: Record<string, string> = {
  accept: 'application/json',
  'user-agent': 'procur-scraper/1.0 (+https://discover.procur.app)',
};

const MAX_PAGE_SIZE = 100;

type OcdsRelease = {
  ocid: string;
  id: string;
  date?: string;
  tag?: string[];
  language?: string;
  buyer?: { id?: string; name?: string };
  parties?: Array<{ id?: string; name?: string; roles?: string[] }>;
  tender?: {
    id?: string;
    title?: string;
    description?: string;
    status?: string;
    mainProcurementCategory?: 'goods' | 'services' | 'works';
    classification?: { scheme?: string; id?: string; description?: string };
    items?: Array<{
      classification?: { scheme?: string; id?: string };
      deliveryAddresses?: Array<{ country?: string; region?: string }>;
    }>;
    value?: { amount?: number; currency?: string };
    tenderPeriod?: { startDate?: string; endDate?: string };
    documents?: Array<{
      id?: string;
      documentType?: string;
      description?: string;
      url?: string;
      format?: string;
    }>;
    procurementMethod?: string;
    procurementMethodDetails?: string;
  };
  awards?: Array<{
    id?: string;
    status?: string;
    value?: { amount?: number; currency?: string };
    date?: string;
    suppliers?: Array<{ id?: string; name?: string }>;
  }>;
};

type OcdsResponsePackage = {
  uri?: string;
  publishedDate?: string;
  releases?: OcdsRelease[];
  links?: { next?: string; prev?: string };
};

type UkFtsInput = {
  postedWithinDays?: number;
  cpvPrefixes?: string[];
  /** Disable the goods-only filter; ingest services + works too. */
  includeServicesAndWorks?: boolean;
  /** Hard cap on cursor pages. Default 200 (200 × 100 = 20k cap). */
  maxPages?: number;
  fixture?: OcdsResponsePackage;
};

export class UkFtsScraper extends TenderScraper {
  readonly jurisdictionSlug = 'uk-fts';
  readonly sourceName = 'uk-fts';
  readonly portalUrl = PORTAL;

  constructor(private readonly input: UkFtsInput = {}) {
    super();
  }

  async fetch(): Promise<RawOpportunity[]> {
    if (this.input.fixture) {
      return this.parseReleases(this.input.fixture);
    }

    const days = this.input.postedWithinDays ?? 7;
    const since = isoDateOnly(daysAgo(days));
    const maxPages = this.input.maxPages ?? 200;

    const seenOcids = new Set<string>();
    const out: RawOpportunity[] = [];

    let url: string | undefined =
      `${API_BASE}?updatedFrom=${since}T00:00:00&limit=${MAX_PAGE_SIZE}`;
    let page = 0;

    while (url && page < maxPages) {
      const res = await fetchWithRetry(url, {
        method: 'GET',
        headers: HEADERS,
        timeoutMs: 60_000,
        retryableStatuses: [408, 429, 500, 502, 503, 504],
      });
      if (!res.ok) {
        const text = await res.text();
        log.error('uk-fts.search.http_error', {
          status: res.status,
          page,
          preview: text.slice(0, 400),
        });
        break;
      }

      const json = (await res.json()) as OcdsResponsePackage;
      const pageRows = this.parseReleases(json);

      let added = 0;
      for (const row of pageRows) {
        if (seenOcids.has(row.sourceReferenceId)) continue;
        seenOcids.add(row.sourceReferenceId);
        out.push(row);
        added += 1;
      }

      if (page === 0) {
        log.info('uk-fts.search.first_page', {
          rawReleases: json.releases?.length ?? 0,
          keptAfterFilter: pageRows.length,
        });
      }

      url = json.links?.next;
      page += 1;
      if (pageRows.length === 0 && page > 1) break;
    }

    log.info('uk-fts.fetch.done', { pages: page, kept: out.length });
    return out;
  }

  /**
   * Apply client-side filtering (tag/category/CPV/keyword) since the
   * UK FTS API doesn't support these as query params. One pass per
   * release; cheap.
   */
  private parseReleases(payload: OcdsResponsePackage): RawOpportunity[] {
    const out: RawOpportunity[] = [];
    const prefixes = this.input.cpvPrefixes ?? VTC_CPV_PREFIXES;
    const goodsOnly = !this.input.includeServicesAndWorks;

    for (const r of payload.releases ?? []) {
      // Lifecycle filter — only ingest ACTIVE tender notices. The UK
      // FTS feed bundles planning/award/contract/amendment events as
      // separate releases under the same OCID; their parent tender
      // gets ingested independently.
      const tags = r.tag ?? [];
      if (!tags.includes('tender')) continue;

      const t = r.tender;
      if (!t || !t.title) continue;

      // Category filter — VTC bids on goods, not services or works.
      // Override via includeServicesAndWorks for backfills.
      if (goodsOnly && t.mainProcurementCategory && t.mainProcurementCategory !== 'goods') {
        continue;
      }

      // CPV prefix OR keyword match. CPV is sparse in UK FTS data
      // (~15-20% of rows have it), so the keyword classifier carries
      // most rows.
      const allCpvs = collectCpvs(r);
      const cpvMatch = prefixes.length === 0
        || allCpvs.some((c) => prefixes.some((p) => c.startsWith(p)));
      const keywordMatch =
        !cpvMatch &&
        classifyVtcCategory(`${t.title} ${t.description ?? ''}`) != null;

      if (!cpvMatch && !keywordMatch) continue;

      out.push({
        sourceReferenceId: `UKFTS-${r.ocid}`,
        sourceUrl: noticeUrl(r),
        rawData: r as unknown as Record<string, unknown>,
      });
    }
    return out;
  }

  async parse(raw: RawOpportunity): Promise<NormalizedOpportunity | null> {
    const r = raw.rawData as unknown as OcdsRelease;
    const t = r.tender;
    if (!t?.title) return null;

    // Category: prefer CPV-driven mapping, fall back to keyword classifier.
    const allCpvs = collectCpvs(r);
    const cpvCategory = pickCategoryFromCpv(allCpvs);
    const category =
      cpvCategory ??
      classifyVtcCategory(`${t.title} ${t.description ?? ''}`) ??
      undefined;

    // Beneficiary country: default to UK; override when delivery
    // address country differs (Cyprus SBAs, Falklands, Gibraltar,
    // BIOT — UK MoD overseas operations).
    const deliveryCountries = (t.items ?? [])
      .flatMap((it) => it.deliveryAddresses ?? [])
      .map((a) => (a.country ?? '').toUpperCase())
      .filter((c) => c.length > 0);
    const nonUkDelivery = deliveryCountries.find((c) => c !== 'GB' && c !== 'UK');
    const beneficiaryCountry = nonUkDelivery
      ? iso2ToName(nonUkDelivery) ?? nonUkDelivery
      : 'United Kingdom';

    const documents: ScrapedDocument[] | undefined =
      t.documents && t.documents.length > 0
        ? t.documents
            .filter((d) => d.url)
            .map((d) => ({
              originalUrl: d.url!,
              documentType: d.documentType ?? 'attachment',
              title: d.description ?? d.documentType ?? 'Document',
            }))
        : undefined;

    const valueAmount = t.value?.amount;
    const valueEstimate = typeof valueAmount === 'number' ? valueAmount : undefined;

    const award = r.awards?.[0];

    return {
      sourceReferenceId: raw.sourceReferenceId,
      sourceUrl: raw.sourceUrl,
      title: t.title.slice(0, 500),
      description: t.description,
      referenceNumber: t.id,
      type: t.procurementMethodDetails ?? t.procurementMethod,
      agencyName: r.buyer?.name,
      category,
      currency: t.value?.currency ?? 'GBP',
      valueEstimate,
      publishedAt: parseIso(r.date),
      deadlineAt: parseIso(t.tenderPeriod?.endDate),
      deadlineTimezone: 'Europe/London',
      language: r.language ?? 'en',
      status: 'active',
      awardedAt: parseIso(award?.date),
      awardedAmount:
        typeof award?.value?.amount === 'number' ? award.value.amount : undefined,
      awardedToCompanyName: award?.suppliers?.[0]?.name,
      beneficiaryCountry,
      rawContent: r as unknown as Record<string, unknown>,
      documents,
    };
  }
}

/**
 * Pull every CPV-scheme classification id from a release — both the
 * tender-level `classification` and per-item classifications. Returns
 * a deduplicated array. UK FTS uses scheme="CPV" or "cpv" inconsistently
 * across notices.
 */
function collectCpvs(r: OcdsRelease): string[] {
  const out: string[] = [];
  const tc = r.tender?.classification;
  if (tc?.id && (tc.scheme ?? '').toUpperCase() === 'CPV') out.push(tc.id);
  for (const it of r.tender?.items ?? []) {
    const c = it.classification;
    if (c?.id && (c.scheme ?? '').toUpperCase() === 'CPV') out.push(c.id);
  }
  return Array.from(new Set(out));
}

/**
 * CPV prefix → VTC slug. Handles multi-CPV rows by majority vote so
 * an item with one stray vehicle code in a mostly-food order doesn't
 * mis-bucket. Same logic as TED.
 */
function pickCategoryFromCpv(cpvs: string[]): string | undefined {
  if (cpvs.length === 0) return undefined;
  const counts: Record<string, number> = {
    'food-commodities': 0,
    'petroleum-fuels': 0,
    'vehicles-fleet': 0,
    'minerals-metals': 0,
  };
  for (const code of cpvs) {
    const prefix = code.slice(0, 2);
    if (prefix === '15') counts['food-commodities']! += 1;
    else if (prefix === '09') counts['petroleum-fuels']! += 1;
    else if (prefix === '34') counts['vehicles-fleet']! += 1;
    else if (prefix === '14') counts['minerals-metals']! += 1;
  }
  const winner = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return winner && winner[1] > 0 ? winner[0] : undefined;
}

/**
 * Map ISO2 country codes (used in OCDS deliveryAddresses) to display
 * names. Limited to countries with UK overseas presence + common
 * humanitarian destinations; everything else falls back to the raw
 * code or the default 'United Kingdom'.
 */
const ISO2_TO_NAME: Record<string, string> = {
  CY: 'Cyprus',          // Sovereign Base Areas
  GI: 'Gibraltar',
  FK: 'Falkland Islands',
  IO: 'British Indian Ocean Territory', // Diego Garcia base
  BN: 'Brunei',
  KE: 'Kenya',           // BATUK training base
  AF: 'Afghanistan',
  IQ: 'Iraq',
  UA: 'Ukraine',
  EE: 'Estonia',         // NATO eFP
  PL: 'Poland',
  DE: 'Germany',
  FR: 'France',
  US: 'United States',
  CA: 'Canada',
  AU: 'Australia',
  NZ: 'New Zealand',
  IE: 'Ireland',
  IS: 'Iceland',
  NO: 'Norway',
  // Common Caribbean / VTC destinations
  JM: 'Jamaica',
  TT: 'Trinidad and Tobago',
  BB: 'Barbados',
  BS: 'Bahamas',
  GY: 'Guyana',
  HT: 'Haiti',
  DO: 'Dominican Republic',
};

function iso2ToName(code: string | undefined): string | undefined {
  if (!code) return undefined;
  return ISO2_TO_NAME[code.toUpperCase()];
}

/**
 * Build the canonical detail URL for a notice. UK FTS notices live at
 * /Notice/{noticeId} where noticeId is the release's `id` (e.g.,
 * "038257-2026"), NOT the OCID.
 */
function noticeUrl(r: OcdsRelease): string {
  return `${PORTAL}/Notice/${r.id}`;
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

/** YYYY-MM-DD form expected by UK FTS `updatedFrom` query param. */
function isoDateOnly(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function parseIso(s: string | undefined): Date | undefined {
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
}
