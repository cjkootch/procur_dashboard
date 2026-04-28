/**
 * Dominican Republic — DGCP awards extractor.
 *
 * Source: DGCP publishes OCDS bulk releases at
 *   https://data.open-contracting.org/en/publication/22
 * as per-year JSONL.gz files. Each line is one OCDS contracting
 * process (tender + awards[] + contracts[]). The full 2021-2026 corpus
 * is ~290MB compressed and contains ~5,964 fuel awards across 282
 * suppliers (per the caribbean_fuel master dataset).
 *
 * This extractor is the TS port of `scripts/scrapers/caribbean_fuel/
 * dr_extractor.py`. The Python script proved the parsing rules; this
 * version wires them into the production AwardsExtractor pipeline.
 *
 * Filtering — only emit awards that touch supplier-graph categories
 * we actively track (fuel + food + minerals/metals via the UNSPSC
 * classifier). Most DGCP awards are services / construction and we
 * deliberately do not materialize those rows in v1.
 *
 * Two ingest modes:
 *   - bulkFilePaths: local .jsonl.gz files (manual / dev runs)
 *   - bulkFileUrls:  remote OCDR URLs streamed via fetch + gunzip
 * If neither is provided, defaults to fetching the last 5 years from
 * the OCDR. Both can be passed simultaneously; files are processed in
 * order.
 */
import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import {
  AwardsExtractor,
  classifyAwardByUnspsc,
  hasFuelUnspsc,
  hasFoodUnspsc,
  type NormalizedAward,
} from '@procur/scrapers-core';
import {
  getDefaultLookbackYears,
  getDrDgcpYearUrl,
  streamRemoteJsonlGz,
} from './download';

const PORTAL = 'dr_dgcp_ocds';

type OcdsValue = { amount?: number | null; currency?: string | null } | null;
type OcdsClassification = { id?: string | number; scheme?: string } | null;
type OcdsItem = { classification?: OcdsClassification; quantity?: number | null; unit?: { value?: OcdsValue } | null } | null;

type OcdsParty = {
  id?: string;
  name?: string;
  roles?: string[];
  address?: { countryName?: string } | null;
} | null;

type OcdsAwardSupplier = { id?: string; name?: string } | null;

type OcdsAward = {
  id?: string;
  date?: string;
  status?: string;
  value?: OcdsValue;
  items?: OcdsItem[];
  suppliers?: OcdsAwardSupplier[];
} | null;

type OcdsContract = {
  awardID?: string;
  value?: OcdsValue;
} | null;

type OcdsRelease = {
  ocid?: string;
  buyer?: { id?: string; name?: string } | null;
  parties?: OcdsParty[];
  tender?: {
    id?: string;
    title?: string;
    description?: string;
    items?: OcdsItem[];
    value?: OcdsValue;
  } | null;
  awards?: OcdsAward[];
  contracts?: OcdsContract[];
};

export type DrDgcpExtractorOptions = {
  /** Local path(s) to OCDS bulk .jsonl.gz files. */
  bulkFilePaths?: string[];
  /** Remote URLs to OCDS bulk .jsonl.gz files. Streamed via fetch + gunzip
   *  (no on-disk caching). */
  bulkFileUrls?: string[];
  /** When neither bulkFilePaths nor bulkFileUrls is provided, fetch
   *  the most recent N years from the OCDR. Default 5. */
  yearsBack?: number;
  /** Filter to commodity classes worth materializing. Defaults to
   *  fuel + food. Pass ['all'] to materialize everything that the
   *  classifier emits any tag for. */
  categoryFilters?: Array<'fuel' | 'food' | 'all'>;
};

export class DrDgcpAwardsExtractor extends AwardsExtractor {
  readonly jurisdictionSlug = 'dominican-republic';
  readonly sourcePortal = PORTAL;

  constructor(private readonly options: DrDgcpExtractorOptions = {}) {
    super();
  }

  /**
   * Resolved list of remote URLs given the constructor options.
   * Exposed for inspection/logging — the actual streaming happens
   * inline in `streamAwards()`.
   */
  resolveUrls(): string[] {
    if (this.options.bulkFileUrls && this.options.bulkFileUrls.length > 0) {
      return [...this.options.bulkFileUrls];
    }
    if (
      (!this.options.bulkFilePaths || this.options.bulkFilePaths.length === 0) &&
      (!this.options.bulkFileUrls || this.options.bulkFileUrls.length === 0)
    ) {
      // Default: fetch last N years from OCDR.
      return getDefaultLookbackYears(this.options.yearsBack ?? 5).map(getDrDgcpYearUrl);
    }
    return [];
  }

