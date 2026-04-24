import 'server-only';
import { z } from 'zod';
import { defineTool, embedText, meterEmbedding } from '@procur/ai';
import { semanticSearchLibrary } from '../../library-queries';

const input = z.object({
  query: z.string(),
  limit: z.number().optional(),
});

/**
 * Semantic retrieval over the company's content library. Input is a
 * natural-language description of what to find (e.g. "quality assurance
 * approach for road construction projects"). Returns the top-k matching
 * entries with their title, type, and a short content excerpt.
 *
 * Costs: one OpenAI embedding call per invocation. Metered under
 * the 'embeddings' source so it's visible in the usage rollup.
 */
export const searchContentLibraryTool = defineTool({
  name: 'search_content_library',
  description:
    "Semantic search over the company's content library (capability statements, team bios, boilerplate, past performance writeups, templates). Input a natural-language description of what you need. Returns top matching entries with title, type, and excerpt. Use this when drafting sections or answering 'do we have something about X'.",
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
      // Rough approximation: 1 token ≈ 4 chars. The exact token count isn't
      // returned by the OpenAI embeddings endpoint we use.
      tokens: Math.ceil(args.query.length / 4),
    });
    const rows = await semanticSearchLibrary(ctx.companyId, embedding, limit);
    return {
      count: rows.length,
      entries: rows.map((r) => ({
        id: r.id,
        title: r.title,
        type: r.type,
        excerpt: r.content.slice(0, 400),
        href: `/library/${r.id}`,
      })),
    };
  },
});
