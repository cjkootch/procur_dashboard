import 'server-only';
import { defineTool, type ToolRegistry } from '@procur/ai';
import {
  buildCatalogTools,
  buildFilterUrl,
  describeFilters,
} from '@procur/catalog';
import { z } from 'zod';

/**
 * Discover-side tool registry — composes the shared catalog tools
 * (search / pricing / summary / brief / etc.) from @procur/catalog with
 * one Discover-only tool: build_filter_url. The shared registry stops
 * short of URL-shaped helpers because "navigate the user to a
 * pre-filtered Discover view" is a surface-specific action — not
 * meaningful in the main app's drawer assistant.
 */
export function buildDiscoverTools(): ToolRegistry {
  return {
    ...buildCatalogTools(),
    build_filter_url: defineTool({
      name: 'build_filter_url',
      description:
        'Build a Discover catalog URL with the given filters pre-applied. Use this when ' +
        'the user wants to BROWSE rather than read a list — phrases like "take me to", ' +
        '"open", "filter to", "narrow to", "show the catalog filtered to". The returned ' +
        'URL lands the user on the Discover sidebar view with the same filters checked. ' +
        'Prefer this over search_opportunities when the user clearly wants to explore the ' +
        'catalog UI rather than have the assistant summarize results in chat.',
      kind: 'read',
      schema: z.object({
        query: z.string().optional().describe('Free-text search keyword'),
        jurisdiction: z
          .string()
          .optional()
          .describe(
            'Jurisdiction slug (e.g. "us-federal", "canada-federal", "eu-ted", "uk-fts", "un")',
          ),
        category: z
          .string()
          .optional()
          .describe(
            '"food-commodities", "petroleum-fuels", "vehicles-fleet", "minerals-metals", or other taxonomy slug',
          ),
        country: z
          .string()
          .optional()
          .describe('Beneficiary country name (e.g. "Jamaica", "Haiti", "Germany")'),
        scope: z.enum(['open', 'past']).optional().describe('"open" (default) or "past" awards'),
      }),
      handler: async (_ctx, input) => {
        const url = buildFilterUrl({
          query: input.query,
          jurisdiction: input.jurisdiction,
          category: input.category,
          country: input.country,
          scope: input.scope,
        });
        const description = describeFilters(input);
        return { url, description };
      },
    }),
  };
}
