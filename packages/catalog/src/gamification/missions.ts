import 'server-only';
import { and, asc, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import {
  db,
  missionInstances,
  notifications,
  users,
  type CustomStageDef,
  type MissionInstanceRow,
} from '@procur/db';
import { awardXp } from './award';

/**
 * Mission layer (gamification slice 4). Two flavors share the same
 * mission_instances table:
 *   - REGISTERED (kind='deal_lifecycle' for v1) — stages defined in
 *     MISSION_REGISTRY below; predicates run as SQL counts.
 *   - CUSTOM (kind='custom') — stages stored inline as JSONB on the
 *     row. Operator marks each stage complete from the UI.
 *
 * The UI render path doesn't branch on kind — both produce the same
 * `MissionView` shape via `listActiveMissions(userId)`.
 *
 * Trigger surface:
 *   - `spawnDealLifecycleMissions(userId)` is called from the home
 *     page render. Idempotent; ensures one active mission per
 *     active fuel_deal.
 *   - `evaluateAutomatedMissions(userId)` runs after a successful
 *     awardXp credit (fire-and-forget) AND on the home page render.
 *     Idempotent — already-completed stages are skipped.
 */

export type MissionStagePredicate =
  | { kind: 'manual' }
  | {
      kind: 'sql_exists';
      sql: (subjectId: string, userId: string) => ReturnType<typeof sql>;
    }
  | {
      kind: 'sql_count_at_least';
      threshold: number;
      sql: (subjectId: string, userId: string) => ReturnType<typeof sql>;
    };

export interface RegisteredStage {
  key: string;
  title: string;
  description: string;
  xpReward: number;
  predicate: MissionStagePredicate;
}

export interface RegisteredMission {
  kind: string;
  /** What entity the mission tracks. Used to resolve the subject. */
  subjectType: 'fuel_deal';
  /** Title shown on the card; supports {subjectName} interpolation. */
  titleTemplate: string;
  description: string;
  stages: RegisteredStage[];
  /** Bonus XP credited when ALL stages complete. */
  completionBonus: number;
}

/**
 * Registered mission catalog. New mission kinds land by adding
 * entries here — no migration required. Each mission also needs:
 *   - a spawn function in the data-trigger pass (e.g.
 *     spawnDealLifecycleMissions for fuel_deals)
 *   - subject-name resolution (the title interpolation)
 */
export const MISSION_REGISTRY: RegisteredMission[] = [
  {
    kind: 'deal_lifecycle',
    subjectType: 'fuel_deal',
    titleTemplate: 'Run the {subjectName} deal',
    description:
      'Walk the deal from KYC through close. Each stage credits XP; finishing all four hits the bonus.',
    completionBonus: 100,
    stages: [
      {
        key: 'kyc',
        title: 'KYC the seller',
        description:
          'Mark the deal’s seller as approved (with or without formal KYC docs).',
        xpReward: 50,
        predicate: {
          kind: 'sql_exists',
          // Stage passes when the deal’s seller_org has a supplier_approval
          // row in an approved status (matched via organizations.external_keys
          // → known_entities.slug).
          sql: (subjectId) => sql`
            SELECT EXISTS (
              SELECT 1
              FROM fuel_deals d
              JOIN organizations o ON o.id = d.seller_org_id
              JOIN supplier_approvals s
                ON s.entity_slug = (o.external_keys->>'known_entity_slug')
              WHERE d.id = ${subjectId}
                AND s.status IN ('approved_with_kyc', 'approved_without_kyc')
            ) AS ok
          `,
        },
      },
      {
        key: 'first_outreach',
        title: 'Send first outreach',
        description:
          'Send any sms / email / whatsapp outreach to the seller after the deal opens.',
        xpReward: 50,
        predicate: {
          kind: 'sql_exists',
          sql: (subjectId) => sql`
            SELECT EXISTS (
              SELECT 1
              FROM fuel_deals d
              JOIN organizations o ON o.id = d.seller_org_id
              JOIN events e
                ON e.metadata->>'entity_slug' = (o.external_keys->>'known_entity_slug')
              WHERE d.id = ${subjectId}
                AND e.verb = 'outreach.sent'
                AND e.occurred_at >= d.created_at
            ) AS ok
          `,
        },
      },
      {
        key: 'reply',
        title: 'Counterparty replied',
        description: 'A reply lands on a thread tied to the seller.',
        xpReward: 75,
        predicate: {
          kind: 'sql_exists',
          sql: (subjectId) => sql`
            SELECT EXISTS (
              SELECT 1
              FROM fuel_deals d
              JOIN organizations o ON o.id = d.seller_org_id
              JOIN events e
                ON e.metadata->>'entity_slug' = (o.external_keys->>'known_entity_slug')
              WHERE d.id = ${subjectId}
                AND e.verb = 'outreach.replied'
                AND e.occurred_at >= d.created_at
            ) AS ok
          `,
        },
      },
      {
        key: 'win',
        title: 'Close the deal as won',
        description: 'Submit a retrospective with deal_outcome=‘won’.',
        xpReward: 200,
        predicate: {
          kind: 'sql_exists',
          sql: (subjectId) => sql`
            SELECT EXISTS (
              SELECT 1 FROM deal_retrospectives
              WHERE deal_id = ${subjectId}
                AND deal_outcome = 'won'
                AND completed_at IS NOT NULL
            ) AS ok
          `,
        },
      },
    ],
  },
];

function getRegisteredMission(kind: string): RegisteredMission | null {
  return MISSION_REGISTRY.find((m) => m.kind === kind) ?? null;
}

// ─── Spawn ──────────────────────────────────────────────────────────

/**
 * Ensure one active deal_lifecycle mission exists per non-terminal
 * fuel_deal owned by the company. Idempotent on the
 * (user_id, kind, subject_id) unique partial index — re-running
 * never inserts duplicates. Closed/won/lost/dead deals don’t
 * spawn fresh missions; if one already exists for them it stays.
 */
export async function spawnDealLifecycleMissions(
  userId: string,
): Promise<{ spawned: number }> {
  try {
    const rows = await db.execute<{
      id: string;
      label: string | null;
      buyer_name: string | null;
      seller_name: string | null;
    }>(sql`
      SELECT
        d.id,
        d.deal_label AS label,
        bo.name AS buyer_name,
        so.name AS seller_name
      FROM fuel_deals d
      LEFT JOIN organizations bo ON bo.id = d.buyer_org_id
      LEFT JOIN organizations so ON so.id = d.seller_org_id
      WHERE d.status IN ('draft', 'live')
    `);
    let spawned = 0;
    for (const r of rows.rows) {
      const subjectName =
        r.label ||
        [r.buyer_name, r.seller_name].filter(Boolean).join(' / ') ||
        'untitled deal';
      const inserted = await db
        .insert(missionInstances)
        .values({
          userId,
          kind: 'deal_lifecycle',
          subjectType: 'fuel_deal',
          subjectId: r.id,
          title: `Run the ${subjectName} deal`,
          description: MISSION_REGISTRY[0]!.description,
          customStages: null,
          status: 'active',
        })
        .onConflictDoNothing({
          target: [
            missionInstances.userId,
            missionInstances.kind,
            missionInstances.subjectId,
          ],
        })
        .returning({ id: missionInstances.id });
      if (inserted.length > 0) spawned += 1;
    }
    return { spawned };
  } catch (err) {
    console.error('[gamification] spawnDealLifecycleMissions failed', err);
    return { spawned: 0 };
  }
}

// ─── Evaluate ───────────────────────────────────────────────────────

/**
 * Run automated stage predicates on every active registered mission;
 * mark newly-passing stages complete, credit their xpReward, and fire
 * a mission_stage_complete notification. When all stages of a mission
 * pass, mark mission complete + credit completionBonus + fire a
 * mission_complete notification.
 *
 * Called fire-and-forget after awardXp and on home page render.
 * Errors are swallowed.
 */
export async function evaluateAutomatedMissions(
  userId: string,
): Promise<{ stagesCompleted: number; missionsCompleted: number }> {
  let stagesCompleted = 0;
  let missionsCompleted = 0;
  try {
    const rows = await db
      .select()
      .from(missionInstances)
      .where(
        and(
          eq(missionInstances.userId, userId),
          eq(missionInstances.status, 'active'),
          isNotNull(missionInstances.subjectId),
        ),
      );
    for (const m of rows) {
      const reg = getRegisteredMission(m.kind);
      if (!reg) continue;
      if (!m.subjectId) continue;
      const completions = { ...(m.stageCompletions ?? {}) };
      let mutated = false;
      for (const stage of reg.stages) {
        if (completions[stage.key]) continue;
        if (stage.predicate.kind !== 'sql_exists') continue;
        const result = await db.execute<{ ok: boolean }>(
          stage.predicate.sql(m.subjectId, userId),
        );
        if (!result.rows[0]?.ok) continue;
        completions[stage.key] = new Date().toISOString();
        mutated = true;
        stagesCompleted += 1;
        await awardXp({
          userId,
          sourceTable: 'mission_stage',
          sourceId: `${m.id}:${stage.key}`,
          verb: `mission.stage.${reg.kind}.${stage.key}`,
          points: stage.xpReward,
          reason: `Mission stage: ${stage.title}`,
        });
        await fanoutMissionNotification({
          userId,
          type: 'gamification.mission_stage_complete',
          title: `Stage complete — ${stage.title}`,
          body: `+${stage.xpReward} XP • ${m.title}`,
        });
      }
      const allComplete = reg.stages.every((s) => completions[s.key]);
      const updates: Partial<MissionInstanceRow> = {};
      if (mutated) updates.stageCompletions = completions;
      if (allComplete && m.status === 'active') {
        updates.status = 'complete';
        updates.completedAt = new Date();
        missionsCompleted += 1;
      }
      if (Object.keys(updates).length > 0) {
        await db
          .update(missionInstances)
          .set(updates)
          .where(eq(missionInstances.id, m.id));
      }
      if (allComplete && m.status === 'active') {
        await awardXp({
          userId,
          sourceTable: 'mission',
          sourceId: m.id,
          verb: `mission.complete.${reg.kind}`,
          points: reg.completionBonus,
          reason: `Mission complete: ${m.title}`,
        });
        await fanoutMissionNotification({
          userId,
          type: 'gamification.mission_complete',
          title: `Mission complete — ${m.title}`,
          body: `+${reg.completionBonus} XP bonus`,
        });
      }
    }
  } catch (err) {
    console.error('[gamification] evaluateAutomatedMissions failed', err);
  }
  return { stagesCompleted, missionsCompleted };
}

async function fanoutMissionNotification(input: {
  userId: string;
  type: string;
  title: string;
  body: string;
}): Promise<void> {
  try {
    const userRow = await db
      .select({ companyId: users.companyId })
      .from(users)
      .where(and(eq(users.id, input.userId), isNotNull(users.companyId)))
      .limit(1);
    const companyId = userRow[0]?.companyId ?? null;
    if (!companyId) return;
    await db.insert(notifications).values({
      userId: input.userId,
      companyId,
      type: input.type,
      title: input.title,
      body: input.body,
      link: '/',
      entityType: null,
      entityId: null,
    });
  } catch (err) {
    console.error('[gamification] mission notification failed', err);
  }
}

// ─── Custom missions (chat-proposed) ────────────────────────────────

export interface CreateCustomMissionInput {
  userId: string;
  title: string;
  description?: string;
  stages: CustomStageDef[];
  approvalId?: string;
}

/**
 * Insert a custom mission with operator-defined stages. Called by the
 * mission.create executor when the assistant’s
 * propose_create_mission proposal is approved.
 */
export async function createCustomMission(
  input: CreateCustomMissionInput,
): Promise<{ id: string }> {
  const inserted = await db
    .insert(missionInstances)
    .values({
      userId: input.userId,
      kind: 'custom',
      subjectType: null,
      subjectId: null,
      title: input.title,
      description: input.description ?? null,
      customStages: input.stages,
      status: 'active',
      approvalId: input.approvalId ?? null,
    })
    .returning({ id: missionInstances.id });
  return { id: inserted[0]!.id };
}

/**
 * Mark a manual stage on a custom mission complete. Idempotent on
 * the stage_completions JSONB — calling twice is a no-op the second
 * time. Awards the stage’s xpReward + completionBonus when this
 * was the last stage. Called from a server action wired to the
 * "Mark done" button on the MissionsCard.
 */
export async function completeManualMissionStage(input: {
  userId: string;
  missionId: string;
  stageKey: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const [m] = await db
    .select()
    .from(missionInstances)
    .where(
      and(
        eq(missionInstances.id, input.missionId),
        eq(missionInstances.userId, input.userId),
      ),
    )
    .limit(1);
  if (!m) return { ok: false, reason: 'not_found' };
  if (m.status !== 'active') {
    return { ok: false, reason: 'not_active' };
  }
  if (m.kind !== 'custom') {
    return { ok: false, reason: 'not_a_custom_mission' };
  }
  const stages = (m.customStages ?? []) as CustomStageDef[];
  const stage = stages.find((s) => s.key === input.stageKey);
  if (!stage) return { ok: false, reason: 'unknown_stage' };
  const completions = { ...(m.stageCompletions ?? {}) };
  if (completions[input.stageKey]) {
    return { ok: true };
  }
  completions[input.stageKey] = new Date().toISOString();
  const allComplete = stages.every((s) => completions[s.key]);
  await db
    .update(missionInstances)
    .set({
      stageCompletions: completions,
      ...(allComplete
        ? { status: 'complete', completedAt: new Date() }
        : {}),
    })
    .where(eq(missionInstances.id, input.missionId));

  await awardXp({
    userId: input.userId,
    sourceTable: 'mission_stage',
    sourceId: `${m.id}:${input.stageKey}`,
    verb: `mission.stage.custom.${input.stageKey}`,
    points: stage.xpReward,
    reason: `Mission stage: ${stage.title}`,
  });
  await fanoutMissionNotification({
    userId: input.userId,
    type: 'gamification.mission_stage_complete',
    title: `Stage complete — ${stage.title}`,
    body: `+${stage.xpReward} XP • ${m.title}`,
  });

  if (allComplete) {
    // Custom missions get a smaller completion bonus than registered
    // ones since the operator wrote them — 50 XP felt right.
    await awardXp({
      userId: input.userId,
      sourceTable: 'mission',
      sourceId: m.id,
      verb: 'mission.complete.custom',
      points: 50,
      reason: `Mission complete: ${m.title}`,
    });
    await fanoutMissionNotification({
      userId: input.userId,
      type: 'gamification.mission_complete',
      title: `Mission complete — ${m.title}`,
      body: '+50 XP bonus',
    });
  }
  return { ok: true };
}

/** Move an active mission to abandoned. Lets the operator dismiss
 *  missions they don’t want to pursue. */
export async function abandonMission(input: {
  userId: string;
  missionId: string;
}): Promise<{ ok: true }> {
  await db
    .update(missionInstances)
    .set({ status: 'abandoned', abandonedAt: new Date() })
    .where(
      and(
        eq(missionInstances.id, input.missionId),
        eq(missionInstances.userId, input.userId),
      ),
    );
  return { ok: true };
}

// ─── Read API ───────────────────────────────────────────────────────

export interface MissionStageView {
  key: string;
  title: string;
  description: string;
  xpReward: number;
  /** When the stage completed (ISO string from JSONB), or null. */
  completedAt: string | null;
  /** True for registered missions — stage auto-evaluates. False for
   *  custom missions — operator clicks "Mark done". */
  automated: boolean;
}

export interface MissionView {
  id: string;
  kind: string;
  title: string;
  description: string | null;
  status: 'active' | 'complete' | 'abandoned';
  stages: MissionStageView[];
  createdAt: Date;
  completedAt: Date | null;
  /** Convenience: stagesCompleted / stagesTotal. */
  progress: { completed: number; total: number };
  completionBonus: number;
}

/**
 * Active + recently-completed missions for the home Brief and
 * /missions page. Returns active first (newest first), then
 * complete (most recent first), capped at `limit`. Abandoned
 * missions are excluded — they’re a soft-delete.
 */
export async function listActiveMissions(
  userId: string,
  options: { limit?: number; includeComplete?: boolean } = {},
): Promise<MissionView[]> {
  const limit = options.limit ?? 5;
  const rows = await db
    .select()
    .from(missionInstances)
    .where(
      and(
        eq(missionInstances.userId, userId),
        options.includeComplete
          ? sql`status IN ('active','complete')`
          : eq(missionInstances.status, 'active'),
      ),
    )
    .orderBy(asc(missionInstances.status), desc(missionInstances.createdAt))
    .limit(limit);

  return rows.map((m) => toMissionView(m));
}

function toMissionView(m: MissionInstanceRow): MissionView {
  const completions = (m.stageCompletions ?? {}) as Record<string, string>;
  let stages: MissionStageView[] = [];
  let completionBonus = 0;
  if (m.kind === 'custom') {
    const list = (m.customStages ?? []) as CustomStageDef[];
    stages = list.map((s) => ({
      key: s.key,
      title: s.title,
      description: s.description ?? '',
      xpReward: s.xpReward,
      completedAt: completions[s.key] ?? null,
      automated: false,
    }));
    completionBonus = 50;
  } else {
    const reg = getRegisteredMission(m.kind);
    if (reg) {
      stages = reg.stages.map((s) => ({
        key: s.key,
        title: s.title,
        description: s.description,
        xpReward: s.xpReward,
        completedAt: completions[s.key] ?? null,
        automated: s.predicate.kind !== 'manual',
      }));
      completionBonus = reg.completionBonus;
    }
  }
  const completed = stages.filter((s) => s.completedAt).length;
  return {
    id: m.id,
    kind: m.kind,
    title: m.title,
    description: m.description ?? null,
    status: m.status as 'active' | 'complete' | 'abandoned',
    stages,
    createdAt: m.createdAt,
    completedAt: m.completedAt ?? null,
    progress: { completed, total: stages.length },
    completionBonus,
  };
}

// Suppress unused-import lint on isNull (kept for future filter on
// abandoned_at when we add a /missions archive view).
void isNull;
