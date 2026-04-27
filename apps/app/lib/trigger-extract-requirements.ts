import 'server-only';
import { tasks } from '@trigger.dev/sdk/v3';

/**
 * Fire-and-forget the extract-requirements pipeline for an opportunity.
 *
 * Call this on every successful pursuit-create flow. The task itself is
 * idempotent — if requirements were already extracted (because another
 * tenant tracked the same opportunity earlier), it short-circuits. If
 * the opportunity has no processed documents yet, it also short-circuits
 * gracefully and the next pursuit-create will retry.
 *
 * Errors are swallowed (logged-and-continue) so a transient trigger.dev
 * outage never blocks a user from completing the pursuit-create flow.
 * The scheduled process-pending-documents sweep + the natural retry on
 * the next pursuit-create cover any drops.
 */
export async function fireExtractRequirements(opportunityId: string): Promise<void> {
  try {
    await tasks.trigger('opportunity.extract-requirements', { opportunityId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('fireExtractRequirements: trigger failed (non-fatal)', {
      opportunityId,
      error: msg,
    });
  }
}
