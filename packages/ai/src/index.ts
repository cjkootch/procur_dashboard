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
export {
  extractPricingStructure,
  type ExtractPricingInput,
  type ExtractPricingResult,
} from './tasks/extract-pricing';
export {
  mapRequirementsToSections,
  type MapRequirementsInput,
  type MapRequirementsResult,
  type RequirementInput,
  type SectionInput,
} from './tasks/map-requirements';
export {
  reviewProposal,
  type ReviewProposalInput,
  type ReviewProposalResult,
} from './tasks/review-proposal';
export {
  extractCompanyProfile,
  type ExtractCompanyProfileInput,
  type ExtractCompanyProfileResult,
} from './tasks/extract-company-profile';
export { embedText, embedMany, EMBEDDING_MODEL, EMBEDDING_DIMS } from './embeddings';
export * as assistant from './assistant';
export {
  runAgentTurn,
  getBudgetStatus,
  recordUsage,
  MONTHLY_BUDGET_CENTS,
  BudgetExceededError,
  costUsdCentsForTurn,
  costUsdCentsForEmbedding,
  meter,
  meterEmbedding,
  defineTool,
  buildAssistantSystem,
  type BudgetStatus,
  type UsageSource,
  type PlanTier,
  type AssistantContext,
  type PageContext,
  type ToolDefinition,
  type ToolRegistry,
  type TurnInput,
  type TurnResult,
  type TurnStep,
  streamAgentTurn,
  type StreamEvent,
  type StreamTurnInput,
  type AnthropicMessageParam,
  type AnthropicContentBlock,
  type AnthropicTextBlockParam,
  type AnthropicToolUseBlock,
  type AnthropicToolResultBlockParam,
} from './assistant';
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
