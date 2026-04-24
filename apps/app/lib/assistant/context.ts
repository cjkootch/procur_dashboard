import 'server-only';
import type { AssistantContext, PageContext } from '@procur/ai';
import { requireCompany } from '@procur/auth';

/**
 * Resolve the assistant context from the current Clerk session.
 *
 * The returned companyId and userId are guaranteed to match the caller's
 * authenticated session — the agent never receives or accepts these from
 * user input. Pass the optional pageContext when invoking the assistant
 * from a context-specific surface (pursuit page, proposal editor, etc.)
 * so the model defaults to that subject on ambiguous questions.
 */
export async function resolveAssistantContext(
  pageContext?: PageContext,
): Promise<AssistantContext & { companyName: string; planTier: string; userFirstName: string | null }> {
  const { user, company } = await requireCompany();
  return {
    companyId: company.id,
    userId: user.id,
    pageContext,
    companyName: company.name,
    planTier: company.planTier,
    userFirstName: user.firstName ?? null,
  };
}
