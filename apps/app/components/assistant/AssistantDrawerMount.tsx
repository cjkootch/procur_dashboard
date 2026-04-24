import { getCurrentCompany, getCurrentUser } from '@procur/auth';
import { AssistantDrawer } from './AssistantDrawer';

/**
 * Server component that only renders the Cmd+K drawer if the user is
 * authenticated and has a company. Avoids flashing the launcher on
 * /sign-in, /sign-up, and /onboarding.
 */
export async function AssistantDrawerMount() {
  const [user, company] = await Promise.all([getCurrentUser(), getCurrentCompany()]);
  if (!user || !company) return null;
  return <AssistantDrawer />;
}
