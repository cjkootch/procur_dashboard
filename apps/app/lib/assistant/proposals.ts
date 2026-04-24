import 'server-only';
import { z } from 'zod';

/**
 * Shared shape for every write tool's output. Write tools never touch
 * the DB directly — they return a Proposal the UI renders as a
 * confirmation card. The user's "Apply" action POSTs the applyPayload to
 * /api/assistant/apply, which looks up the tool name in APPLY_HANDLERS
 * and executes the real mutation under the user's session.
 *
 * proposalId is a uuid emitted by the tool so repeat applies can be
 * detected as idempotent (future work — v1 just checks the audit log).
 */
export const Proposal = z.object({
  proposalId: z.string(),
  toolName: z.string(),
  title: z.string(),
  description: z.string(),
  preview: z.record(z.unknown()),
  applyPayload: z.record(z.unknown()),
});

export type ProposalT = z.infer<typeof Proposal>;
