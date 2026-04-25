import { desc, eq } from 'drizzle-orm';
import { db, opportunities, proposals, pursuits } from '@procur/db';
import { authenticateWordAddinRequest, jsonResponse, unauthorized } from '../_lib';

export const runtime = 'nodejs';

type OutlineSection = { id: string; number: string; title: string };

/**
 * GET /api/word-addin/proposals
 *
 * Returns the user's company's proposals + a flattened list of outline
 * sections per proposal. The taskpane shows two cascading dropdowns:
 * proposal → section, then collects an instruction and calls /draft.
 */
export async function GET(req: Request): Promise<Response> {
  const auth = await authenticateWordAddinRequest(req);
  if (!auth) return unauthorized();

  const rows = await db
    .select({
      proposalId: proposals.id,
      pursuitId: proposals.pursuitId,
      status: proposals.status,
      outline: proposals.outline,
      title: opportunities.title,
      updatedAt: proposals.updatedAt,
    })
    .from(proposals)
    .innerJoin(pursuits, eq(pursuits.id, proposals.pursuitId))
    .innerJoin(opportunities, eq(opportunities.id, pursuits.opportunityId))
    .where(eq(pursuits.companyId, auth.companyId))
    .orderBy(desc(proposals.updatedAt));

  const items = rows.map((r) => {
    const outline = (r.outline as OutlineSection[] | null) ?? [];
    return {
      id: r.proposalId,
      pursuitId: r.pursuitId,
      title: r.title,
      status: r.status,
      sections: outline.map((s) => ({
        id: s.id,
        number: s.number,
        title: s.title,
      })),
    };
  });

  return jsonResponse({ proposals: items });
}
