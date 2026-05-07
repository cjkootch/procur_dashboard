import { and, eq, isNull } from 'drizzle-orm';
import {
  approvals,
  communicationTemplates,
  db,
  events,
  type CommunicationTemplateKindValue,
  type CommunicationTemplateVariable,
  COMMUNICATION_TEMPLATE_KINDS,
} from '@procur/db';
import { createId } from '../agents/id';

/**
 * Executors for communication-template approvals (template.save +
 * template.archive). Both T1 — metadata writes only; no outbound
 * side effect.
 */

interface ExecutorResult {
  ok: boolean;
  appliedObjectId?: string;
  error?: string;
}

async function alreadyApplied(approvalId: string): Promise<boolean> {
  const rows = await db
    .select({ appliedAt: approvals.appliedAt })
    .from(approvals)
    .where(eq(approvals.id, approvalId))
    .limit(1);
  return rows[0]?.appliedAt != null;
}

// ----------------------------------------------------------------------------
// template.save
// ----------------------------------------------------------------------------

export interface SaveCommunicationTemplatePayload {
  templateKind: CommunicationTemplateKindValue;
  name: string;
  displayName: string;
  body: string;
  subject?: string;
  contentSid?: string;
  variables?: CommunicationTemplateVariable[];
  description?: string;
  rationale: string;
}

export function parseSaveCommunicationTemplatePayload(
  proposedPayload: Record<string, unknown> | null | undefined,
): SaveCommunicationTemplatePayload | null {
  if (!proposedPayload || typeof proposedPayload !== 'object') return null;
  const templateKind = proposedPayload['templateKind'];
  const name = proposedPayload['name'];
  const displayName = proposedPayload['displayName'];
  const body = proposedPayload['body'];
  const rationale = proposedPayload['rationale'];
  if (
    typeof templateKind !== 'string' ||
    !COMMUNICATION_TEMPLATE_KINDS.includes(
      templateKind as CommunicationTemplateKindValue,
    ) ||
    typeof name !== 'string' ||
    !/^[a-z0-9_-]{1,80}$/.test(name) ||
    typeof displayName !== 'string' ||
    typeof body !== 'string' ||
    typeof rationale !== 'string'
  ) {
    return null;
  }
  const out: SaveCommunicationTemplatePayload = {
    templateKind: templateKind as CommunicationTemplateKindValue,
    name,
    displayName,
    body,
    rationale,
  };
  if (typeof proposedPayload['subject'] === 'string') {
    out.subject = proposedPayload['subject'] as string;
  }
  if (typeof proposedPayload['contentSid'] === 'string') {
    out.contentSid = proposedPayload['contentSid'] as string;
  }
  if (typeof proposedPayload['description'] === 'string') {
    out.description = proposedPayload['description'] as string;
  }
  if (Array.isArray(proposedPayload['variables'])) {
    const vars: CommunicationTemplateVariable[] = [];
    for (const raw of proposedPayload['variables'] as unknown[]) {
      if (!raw || typeof raw !== 'object') continue;
      const r = raw as Record<string, unknown>;
      if (typeof r['name'] !== 'string') continue;
      const v: CommunicationTemplateVariable = { name: r['name'] };
      if (typeof r['description'] === 'string') v.description = r['description'];
      if (typeof r['required'] === 'boolean') v.required = r['required'];
      if (typeof r['defaultValue'] === 'string')
        v.defaultValue = r['defaultValue'] as string;
      vars.push(v);
    }
    out.variables = vars;
  }
  return out;
}

export async function applySaveCommunicationTemplate(
  approvalId: string,
  payload: SaveCommunicationTemplatePayload,
  reviewerId: string | null,
): Promise<ExecutorResult> {
  if (await alreadyApplied(approvalId)) return { ok: true };

  const occurredAt = new Date();
  const existing = await db
    .select({ id: communicationTemplates.id })
    .from(communicationTemplates)
    .where(
      and(
        eq(communicationTemplates.kind, payload.templateKind),
        eq(communicationTemplates.name, payload.name),
        isNull(communicationTemplates.archivedAt),
      ),
    )
    .limit(1);

  let id: string;
  let created: boolean;
  if (existing[0]) {
    id = existing[0].id;
    created = false;
    await db
      .update(communicationTemplates)
      .set({
        displayName: payload.displayName,
        body: payload.body,
        subject: payload.subject ?? null,
        contentSid: payload.contentSid ?? null,
        variables: payload.variables ?? [],
        description: payload.description ?? null,
        updatedAt: occurredAt,
      })
      .where(eq(communicationTemplates.id, id));
  } else {
    id = createId();
    created = true;
    await db.insert(communicationTemplates).values({
      id,
      kind: payload.templateKind,
      name: payload.name,
      displayName: payload.displayName,
      body: payload.body,
      subject: payload.subject ?? null,
      contentSid: payload.contentSid ?? null,
      variables: payload.variables ?? [],
      description: payload.description ?? null,
      createdBy: reviewerId,
    });
  }

  await db
    .update(approvals)
    .set({ appliedObjectId: id, appliedAt: occurredAt })
    .where(eq(approvals.id, approvalId));

  await db
    .insert(events)
    .values({
      id: createId(),
      verb: 'template.saved',
      subjectType: 'approval',
      subjectId: approvalId,
      actorType: 'system',
      actorId: 'communication-templates-executor',
      objectType: 'communication_template',
      objectId: id,
      occurredAt,
      idempotencyKey: `template.saved:${approvalId}`,
      metadata: {
        template_kind: payload.templateKind,
        name: payload.name,
        created,
      },
    })
    .onConflictDoNothing({
      target: [events.occurredAt, events.idempotencyKey],
    });

  return { ok: true, appliedObjectId: id };
}

// ----------------------------------------------------------------------------
// template.archive
// ----------------------------------------------------------------------------

export interface ArchiveCommunicationTemplatePayload {
  templateId: string;
  rationale: string;
}

export function parseArchiveCommunicationTemplatePayload(
  proposedPayload: Record<string, unknown> | null | undefined,
): ArchiveCommunicationTemplatePayload | null {
  if (!proposedPayload || typeof proposedPayload !== 'object') return null;
  const templateId = proposedPayload['templateId'];
  const rationale = proposedPayload['rationale'];
  if (typeof templateId !== 'string' || typeof rationale !== 'string') {
    return null;
  }
  return { templateId, rationale };
}

export async function applyArchiveCommunicationTemplate(
  approvalId: string,
  payload: ArchiveCommunicationTemplatePayload,
): Promise<ExecutorResult> {
  if (await alreadyApplied(approvalId)) return { ok: true };

  const occurredAt = new Date();
  await db
    .update(communicationTemplates)
    .set({ archivedAt: occurredAt, updatedAt: occurredAt })
    .where(eq(communicationTemplates.id, payload.templateId));

  await db
    .update(approvals)
    .set({ appliedObjectId: payload.templateId, appliedAt: occurredAt })
    .where(eq(approvals.id, approvalId));

  await db
    .insert(events)
    .values({
      id: createId(),
      verb: 'template.archived',
      subjectType: 'approval',
      subjectId: approvalId,
      actorType: 'system',
      actorId: 'communication-templates-executor',
      objectType: 'communication_template',
      objectId: payload.templateId,
      occurredAt,
      idempotencyKey: `template.archived:${approvalId}`,
      metadata: { template_id: payload.templateId },
    })
    .onConflictDoNothing({
      target: [events.occurredAt, events.idempotencyKey],
    });

  return { ok: true, appliedObjectId: payload.templateId };
}
