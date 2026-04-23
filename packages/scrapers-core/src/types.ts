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
  errors: ScraperError[];
  durationMs: number;
};
