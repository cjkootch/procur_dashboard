// Legacy three-task fan-out — superseded by enrichCoreTask, kept
// exported for now in case anything outside the orchestrator triggers
// them by id. Safe to remove once we're confident enrich-core is
// producing equivalent output across all jurisdictions.
export { classifyTask } from './trigger/classify';
export { summarizeTask } from './trigger/summarize';
export { detectLanguageTask } from './trigger/detect-language';
export { enrichCoreTask } from './trigger/enrich-core';
export { translateTask } from './trigger/translate';
export { extractRequirementsTask } from './trigger/extract-requirements';
export { enrichOpportunityTask } from './trigger/enrich-opportunity';
