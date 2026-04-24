import 'server-only';
import { asc, eq } from 'drizzle-orm';
import { db, proposalComments, users, type ProposalComment } from '@procur/db';

export type CommentWithAuthor = ProposalComment & {
  authorName: string | null;
  authorEmail: string | null;
};

export async function listProposalComments(
  proposalId: string,
): Promise<CommentWithAuthor[]> {
  const rows = await db
    .select({
      id: proposalComments.id,
      proposalId: proposalComments.proposalId,
      sectionId: proposalComments.sectionId,
      body: proposalComments.body,
      createdBy: proposalComments.createdBy,
      resolvedAt: proposalComments.resolvedAt,
      resolvedBy: proposalComments.resolvedBy,
      createdAt: proposalComments.createdAt,
      updatedAt: proposalComments.updatedAt,
      authorFirst: users.firstName,
      authorLast: users.lastName,
      authorEmail: users.email,
    })
    .from(proposalComments)
    .leftJoin(users, eq(users.id, proposalComments.createdBy))
    .where(eq(proposalComments.proposalId, proposalId))
    .orderBy(asc(proposalComments.createdAt));

  return rows.map((r) => ({
    id: r.id,
    proposalId: r.proposalId,
    sectionId: r.sectionId,
    body: r.body,
    createdBy: r.createdBy,
    resolvedAt: r.resolvedAt,
    resolvedBy: r.resolvedBy,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    authorName:
      [r.authorFirst, r.authorLast].filter(Boolean).join(' ') || null,
    authorEmail: r.authorEmail,
  }));
}
