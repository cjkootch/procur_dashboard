import { eq } from 'drizzle-orm';
import { approvals, db } from '@procur/db';

/**
 * Executor for `mission.create` proposals (gamification slice 4).
 * Inserts a custom mission row with the operator-defined stages
 * and stamps applied_at on the approval. Idempotent — re-running
 * after applied_at is set short-circuits.
 *
 * The catalog helper `createCustomMission` is lazy-imported to
 * dodge the @procur/ai → @procur/catalog type-resolution cycle
 * (catalog already imports ai for executor entry points).
 */

export interface CreateMissionPayload {
  title: string;
  description?: string;
  stages: Array<{
    key: string;
    title: string;
    description?: string;
    xpReward: number;
  }>;
  rationale: string;
}

export function parseCreateMissionPayload(
  proposedPayload: Record<string, unknown> | null | undefined,
): CreateMissionPayload | null {
  if (!proposedPayload || typeof proposedPayload !== 'object') return null;
  const title = proposedPayload['title'];
  const stages = proposedPayload['stages'];
  const rationale = proposedPayload['rationale'];
  if (
    typeof title !== 'string' ||
    !Array.isArray(stages) ||
    stages.length < 2 ||
    typeof rationale !== 'string'
  ) {
    return null;
  }
  const out: CreateMissionPayload = {
    title,
    rationale,
    stages: stages.map((s: Record<string, unknown>) => {
      const stage: CreateMissionPayload['stages'][number] = {
        key: String(s['key']),
        title: String(s['title']),
        xpReward:
          typeof s['xpReward'] === 'number' ? (s['xpReward'] as number) : 25,
      };
      if (typeof s['description'] === 'string') {
        stage.description = s['description'] as string;
      }
      return stage;
    }),
  };
  if (typeof proposedPayload['description'] === 'string') {
    out.description = proposedPayload['description'] as string;
  }
  return out;
}

export interface CreateMissionResult {
  ok: boolean;
  missionId?: string;
  error?: string;
}

export async function applyCreateMission(
  approvalId: string,
  payload: CreateMissionPayload,
  ctx: { reviewerId: string },
): Promise<CreateMissionResult> {
  const existing = await db
    .select({ appliedAt: approvals.appliedAt })
    .from(approvals)
    .where(eq(approvals.id, approvalId))
    .limit(1);
  if (existing[0]?.appliedAt) return { ok: true };

  try {
    const catalogModule = '@procur/catalog';
    const mod = (await import(/* @vite-ignore */ catalogModule)) as {
      createCustomMission: (input: {
        userId: string;
        title: string;
        description?: string;
        stages: CreateMissionPayload['stages'] & { predicate: 'manual' }[];
        approvalId?: string;
      }) => Promise<{ id: string }>;
    };
    const stages = payload.stages.map((s) => ({
      ...s,
      predicate: 'manual' as const,
    }));
    const created = await mod.createCustomMission({
      userId: ctx.reviewerId,
      title: payload.title,
      ...(payload.description ? { description: payload.description } : {}),
      stages,
      approvalId,
    });
    await db
      .update(approvals)
      .set({ appliedObjectId: created.id, appliedAt: new Date() })
      .where(eq(approvals.id, approvalId));
    return { ok: true, missionId: created.id };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
