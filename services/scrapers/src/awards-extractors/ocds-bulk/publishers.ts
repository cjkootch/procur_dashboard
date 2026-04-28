/**
 * Known OCDS bulk publishers — config presets for OcdsBulkAwardsExtractor.
 *
 * Each publisher's bulk feed lives at the OCP Data Registry:
 *   https://data.open-contracting.org/en/publication/{N}/download?name={year}.jsonl.gz
 *
 * Find publication numeric IDs by browsing https://data.open-contracting.org/.
 * This file deliberately starts small — add a new publisher by appending
 * an entry here, then run:
 *   pnpm --filter @procur/scrapers scrape awards-ocds <key>
 *
 * The DR DGCP publication (id 22) is here for reference but the dr_dgcp
 * portal slug is owned by DrDgcpAwardsExtractor (don't double-ingest).
 */

import type { OcdsBulkConfig } from './extractor';

export type PublisherPreset = Omit<OcdsBulkConfig, 'bulkFileUrls' | 'bulkFilePaths'> & {
  /** Numeric OCP Data Registry publication id. */
  publicationId: number;
};

export const OCDS_PUBLISHERS: Record<string, PublisherPreset> = {
  // ── LATAM ──────────────────────────────────────────────────────
  'mexico-compranet': {
    publicationId: 17, // CompraNet — verify on data.open-contracting.org
    jurisdictionSlug: 'mexico',
    sourcePortal: 'mexico_compranet_ocds',
    countryCode: 'MX',
    defaultCurrency: 'MXN',
  },
  'colombia-secop2': {
    publicationId: 30, // SECOP II — verify
    jurisdictionSlug: 'colombia',
    sourcePortal: 'colombia_secop2_ocds',
    countryCode: 'CO',
    defaultCurrency: 'COP',
  },
  'paraguay-dncp': {
    publicationId: 14, // DNCP — verify
    jurisdictionSlug: 'paraguay',
    sourcePortal: 'paraguay_dncp_ocds',
    countryCode: 'PY',
    defaultCurrency: 'PYG',
  },
  'honduras-honducompras': {
    publicationId: 6, // ONCAE / HONDUCOMPRAS — verify
    jurisdictionSlug: 'honduras',
    sourcePortal: 'honduras_honducompras_ocds',
    countryCode: 'HN',
    defaultCurrency: 'HNL',
  },
  'argentina-comprar': {
    publicationId: 47, // COMPR.AR — verify
    jurisdictionSlug: 'argentina',
    sourcePortal: 'argentina_comprar_ocds',
    countryCode: 'AR',
    defaultCurrency: 'ARS',
  },
  // ── AFRICA ─────────────────────────────────────────────────────
  'nigeria-nocopo': {
    publicationId: 39, // NOCOPO — verify
    jurisdictionSlug: 'nigeria',
    sourcePortal: 'nigeria_nocopo_ocds',
    countryCode: 'NG',
    defaultCurrency: 'NGN',
  },
};

export function getPublisherPreset(key: string): PublisherPreset | null {
  return OCDS_PUBLISHERS[key] ?? null;
}

/**
 * Build per-year OCDR URLs for a publication. The OCP registry uses a
 * fixed `?name=YYYY.jsonl.gz` query convention regardless of publisher.
 */
export function buildOcdrYearUrls(publicationId: number, years: number[]): string[] {
  return years.map(
    (y) =>
      `https://data.open-contracting.org/en/publication/${publicationId}/download?name=${y}.jsonl.gz`,
  );
}
