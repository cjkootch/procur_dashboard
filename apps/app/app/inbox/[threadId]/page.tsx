import { notFound } from 'next/navigation';
import { requireCompany } from '@procur/auth';
import { getThreadDetail } from '@procur/catalog';
import { InboxShell } from '../InboxShell';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ threadId: string }>;
}

/**
 * Thread detail per docs/vex-into-procur-merge-brief.md Phase 3.
 * Renders inside the same Outlook-style two-pane shell as /inbox —
 * the URL just selects which thread is expanded on the right.
 *
 * 404s when the thread id is unknown (rather than rendering an
 * empty-state pane) so deep-links to deleted/merged threads break
 * loudly instead of looking like the inbox is broken.
 */
export default async function ThreadDetailPage({ params }: PageProps) {
  await requireCompany();
  const { threadId } = await params;
  const detail = await getThreadDetail(threadId);
  if (!detail) notFound();
  return <InboxShell activeThreadId={threadId} />;
}
