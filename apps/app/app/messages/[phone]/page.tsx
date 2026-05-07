import { notFound } from 'next/navigation';
import { requireCompany } from '@procur/auth';
import { getMessagingConversation } from '@procur/catalog';
import { MessagesShell } from '../MessagesShell';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ phone: string }>;
}

/**
 * Single SMS / WhatsApp conversation — phone-text bubble view inside
 * the same /messages two-pane shell. The path segment is the URL-
 * encoded E.164 phone (leading `+` shows up as `%2B`).
 */
export default async function MessagesConversationPage({ params }: PageProps) {
  await requireCompany();
  const { phone: rawPhone } = await params;
  const phone = decodeURIComponent(rawPhone);
  // Loose E.164 validation — the actual touchpoint metadata may have
  // legacy variants (no leading +, country-code-only) so we don't
  // reject here; getMessagingConversation just won't find rows.
  const detail = await getMessagingConversation(phone);
  if (!detail) notFound();
  return <MessagesShell activePhone={phone} />;
}
