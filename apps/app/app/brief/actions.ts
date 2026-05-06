'use server';

import { revalidatePath } from 'next/cache';
import { requireCompany } from '@procur/auth';
import {
  AgentRunner,
  DailyBriefAgent,
  PostgresCostLedger,
} from '@procur/ai';

/**
 * Server action backing the `/brief` "Refresh" button. Runs the
 * DailyBriefAgent through AgentRunner so the run is recorded in
 * agent_runs + cost_ledger.
 */
export async function refreshDailyBriefAction(): Promise<void> {
  await requireCompany();
  const runner = new AgentRunner({ costLedger: new PostgresCostLedger() });
  const agent = new DailyBriefAgent();
  await runner.run(agent);
  revalidatePath('/brief');
}
