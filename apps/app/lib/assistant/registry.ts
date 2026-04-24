import 'server-only';
import type { AssistantContext, ToolRegistry } from '@procur/ai';
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

/**
 * All read tools available to the assistant, keyed by tool name.
 * Write tools land on Day 4 under ./write-tools/.
 */
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

export function buildAssistantTools(): ToolRegistry {
  return { ...readTools };
}

export type { AssistantContext };
