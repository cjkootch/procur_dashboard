/**
 * Jamaica — GOJEP PPC-approved supplier registry.
 *
 * Portal:       https://www.gojep.gov.jm
 * Listing path: /epps/ncc/listNccCategoryApprovedSuppliers.do?categoryType={cat}
 *
 * Three categories on the live portal:
 *   - gs   : Goods & Services             ~111 pages × 10 ≈ 1,100 suppliers
 *   - w14  : Works (Grades 1–4)           ~27 pages × 10 ≈ 270 suppliers
 *   - w5   : Works (Grade 5)              1 page (small registry)
 *
 * Public, no CAPTCHA, no auth. DisplayTag pagination via
 * `?d-{tableId}-p={page}`. The table id is the same across all three
 * categories on this page (16564 at audit time) — derived from the
 * response if it ever changes.
 *
 * Per-row 7 cells:
 *   [0] index, [1] organisation name, [2] address, [3] phone,
 *   [4] country, [5] contact person, [6] confirmed-at (registration date).
 *
 * Output is shaped for the `external_suppliers` table — distinct from
 * the `opportunities` schema that powers TenderScraper. Run via the
 * standalone `runSuppliersScraper()` helper, not the TenderScraper
 * orchestration.
 */
import { fetchWithRetry, loadHtml, textOf } from '@procur/scrapers-core';

const PORTAL = 'https://www.gojep.gov.jm';
const LIST_PATH = '/epps/ncc/listNccCategoryApprovedSuppliers.do';
// Table id used by DisplayTag for pagination. Live value at audit
// time; can be overridden via input for tests / future portal redesign.
const DEFAULT_TABLE_ID = '16564';

export const SUPPLIER_CATEGORIES = ['gs', 'w14', 'w5'] as const;
export type SupplierCategory = (typeof SUPPLIER_CATEGORIES)[number];

export type SupplierRow = {
  sourceCategory: SupplierCategory;
  /** Stable identifier we synthesize from name + category, since the
   *  portal doesn't expose a per-row id. Used by upsert dedupe. */
  sourceReferenceId: string;
  organisationName: string;
  address?: string;
  phone?: string;
  email?: string;
  country?: string;
  contactPerson?: string;
  registeredAtText?: string;
  sourceUrl: string;
  rawCells: string[];
};

export type SuppliersScraperInput = {
  fixtureHtml?: Partial<Record<SupplierCategory, string>>;
  /** Pages to walk per category. Default 200 — covers all known
   *  categories with headroom; stops early when a page returns 0 rows. */
  maxPagesPerCategory?: number;
  /** Override the DisplayTag table id (live: 16564). */
  tableId?: string;
};

const REGISTRATION_DATE_REGEX = /\d{1,2}-\d{1,2}-\d{4}/;

/**
 * Build a stable source reference id. The portal doesn't expose a
 * per-row primary key; the (name, category) pair is the practical
 * identity. Lower-cased, whitespace-collapsed, punctuation-stripped
 * so casing/spacing drift between scrapes doesn't create duplicates.
 */
function deriveReferenceId(category: SupplierCategory, name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `${category}-${slug}`;
}

export class JamaicaGojepSuppliersScraper {
  readonly jurisdictionSlug = 'jamaica';
  readonly sourceName = 'jamaica-gojep-suppliers';
  readonly portalUrl = PORTAL;

  constructor(private readonly input: SuppliersScraperInput = {}) {}

  async fetch(): Promise<SupplierRow[]> {
    const out: SupplierRow[] = [];

    for (const category of SUPPLIER_CATEGORIES) {
      const fixture = this.input.fixtureHtml?.[category];
      if (fixture) {
        out.push(...this.parsePage(fixture, category));
        continue;
      }
      out.push(...(await this.fetchCategory(category)));
    }

    return out;
  }

  /** Walk pagination for one category until we hit an empty page. */
  private async fetchCategory(category: SupplierCategory): Promise<SupplierRow[]> {
    const out: SupplierRow[] = [];
    const maxPages = this.input.maxPagesPerCategory ?? 200;
    const tableId = this.input.tableId ?? DEFAULT_TABLE_ID;

    for (let p = 1; p <= maxPages; p += 1) {
      const url =
        p === 1
          ? `${PORTAL}${LIST_PATH}?categoryType=${category}`
          : `${PORTAL}${LIST_PATH}?categoryType=${category}&d-${tableId}-p=${p}`;
      const res = await fetchWithRetry(url);
      const html = await res.text();
      const rows = this.parsePage(html, category);
      if (rows.length === 0) break;
      out.push(...rows);
    }

    return out;
  }

  /**
   * Find data rows by the leading numeric index cell. The supplier
   * table has 7 cells per row and the first is always a 1-based
   * row index, which we filter out as a discriminator from layout
   * rows (header, paging controls).
   */
  parsePage(html: string, category: SupplierCategory): SupplierRow[] {
    const $ = loadHtml(html);
    const out: SupplierRow[] = [];

    $('tr').each((_i, el) => {
      const $cells = $(el).find('td');
      if ($cells.length !== 7) return;

      const idxCell = textOf($cells.eq(0));
      if (!/^\d+$/.test(idxCell)) return;

      const organisationName = textOf($cells.eq(1));
      if (!organisationName) return;

      const address = textOf($cells.eq(2));
      const phone = textOf($cells.eq(3));
      const country = textOf($cells.eq(4));
      const contactPerson = textOf($cells.eq(5));
      const registeredAtText = textOf($cells.eq(6));

      const rawCells = [idxCell, organisationName, address, phone, country, contactPerson, registeredAtText];

      out.push({
        sourceCategory: category,
        sourceReferenceId: deriveReferenceId(category, organisationName),
        organisationName,
        address: address || undefined,
        phone: phone || undefined,
        country: country || undefined,
        contactPerson: contactPerson || undefined,
        registeredAtText:
          registeredAtText.match(REGISTRATION_DATE_REGEX)?.[0] ?? registeredAtText ?? undefined,
        sourceUrl: `${PORTAL}${LIST_PATH}?categoryType=${category}`,
        rawCells,
      });
    });

    return out;
  }
}
