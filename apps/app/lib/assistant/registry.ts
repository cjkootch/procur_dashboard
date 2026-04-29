import 'server-only';
import type { AssistantContext, ToolRegistry } from '@procur/ai';
import { buildCatalogTools } from '@procur/catalog';
import { searchOpportunitiesTool } from './tools/search-opportunities';
import { globalSearchTool } from './tools/global-search';
import { getHomeSummaryTool } from './tools/get-home-summary';
import { listPursuitsTool } from './tools/list-pursuits';
import { getPursuitTool } from './tools/get-pursuit';
import { getProposalTool } from './tools/get-proposal';
import { searchContentLibraryTool } from './tools/search-content-library';
import { searchPastPerformanceTool } from './tools/search-past-performance';
import { listRecommendedOpportunitiesTool } from './tools/list-recommended-opportunities';
import { getCompanyProfileTool } from './tools/get-company-profile';
import { listContractsTool } from './tools/list-contracts';
import { proposeCreatePursuitTool } from './tools/propose-create-pursuit';
import { proposeAdvanceStageTool } from './tools/propose-advance-stage';
import { proposeCreateTaskTool } from './tools/propose-create-task';
import { proposeDraftProposalSectionTool } from './tools/propose-draft-proposal-section';
import { proposeCreateAlertTool } from './tools/propose-create-alert';
import { proposePushToVexTool } from './tools/propose-push-to-vex';
import { proposePushManyToVexTool } from './tools/propose-push-many-to-vex';
import { proposeCreateKnownEntityTool } from './tools/propose-create-known-entity';
import { proposeUpdateKnownEntityTool } from './tools/propose-update-known-entity';

export const readTools = {
  [searchOpportunitiesTool.name]: searchOpportunitiesTool,
  [globalSearchTool.name]: globalSearchTool,
  [getHomeSummaryTool.name]: getHomeSummaryTool,
  [listPursuitsTool.name]: listPursuitsTool,
  [getPursuitTool.name]: getPursuitTool,
  [getProposalTool.name]: getProposalTool,
  [searchContentLibraryTool.name]: searchContentLibraryTool,
  [searchPastPerformanceTool.name]: searchPastPerformanceTool,
  [listRecommendedOpportunitiesTool.name]: listRecommendedOpportunitiesTool,
  [getCompanyProfileTool.name]: getCompanyProfileTool,
  [listContractsTool.name]: listContractsTool,
} satisfies ToolRegistry;

export const writeTools = {
  [proposeCreatePursuitTool.name]: proposeCreatePursuitTool,
  [proposeAdvanceStageTool.name]: proposeAdvanceStageTool,
  [proposeCreateTaskTool.name]: proposeCreateTaskTool,
  [proposeDraftProposalSectionTool.name]: proposeDraftProposalSectionTool,
  [proposeCreateAlertTool.name]: proposeCreateAlertTool,
  [proposePushToVexTool.name]: proposePushToVexTool,
  [proposePushManyToVexTool.name]: proposePushManyToVexTool,
  [proposeCreateKnownEntityTool.name]: proposeCreateKnownEntityTool,
  [proposeUpdateKnownEntityTool.name]: proposeUpdateKnownEntityTool,
} satisfies ToolRegistry;

/**
 * Compose the full assistant tool surface. Three sources merged here:
 *   - readTools / writeTools above — app-side tools that touch app
 *     state (pursuits, proposals, alerts, vex CRM push)
 *   - buildCatalogTools() — catalog/intelligence tools defined in
 *     @procur/catalog (lookup_customs_flows, find_suppliers_for_tender,
 *     lookup_known_entities, get_market_snapshot,
 *     get_commodity_price_context, get_crude_basis, etc.). These were
 *     previously orphaned — defined in the catalog package but never
 *     wired into the assistant runtime, so every call returned
 *     unknown_tool. The Discover widget consumes the same registry.
 *
 * Merge order: catalog tools first, then readTools, then writeTools.
 * If a name collides, the later entry wins — by convention app-side
 * tools take precedence so the workflow tools (proposeX) can't be
 * masked by an accidentally-same-named catalog tool.
 */
export function buildAssistantTools(): ToolRegistry {
  return { ...buildCatalogTools(), ...readTools, ...writeTools };
}

export type { AssistantContext };
