'use server';

import { revalidatePath } from 'next/cache';
import { getCurrentUser } from '@procur/auth';
import {
  abandonMission,
  completeManualMissionStage,
} from '@procur/catalog';

/**
 * Server actions for the MissionsCard. Both validate the actor and
 * fan revalidate to the home Brief so the card re-renders without
 * a manual refresh.
 */

export async function completeMissionStageAction(formData: FormData): Promise<void> {
  const user = await getCurrentUser();
  if (!user) return;
  const missionId = String(formData.get('missionId') ?? '');
  const stageKey = String(formData.get('stageKey') ?? '');
  if (!missionId || !stageKey) return;
  await completeManualMissionStage({
    userId: user.id,
    missionId,
    stageKey,
  });
  revalidatePath('/');
}

export async function abandonMissionAction(formData: FormData): Promise<void> {
  const user = await getCurrentUser();
  if (!user) return;
  const missionId = String(formData.get('missionId') ?? '');
  if (!missionId) return;
  await abandonMission({ userId: user.id, missionId });
  revalidatePath('/');
}
