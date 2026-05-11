export { getClient, MODELS, type ModelName } from './client';
export { classifyOpportunity, type ClassifyInput, type ClassifyResult } from './tasks/classify';
export {
  enrichCore,
  type EnrichCoreInput,
  type EnrichCoreResult,
} from './tasks/enrich-core';
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
  shredRfp,
  type ShredRfpInput,
  type ShredRfpResult,
} from './tasks/shred-rfp';
export {
  extractDistressSignal,
  ExtractDistressSignalOutput,
  type ExtractDistressSignalInput,
  type ExtractDistressSignalOutputT,
  type ExtractDistressSignalResult,
} from './tasks/extract-distress-signal';
export {
  suggestRequirements,
  type SuggestRequirementsInput,
  type SuggestRequirementsResult,
} from './tasks/suggest-requirements';
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
  withToolTelemetry,
  logToolCall,
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
  type AnthropicImageBlockParam,
  type AnthropicDocumentBlockParam,
  type AnthropicToolUseBlock,
  type AnthropicToolResultBlockParam,
} from './assistant';
export type { CacheUsage } from './prompt-blocks';
export {
  generateProbePlan,
  type ProbeContextForPlan,
  type ProbePlanResult,
  type ProposedHypothesis,
} from './market-probes/plan-agent';
export {
  proposeProbeStrategyAdjustments,
  type ProbeContextForStrategy,
  type ProbeMetricsSnapshot,
  type ProbeStrategyProposal,
} from './market-probes/strategy-agent';
export {
  proposeVariantAdjustments,
  type VariantAgentContext,
  type VariantNomination,
  type VariantPerformanceForAgent,
} from './market-probes/variant-agent';
export {
  generateLearningReport,
  type LearningReportContext,
  type LearningReportResult,
} from './market-probes/learning-report-agent';
export {
  ClassifyOutput,
  SummaryOutput,
  LanguageOutput,
  TranslationOutput,
  EnrichCoreOutput,
  ExtractRequirementsOutput,
  ShredRfpOutput,
  SuggestRequirementsOutput,
  type ClassifyOutputT,
  type SummaryOutputT,
  type LanguageOutputT,
  type TranslationOutputT,
  type EnrichCoreOutputT,
  type ExtractRequirementsOutputT,
  type ShredRfpOutputT,
  type SuggestRequirementsOutputT,
} from './types';
export {
  listThreads,
  getThread,
  listMessages,
  createThread,
  renameThread,
  deleteThread,
  appendUserMessage,
  appendAssistantMessage,
  appendToolResults,
  messagesToHistory,
  type ThreadListRow,
  type UserAttachment,
  type AppendAssistantMessageInput,
} from './threads';

