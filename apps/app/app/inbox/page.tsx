import { requireCompany } from '@procur/auth';
import { InboxShell } from './InboxShell';

export const dynamic = 'force-dynamic';

/**
 * Inbox per docs/vex-into-procur-merge-brief.md Phase 3, recast as
 * an Outlook-style two-pane shell. Bare /inbox shows the thread list
 * with an empty-state right pane; /inbox/[threadId] shows the same
 * shell with the selected thread expanded on the right.
 *
 * For SMS + WhatsApp threads (phone-text-bubble UI), see /messages.
 */
export default async function InboxPage() {
  await requireCompany();
  return <InboxShell activeThreadId={null} />;
}
