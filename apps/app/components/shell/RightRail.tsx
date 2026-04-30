import { getCurrentCompany, getCurrentUser } from '@procur/auth';
import { RightRailPanel } from './RightRailPanel';

/**
 * Server-side mount point for the shell's right rail. Only renders
 * the interactive panel if the user is authenticated and has a
 * company — avoids flashing the launcher on /sign-in, /sign-up, and
 * /onboarding.
 *
 * Replaces the previous <AssistantDrawerMount />. The rail is the
 * future home for operator-facing surfaces (autonomy feed, recent
 * activity, approvals queue); v1 surfaces the assistant chat only.
 */
export async function RightRail() {
  const [user, company] = await Promise.all([getCurrentUser(), getCurrentCompany()]);
  if (!user || !company) return null;
  return <RightRailPanel />;
}