  async *streamAwards(): AsyncIterable<NormalizedAward> {
    const filters = this.options.categoryFilters ?? ['fuel', 'food'];
    const matchAll = filters.includes('all');
    const wantFuel = matchAll || filters.includes('fuel');
    const wantFood = matchAll || filters.includes('food');

    const localPaths = this.options.bulkFilePaths ?? [];
    const remoteUrls = this.resolveUrls();

    if (localPaths.length === 0 && remoteUrls.length === 0) {
      throw new Error(
        'DrDgcpAwardsExtractor: no sources resolved (provide bulkFilePaths, bulkFileUrls, or rely on the default OCDR fetch).',
      );
    }

    // Local files first (deterministic for tests + dev runs), then remote.
    for (const path of localPaths) {
      yield* this.processStream(localFileLines(path), { wantFuel, wantFood, matchAll });
    }
    for (const url of remoteUrls) {
      try {
        yield* this.processStream(streamRemoteJsonlGz(url), { wantFuel, wantFood, matchAll });
      } catch (err) {
        // Tolerate missing per-year files (DGCP hasn't published yet,
        // or the URL pattern changed). Log via the run-level error
        // path; other URLs in the list still get processed.
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('HTTP 404')) {
          // 404 is expected for not-yet-published years; not a failure.
          continue;
        }
        throw err;
      }
    }
  }

  private async *processStream(
    lines: AsyncIterable<string>,
    flags: { wantFuel: boolean; wantFood: boolean; matchAll: boolean },
  ): AsyncIterable<NormalizedAward> {
    const { wantFuel, wantFood, matchAll } = flags;
    for await (const line of lines) {
      if (!line.trim()) continue;
      let release: OcdsRelease;
      try {
        release = JSON.parse(line) as OcdsRelease;
      } catch {
        // Malformed line — skip silently.
        continue;
      }
      const awards = release.awards ?? [];
      if (awards.length === 0) continue;

      const tenderItems = release.tender?.items ?? [];
      const tenderUnspscCodes = collectUnspsc(tenderItems);
      const tenderTouchesFuel = wantFuel && hasFuelUnspsc(tenderUnspscCodes);
      const tenderTouchesFood = wantFood && hasFoodUnspsc(tenderUnspscCodes);

      for (const award of awards) {
        if (!award) continue;
        const awardItems = award.items ?? [];
        const awardUnspscCodes = collectUnspsc(awardItems);
        const tags = classifyAwardByUnspsc(awardUnspscCodes);

        // Inheritance rule (mirrors the Python extractor): if the
        // award has no explicit items but the tender is predominantly
        // fuel/food, attribute the tender's tags to the award.
        let effectiveTags = tags;
        let effectiveCodes = awardUnspscCodes;
        if (effectiveTags.length === 0 && awardItems.length === 0) {
          const tenderClassifies =
            (tenderTouchesFuel || tenderTouchesFood) &&
            isPredominantlyTracked(tenderUnspscCodes);
          if (tenderClassifies) {
            effectiveTags = classifyAwardByUnspsc(tenderUnspscCodes);
            effectiveCodes = tenderUnspscCodes;
          }
        }

        if (effectiveTags.length === 0) continue;
        if (!matchAll) {
          const allowed = new Set<string>();
          if (wantFuel)
            ['diesel', 'gasoline', 'jet-fuel', 'lpg', 'marine-bunker', 'heating-oil', 'heavy-fuel-oil', 'crude-oil'].forEach((t) => allowed.add(t));
          if (wantFood) allowed.add('food-commodities');
          if (!effectiveTags.some((t) => allowed.has(t))) continue;
        }

        const buyer = resolveBuyer(release);
        if (!buyer.name) continue;

        const { value: contractValueNative, currency: contractCurrency } = resolveAwardValue(
          award,
          release.contracts ?? [],
        );

        const awardId = award.id;
        if (!awardId) continue;

        const awardees = collectAwardees(award);
        if (awardees.length === 0) continue;

        yield {
          award: {
            sourcePortal: PORTAL,
            sourceAwardId: awardId,
            sourceUrl: release.ocid
              ? `https://www.dgcp.gob.do/contratos/${release.ocid}`
              : null,
            rawPayload: { release_ocid: release.ocid, award_id: awardId },
            buyerName: buyer.name,
            buyerCountry: 'DO',
            title: release.tender?.title ?? null,
            commodityDescription:
              release.tender?.description ?? release.tender?.title ?? null,
            unspscCodes: effectiveCodes,
            categoryTags: effectiveTags,
            contractValueNative,
            contractCurrency: contractCurrency ?? 'DOP',
            contractValueUsd: null,
            awardDate: normalizeDate(award.date),
            status: mapAwardStatus(award.status),
          },
          awardees: awardees.map((a) => ({
            supplier: {
              sourcePortal: PORTAL,
              sourceReferenceId: a.id ?? `${PORTAL}::name::${a.name}`,
              organisationName: a.name,
              country: 'DO',
            },
            role: 'prime',
            aliases: [a.name],
          })),
        };
      }
    }
  }
}

