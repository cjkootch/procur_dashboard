export { getClient, MODELS, type ModelName } from './client';
export { classifyOpportunity, type ClassifyInput, type ClassifyResult } from './tasks/classify';
export {
  summarizeOpportunity,
  type SummarizeInput,
  type SummarizeResult,
} from './tasks/summarize';
export {
  detectLanguage,
  type DetectLanguageInput,
  type DetectLanguageResult,
} from './tasks/detect-language';
export {
  translateOpportunity,
  type TranslateInput,
  type TranslateResult,
} from './tasks/translate';
export {
  extractRequirements,
  type ExtractRequirementsInput,
  type ExtractRequirementsResult,
} from './tasks/extract-requirements';
export {
  draftSection,
  type DraftSectionInput,
  type DraftSectionResult,
  type LibraryExcerpt,
} from './tasks/draft-section';
export {
  chunkContent,
  type ChunkContentInput,
  type ChunkContentResult,
} from './tasks/chunk-content';
export { embedText, embedMany, EMBEDDING_MODEL, EMBEDDING_DIMS } from './embeddings';
export type { CacheUsage } from './prompt-blocks';
export {
  ClassifyOutput,
  SummaryOutput,
  LanguageOutput,
  TranslationOutput,
  ExtractRequirementsOutput,
  type ClassifyOutputT,
  type SummaryOutputT,
  type LanguageOutputT,
  type TranslationOutputT,
  type ExtractRequirementsOutputT,
} from './types';
