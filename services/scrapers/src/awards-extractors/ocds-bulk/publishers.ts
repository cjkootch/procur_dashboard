/**
 * Known OCDS bulk publishers — config presets for OcdsBulkAwardsExtractor.
 *
 * Publication IDs verified against https://data.open-contracting.org/
 * search results (April 2026). Each publisher's bulk feed lives at:
 *   https://data.open-contracting.org/en/publication/{N}/download?name={year}.jsonl.gz
 *
 * Some publishers use different URL conventions for their JSONL files
 * (some are "full" not per-year; some use ZIP not gzip). When a
 * publisher 404s on the per-year pattern, browse its publication page
 * on data.open-contracting.org to see the actual download URL and add
 * a `urlsForYear` override here.
 *
 * The DR DGCP publication (id 22) is here for reference but the
 * dr_dgcp portal slug is owned by DrDgcpAwardsExtractor — don't
 * double-ingest.
 */

import type { OcdsBulkConfig } from './extractor';

export type PublisherPreset = Omit<OcdsBulkConfig, 'bulkFileUrls' | 'bulkFilePaths'> & {
  /** Numeric OCP Data Registry publication id. */
  publicationId: number;
  /** Optional override of the per-year URL pattern. */
  urlsForYear?: (year: number) => string;
};

export const OCDS_PUBLISHERS: Record<string, PublisherPreset> = {
  // ── LATAM / Caribbean ───────────────────────────────────────────
  'mexico-quienesquien': {
    publicationId: 33,
    jurisdictionSlug: 'mexico',
    sourcePortal: 'mexico_quienesquien_ocds',
    countryCode: 'MX',
    defaultCurrency: 'MXN',
    // PODER's republication of Mexico's federal CompraNet — covers
    // ~4M contracts 2001-2019. Largest Mexican OCDS dataset available.
  },
  'colombia-cce': {
    publicationId: 61,
    jurisdictionSlug: 'colombia',
    sourcePortal: 'colombia_cce_ocds',
    countryCode: 'CO',
    defaultCurrency: 'COP',
    // Colombia Compra Eficiente — SECOP I + II + TVEC combined.
  },
  'paraguay-dncp': {
    publicationId: 63,
    jurisdictionSlug: 'paraguay',
    sourcePortal: 'paraguay_dncp_ocds',
    countryCode: 'PY',
    defaultCurrency: 'PYG',
  },
  'honduras-oncae': {
    publicationId: 122,
    jurisdictionSlug: 'honduras',
    sourcePortal: 'honduras_oncae_ocds',
    countryCode: 'HN',
    defaultCurrency: 'HNL',
    // ONCAE — the main HonduCompras 1.0 publisher.
  },
  'ecuador-sercop': {
    publicationId: 110,
    jurisdictionSlug: 'ecuador',
    sourcePortal: 'ecuador_sercop_ocds',
    countryCode: 'EC',
    defaultCurrency: 'USD',
    // Ecuador uses USD officially.
  },
  'peru-oece': {
    publicationId: 135,
    jurisdictionSlug: 'peru',
    sourcePortal: 'peru_oece_ocds',
    countryCode: 'PE',
    defaultCurrency: 'PEN',
  },
  'guatemala-minfin': {
    publicationId: 142,
    jurisdictionSlug: 'guatemala',
    sourcePortal: 'guatemala_minfin_ocds',
    countryCode: 'GT',
    defaultCurrency: 'GTQ',
  },
  'panama-dgcp': {
    publicationId: 120,
    jurisdictionSlug: 'panama',
    sourcePortal: 'panama_dgcp_ocds',
    countryCode: 'PA',
    defaultCurrency: 'USD',
    // Panama trades fuel in USD (balboa pegged 1:1).
  },

  // ── Africa ─────────────────────────────────────────────────────
  'nigeria-edo': {
    publicationId: 102,
    jurisdictionSlug: 'nigeria-edo',
    sourcePortal: 'nigeria_edo_ocds',
    countryCode: 'NG',
    defaultCurrency: 'NGN',
  },
  'nigeria-plateau': {
    publicationId: 125,
    jurisdictionSlug: 'nigeria-plateau',
    sourcePortal: 'nigeria_plateau_ocds',
    countryCode: 'NG',
    defaultCurrency: 'NGN',
  },
};

export function getPublisherPreset(key: string): PublisherPreset | null {
  return OCDS_PUBLISHERS[key] ?? null;
}

/**
 * Build per-year OCDR URLs for a publication. Most OCP-registry
 * publishers expose `?name={year}.jsonl.gz`; a publisher may override
 * via its preset's `urlsForYear`.
 */
export function buildOcdrYearUrls(preset: PublisherPreset, years: number[]): string[] {
  if (preset.urlsForYear) return years.map(preset.urlsForYear);
  return years.map(
    (y) =>
      `https://data.open-contracting.org/en/publication/${preset.publicationId}/download?name=${y}.jsonl.gz`,
  );
}
