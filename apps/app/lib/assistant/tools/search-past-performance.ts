import 'server-only';
import { z } from 'zod';
import { defineTool, embedText, meterEmbedding } from '@procur/ai';
import { semanticSearchPastPerformance } from '../../past-performance-queries';

const input = z.object({
  query: z.string(),
  limit: z.number().optional(),
});

export const searchPastPerformanceTool = defineTool({
  name: 'search_past_performance',
  description:
    "Semantic search over the company's past performance records. Input a natural-language description of the scope (e.g. 'water infrastructure projects over $2M'). Returns top matching projects with customer, scope, accomplishments, and outcomes. Use this when the user asks for relevant past work or when building a capability claim.",
  kind: 'read',
  schema: input,
  handler: async (ctx, args) => {
    if (!process.env.OPENAI_API_KEY) {
      return { error: 'embeddings_unavailable', message: 'OPENAI_API_KEY not configured' };
    }
    const limit = Math.min(args.limit ?? 5, 10);
    const embedding = await embedText(args.query);
    await meterEmbedding({
      companyId: ctx.companyId,
      tokens: Math.ceil(args.query.length / 4),
    });
    const rows = await semanticSearchPastPerformance(ctx.companyId, embedding, limit);
    return {
      count: rows.length,
      records: rows.map((r) => ({
        id: r.id,
        projectName: r.projectName,
        customerName: r.customerName,
        scope: r.scopeDescription.slice(0, 400),
        keyAccomplishments: r.keyAccomplishments ?? [],
        outcomes: r.outcomes?.slice(0, 300) ?? null,
        href: `/past-performance/${r.id}`,
      })),
    };
  },
});
