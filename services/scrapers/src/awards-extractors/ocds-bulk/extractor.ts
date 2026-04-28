/**
 * Generic OCDS bulk awards extractor.
 *
 * Lifted from the DR DGCP extractor and parameterized so any
 * publisher on the OCP Data Registry (or any other OCDS-formatted
 * bulk JSONL.gz feed) can be ingested without writing new code.
 *
 * Configure with:
 *   - jurisdictionSlug ('mexico', 'colombia', etc. — must exist in
 *     the jurisdictions table or the AwardsExtractor base will fail
 *     the run with a clear error)
 *   - sourcePortal (used as awards.source_portal — must be unique
 *     across publishers since (source_portal, source_award_id) is
 *     the dedup key)
 *   - countryCode (ISO-2 — used as awards.buyer_country fallback)
 *   - defaultCurrency (ISO-4217 — used when an OCDS release omits
 *     currency on its value object)
 *   - sourceUrlTemplate (optional — given an ocid, returns the
 *     publisher's web URL for the contracting process)
 *   - bulkFileUrls and/or bulkFilePaths: same semantics as the
 *     DR extractor.
 *
 * Filtering — same as DR: emit only fuel + food awards by default;
 * `categoryFilters: ['all']` keeps everything the classifier tags.
 *
 * Multilingual safety: OCDS uses UNSPSC codes (numeric) for item
 * classification, so the classifier is language-agnostic. This works
 * the same on a Mexican or Honduran feed as it does on DR.
 */
import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import {
  AwardsExtractor,
  classifyAwardByUnspsc,
  convertToUsd,
  hasFuelUnspsc,
  hasFoodUnspsc,
  type NormalizedAward,
} from '@procur/scrapers-core';
import { streamRemoteJsonlGz } from '../dr-dgcp/download';

type OcdsValue = { amount?: number | null; currency?: string | null } | null;
type OcdsClassification = { id?: string | number; scheme?: string } | null;
type OcdsItem = {
  classification?: OcdsClassification;
  quantity?: number | null;
  unit?: { value?: OcdsValue } | null;
} | null;
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

export type OcdsBulkConfig = {
  jurisdictionSlug: string;
  sourcePortal: string;
  countryCode: string;
  defaultCurrency: string;
  /** Optional: build a per-process source_url from an OCID. */
  sourceUrlTemplate?: (ocid: string) => string;
  /** Local files (deterministic for tests + dev). */
  bulkFilePaths?: string[];
  /** Remote URLs to OCDS bulk .jsonl.gz files. */
  bulkFileUrls?: string[];
  categoryFilters?: Array<'fuel' | 'food' | 'all'>;
};

export class OcdsBulkAwardsExtractor extends AwardsExtractor {
  readonly jurisdictionSlug: string;
  readonly sourcePortal: string;

  constructor(private readonly config: OcdsBulkConfig) {
    super();
    this.jurisdictionSlug = config.jurisdictionSlug;
    this.sourcePortal = config.sourcePortal;
  }

  resolveUrls(): string[] {
    return [...(this.config.bulkFileUrls ?? [])];
  }

  async *streamAwards(): AsyncIterable<NormalizedAward> {
    const filters = this.config.categoryFilters ?? ['fuel', 'food'];
    const matchAll = filters.includes('all');
    const wantFuel = matchAll || filters.includes('fuel');
    const wantFood = matchAll || filters.includes('food');

    const localPaths = this.config.bulkFilePaths ?? [];
    const remoteUrls = this.resolveUrls();
    if (localPaths.length === 0 && remoteUrls.length === 0) {
      throw new Error(
        `OcdsBulkAwardsExtractor[${this.sourcePortal}]: no sources resolved (provide bulkFilePaths or bulkFileUrls).`,
      );
    }

    for (const path of localPaths) {
      console.log(`  [${this.sourcePortal}] reading ${path}`);
      yield* this.processStream(localFileLines(path), { wantFuel, wantFood, matchAll });
    }
    for (const url of remoteUrls) {
      console.log(`  [${this.sourcePortal}] fetching ${url}`);
      try {
        yield* this.processStream(streamRemoteJsonlGz(url), { wantFuel, wantFood, matchAll });
        console.log(`    finished ${url}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('HTTP 404')) {
          console.log(`    404 (not yet published) — skipping`);
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

        const awardDate = normalizeDate(award.date);
        const effectiveCurrency = contractCurrency ?? this.config.defaultCurrency;
        const sourceUrl =
          release.ocid && this.config.sourceUrlTemplate
            ? this.config.sourceUrlTemplate(release.ocid)
            : null;

        yield {
          award: {
            sourcePortal: this.sourcePortal,
            sourceAwardId: awardId,
            sourceUrl,
            rawPayload: { release_ocid: release.ocid, award_id: awardId },
            buyerName: buyer.name,
            buyerCountry: this.config.countryCode,
            title: release.tender?.title ?? null,
            commodityDescription:
              release.tender?.description ?? release.tender?.title ?? null,
            unspscCodes: effectiveCodes,
            categoryTags: effectiveTags,
            contractValueNative,
            contractCurrency: effectiveCurrency,
            contractValueUsd: convertToUsd(contractValueNative, effectiveCurrency, awardDate),
            awardDate,
            status: mapAwardStatus(award.status),
          },
          awardees: awardees.map((a) => ({
            supplier: {
              sourcePortal: this.sourcePortal,
              sourceReferenceId: a.id ?? `${this.sourcePortal}::name::${a.name}`,
              organisationName: a.name,
              country: this.config.countryCode,
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
  for (const c of contracts) {
    if (!c) continue;
    if (c.awardID === award.id && c.value?.amount != null) {
      return { value: c.value.amount, currency: c.value.currency ?? null };
    }
  }
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
  const m = input.match(/^(\d{4}-\d{2}-\d{2})/);
  return m?.[1] ?? new Date().toISOString().slice(0, 10);
}

function mapAwardStatus(status: string | undefined): string {
  if (!status) return 'active';
  const s = status.toLowerCase();
  if (['active', 'cancelled', 'unsuccessful', 'pending'].includes(s)) return s;
  return 'active';
}