async function* localFileLines(path: string): AsyncIterable<string> {
  const stream = createReadStream(path).pipe(createGunzip());
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim()) yield line;
  }
}

function collectUnspsc(items: OcdsItem[]): string[] {
  const out: string[] = [];
  for (const it of items) {
    const cl = it?.classification;
    if (!cl) continue;
    if (cl.scheme && String(cl.scheme).toUpperCase() !== 'UNSPSC') continue;
    if (cl.id == null) continue;
    out.push(String(cl.id));
  }
  return out;
}

function isPredominantlyTracked(codes: string[]): boolean {
  if (codes.length === 0) return false;
  const tracked = codes.filter((c) => hasFuelUnspsc([c]) || hasFoodUnspsc([c])).length;
  return tracked >= codes.length / 2;
}

function resolveBuyer(release: OcdsRelease): { name: string; id: string | null } {
  if (release.buyer?.name) {
    return { name: release.buyer.name, id: release.buyer.id ?? null };
  }
  for (const party of release.parties ?? []) {
    if (!party) continue;
    const roles = party.roles ?? [];
    if (roles.includes('buyer') || roles.includes('procuringEntity')) {
      if (party.name) return { name: party.name, id: party.id ?? null };
    }
  }
  return { name: '', id: null };
}

function resolveAwardValue(
  award: OcdsAward,
  contracts: OcdsContract[],
): { value: number | null; currency: string | null } {
  if (!award) return { value: null, currency: null };
  const direct = award.value;
  if (direct?.amount != null) return { value: direct.amount, currency: direct.currency ?? null };

  // Contract fallback
  for (const c of contracts) {
    if (!c) continue;
    if (c.awardID === award.id && c.value?.amount != null) {
      return { value: c.value.amount, currency: c.value.currency ?? null };
    }
  }

  // Sum of item line values
  if (award.items && award.items.length > 0) {
    let sum = 0;
    let currency: string | null = null;
    for (const it of award.items) {
      const unit = it?.unit?.value?.amount;
      const qty = it?.quantity;
      if (typeof unit === 'number' && typeof qty === 'number') {
        sum += unit * qty;
        currency = currency ?? (it?.unit?.value?.currency ?? null);
      }
    }
    if (sum > 0) return { value: sum, currency };
  }

  return { value: null, currency: null };
}

function collectAwardees(
  award: OcdsAward,
): Array<{ id: string | null; name: string }> {
  const out: Array<{ id: string | null; name: string }> = [];
  for (const sup of award?.suppliers ?? []) {
    if (!sup) continue;
    const name = (sup.name ?? '').trim().replace(/\t+$/, '');
    if (!name) continue;
    out.push({ id: sup.id ?? null, name });
  }
  return out;
}

function normalizeDate(input: string | undefined): string {
  if (!input) return new Date().toISOString().slice(0, 10);
  // OCDS dates are ISO-8601; just take the date portion.
  const m = input.match(/^(\d{4}-\d{2}-\d{2})/);
  return m?.[1] ?? new Date().toISOString().slice(0, 10);
}

function mapAwardStatus(status: string | undefined): string {
  // OCDS canonical: pending | active | cancelled | unsuccessful
  if (!status) return 'active';
  const s = status.toLowerCase();
  if (['active', 'cancelled', 'unsuccessful', 'pending'].includes(s)) return s;
  return 'active';
}