// Vex-into-procur merge Phase 2 — agent runtime + cost ledger.
// Per docs/vex-into-procur-merge-brief.md.
export {
  ActionDescriptor,
  actionRequiresApproval,
  ApprovalTier,
  requiresApproval,
  ApprovalGate,
  AgentRunner,
  DEFAULT_DAILY_COST_LIMIT_USD,
  createId,
  isUlid,
  MlEvidence,
  MlEvidenceItem,
  type ActionDescriptorT,
  type AgentContext,
  type AgentOutput,
  type AgentRunRecord,
  type AgentRunnerOptions,
  type IAgent,
  type MlEvidenceItemT,
  type MlEvidenceT,
} from './agents';
export {
  InMemoryCostLedger,
  PostgresCostLedger,
  sumCostLedgerToday,
  type CostEntry,
  type CostLedger,
  type CostOperation,
} from './cost-ledger';
// Phase 3 — email executor + reply-draft agent
export {
  applyEmailSend,
  parseEmailSendPayload,
  type EmailSendPayload,
  type EmailSendResult,
} from './executors/email-send';
export {
  applyLeadFormSubmit,
  parseLeadFormSubmitPayload,
  type LeadFormSubmitPayload,
  type LeadFormSubmitResult,
} from './executors/lead-form-submit';
export {
  applyRvmDispatch,
  parseRvmDispatchPayload,
  type RvmDispatchPayload,
  type RvmDispatchResult,
} from './executors/rvm-dispatch';
export {
  resolveCountryTimezone,
  currentHourInCountry,
  isWithinQuietHours,
} from './lib/country-timezone';
// Shared outreach-evidence handling — preserves recommendation
// pipeline output through executors → touchpoints → events so
// model-performance dashboards can join evidence ↔ outcomes.
export {
  buildOutreachMetadata,
  emitOutreachOutcome,
  emitOutreachSent,
  findOutreachSentForApprovals,
  findRecentOutreachApprovalsByContact,
  findRecentOutreachApprovalsByEntity,
  findRecentOutreachApprovalsByOrg,
  hasOutreachEvidence,
  parseOutreachEvidence,
  OUTREACH_LIFECYCLE_VERBS,
  type OutreachEvidence,
  type OutreachLifecycleVerb,
} from './executors/outreach-evidence';
export {
  EmailReplyDraftAgent,
  type EmailReplyDraftInput,
} from './agents/agents/email-reply-draft';
// Phase 4 — sales executors (crm.create_*, lead.close, follow_up.schedule, …)
export {
  applyCloseLead,
  applyContactOptOut,
  applyContactTag,
  applyCreateCompany,
  applyCreateContact,
  applyOrgAddProduct,
  applyOrgLinkRelationship,
  applyOrgSetKind,
  applyOrgTag,
  applyOrgUpdateFields,
  applyScheduleFollowUp,
  parseCloseLeadPayload,
  parseCreateCompanyPayload,
  parseCreateContactPayload,
  parseScheduleFollowUpPayload,
  type CloseLeadPayload,
  type CreateCompanyPayload,
  type CreateContactPayload,
  type ScheduleFollowUpPayload,
} from './executors/sales';
// Phase 5 — fuel-deal executors + DealEvaluator + DealMarketContext agents
export {
  applyCreateDeal,
  applyDealAttach,
  applyDealEvaluate,
  applyDealHumanReview,
  applyDealMilestone,
  applyDealSetBroker,
  applyDealStatusChange,
  parseCreateDealPayload,
  parseDealAttachPayload,
  parseDealEvaluatePayload,
  parseDealMilestonePayload,
  parseDealSetBrokerPayload,
  parseDealStatusChangePayload,
  type CreateDealPayload,
  type DealAttachPayload,
  type DealEvaluatePayload,
  type DealMilestonePayload,
  type DealSetBrokerPayload,
  type DealStatusChangePayload,
} from './executors/deals';
export {
  DealEvaluatorAgent,
  type DealEvaluatorInput,
} from './agents/agents/deal-evaluator';
export {
  DealMarketContextAgent,
  type DealMarketContextDeps,
  type DealMarketContextInput,
  type EvaluateTargetPriceFn,
} from './agents/agents/deal-market-context';
// Phase 6 — sanctions screening + daily brief
export {
  applySanctionsScreen,
  parseSanctionsScreenPayload,
  type SanctionsScreenPayload,
} from './executors/sanctions';
// Phase 7 — Twilio executors (SMS, WhatsApp, outbound voice)
export {
  applySmsSend,
  applyWhatsAppSend,
  applyWhatsAppSendTemplate,
  applyOutboundCall,
  parseSmsSendPayload,
  parseWhatsAppSendPayload,
  parseWhatsAppSendTemplatePayload,
  parseOutboundCallPayload,
  type SmsSendPayload,
  type WhatsAppSendPayload,
  type WhatsAppSendTemplatePayload,
  type OutboundCallPayload,
} from './executors/twilio';
export {
  SanctionsScreeningAgent,
  type SanctionsScreeningInput,
} from './agents/agents/sanctions-screening';
// Shared dispatch table — wires action_type → matching executor.
// Both the /approvals server action and /api/approvals/[id]/approve
// route must call this; without it the route silently records the
// decision but never fires the executor (Bug #1).
export {
  dispatchApprovalExecutor,
  type ApprovalRowForExecutor,
} from './agents/dispatch';
export {
  DailyBriefAgent,
  type DailyBrief,
  type DailyBriefInput,
} from './agents/agents/daily-brief';
// Communication templates executors — Cole's vex-parity request.
// T1 metadata writes; no outbound side effects.
export {
  applyArchiveCommunicationTemplate,
  applySaveCommunicationTemplate,
  parseArchiveCommunicationTemplatePayload,
  parseSaveCommunicationTemplatePayload,
  type ArchiveCommunicationTemplatePayload,
  type SaveCommunicationTemplatePayload,
} from './executors/communication-templates';
// Mission executor — gamification slice 4. Custom missions
// proposed via the chat assistant. Stages are operator-defined
// manual checklists that earn XP per stage on "Mark done".
export {
  applyCreateMission,
  parseCreateMissionPayload,
  type CreateMissionPayload,
  type CreateMissionResult,
} from './executors/missions';
// Inbound translation helper — detects language + translates to
// English in one Haiku call. Used by the resend-inbound and
// twilio webhooks to populate metadata.body_text_en /
// metadata.subject_en / metadata.detected_language_* fields. Never
// blocks the parent action.
export {
  translateInboundMessage,
  translateOutboundMessage,
  type TranslatedInbound,
  type TranslatedOutbound,
} from './translate';
// Single-entity crawler trigger — exposes the existing CLI crawler
// to a server action. See crawl-entity-website.ts for caveats
// around Vercel function timeouts and the pending Trigger.dev v4
// migration that's the proper home for long-running crawls.
export { crawlSingleEntity } from './crawl-entity-website';
