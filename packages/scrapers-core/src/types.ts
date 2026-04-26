export type RawOpportunity = {
  sourceReferenceId: string;
  sourceUrl: string;
  rawData: Record<string, unknown>;
};

export type ScrapedDocument = {
  documentType: string;
  originalUrl: string;
  title?: string;
};

export type OpportunityLifecycleStatus = 'active' | 'closed' | 'awarded' | 'cancelled';

export type NormalizedOpportunity = {
  sourceReferenceId: string;
  sourceUrl: string;
  title: string;
  description?: string;
  referenceNumber?: string;
  type?: string;
  agencyName?: string;
  agencySlug?: string;
  category?: string;
  valueEstimate?: number;
  currency?: string;
  publishedAt?: Date;
  deadlineAt?: Date;
  deadlineTimezone?: string;
  language?: string;
  /**
   * Lifecycle marker. Most surfaces emit 'active' (or omit, default
   * 'active'). Award-notice surfaces should set 'awarded' so the
   * Past-awards view in Discover can find the row regardless of
   * whether deadlineAt was successfully parsed.
   */
  status?: OpportunityLifecycleStatus;
  awardedAt?: Date;
  awardedAmount?: number;
  awardedToCompanyName?: string;
  rawContent: Record<string, unknown>;
  documents?: ScrapedDocument[];
};

export type ScraperError = {
  message: string;
  context?: Record<string, unknown>;
  stack?: string;
};

export type ScraperResult = {
  status: 'success' | 'partial' | 'failed';
  recordsFound: number;
  recordsNew: number;
  recordsUpdated: number;
  recordsSkipped: number;
  /** opportunities.id of every newly-inserted row this run — hand to AI pipeline. */
  insertedIds: string[];
  errors: ScraperError[];
  durationMs: number;
};
