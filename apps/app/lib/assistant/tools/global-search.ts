import 'server-only';
import { z } from 'zod';
import { defineTool } from '@procur/ai';
import { runGlobalSearch } from '../../search-queries';

const input = z.object({
  query: z.string(),
});

/**
 * Blended ilike + semantic search across pursuits, contracts, library,
 * past performance, and public opportunities. Mirrors what the user sees
 * on /search.
 */
export const globalSearchTool = defineTool({
  name: 'global_search',
  description:
    "Blended keyword + semantic search across the user's pursuits, contracts, library entries, past performance records, and public opportunities. Use this when the user says 'find' or 'search' without specifying where — it's broader than the module-specific tools.",
  kind: 'read',
  schema: input,
  handler: async (ctx, args) => {
    const results = await runGlobalSearch(ctx.companyId, args.query);
    const map = (hits: (typeof results)['pursuits']) =>
      hits.map((h) => ({
        kind: h.kind,
        id: h.id,
        title: h.title,
        subtitle: h.subtitle,
        meta: h.meta,
        href: h.href,
      }));

    return {
      totalCount: results.totalCount,
      opportunities: map(results.opportunities),
      pursuits: map(results.pursuits),
      contracts: map(results.contracts),
      pastPerformance: map(results.pastPerformance),
      library: map(results.library),
    };
  },
});
