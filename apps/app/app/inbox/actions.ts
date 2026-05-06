'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireCompany } from '@procur/auth';
import {
  AgentRunner,
  EmailReplyDraftAgent,
  PostgresCostLedger,
} from '@procur/ai';

const DraftSchema = z.object({
  messageId: z.string().min(1),
  threadId: z.string().min(1),
});

/**
 * Server action backing the inbox "Draft reply" button. Per
 * docs/vex-into-procur-merge-brief.md Phase 3 — fires
 * EmailReplyDraftAgent via AgentRunner. The agent emits an
 * `email.send` proposed action which AgentRunner routes through
 * ApprovalGate. The reviewer sees it on /approvals; approving runs
 * the email-send executor inline.
 */
export async function draftReplyAction(formData: FormData): Promise<void> {
  await requireCompany();
  const parsed = DraftSchema.safeParse({
    messageId: formData.get('messageId'),
    threadId: formData.get('threadId'),
  });
  if (!parsed.success) return;

  const runner = new AgentRunner({ costLedger: new PostgresCostLedger() });
  const agent = new EmailReplyDraftAgent({
    messageId: parsed.data.messageId,
  });
  await runner.run(agent);

  revalidatePath(`/inbox/${parsed.data.threadId}`);
  revalidatePath('/approvals');
}
