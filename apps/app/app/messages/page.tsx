import { requireCompany } from '@procur/auth';
import { MessagesShell } from './MessagesShell';

export const dynamic = 'force-dynamic';

/**
 * /messages — SMS + WhatsApp conversations grouped by counterparty
 * E.164 phone. Two-pane Outlook-style shell with phone-text bubbles
 * on the right when a conversation is selected.
 *
 * Email lives in /inbox; calls live in /calls. The shell links
 * between them in the header.
 */
export default async function MessagesPage() {
  await requireCompany();
  return <MessagesShell activePhone={null} />;
}
