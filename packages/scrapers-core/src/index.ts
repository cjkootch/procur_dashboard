export { TenderScraper } from './base';
export type { ScraperRunOptions } from './base';
export type {
  NormalizedOpportunity,
  OpportunityLifecycleStatus,
  RawOpportunity,
  ScrapedDocument,
  ScraperError,
  ScraperResult,
} from './types';
export { fetchWithRetry } from './http';
export type { FetchOptions } from './http';
export { loadHtml, textOf, attrOf, absoluteUrl, extractTable } from './html';
export type { Dom, Node } from './html';
export { slugifyTitle, buildOpportunitySlug } from './slug';
export { parseTenderDate } from './dates';
export { parseMoney, toUsd } from './currency';
export { COUNTRY_NAMES, findTrailingCountry } from './countries';
export { classifyVtcCategory } from './categories';
export {
  upsertOpportunity,
  startScraperRun,
  finishScraperRun,
  getJurisdictionBySlug,
} from './upsert';
export type { UpsertResult, FinishScraperRunInput } from './upsert';

// Supplier-graph awards extraction (parallel layer to TenderScraper)
export { AwardsExtractor } from './awards-base';
export type { AwardsExtractorRunOptions, NormalizedAward } from './awards-base';
export {
  upsertAward,
  upsertExternalSupplier,
  upsertSupplierAlias,
  linkAwardAwardee,
  normalizeSupplierName,
} from './awards-upsert';
export type {
  UpsertAwardInput,
  UpsertAwardOutcome,
  UpsertExternalSupplierInput,
  UpsertSupplierAliasInput,
  LinkAwardAwardeeInput,
} from './awards-upsert';
export {
  classifyAwardByUnspsc,
  hasFuelUnspsc,
  hasFoodUnspsc,
  FUEL_UNSPSC_CODES,
} from './awards-classifier';
