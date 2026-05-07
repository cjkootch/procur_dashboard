'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import {
  archiveCommunicationTemplate,
  upsertCommunicationTemplate,
} from '@procur/catalog';
import type { CommunicationTemplateVariable } from '@procur/db';
import { requireCompany } from '@procur/auth';

/**
 * Server actions backing /settings/templates. The operator manages
 * their own library here — direct upsert (no /approvals gate); the
 * chat-tool path uses propose_save_template if the operator wants
 * the assistant to author a change with an audit trail.
 *
 * Idempotent on (kind, name): re-saving with the same key updates
 * in place. Archive is soft-delete; the unique slug index is partial
 * on archived_at IS NULL so a fresh template with the same slug
 * works later.
 */

const TEMPLATE_KINDS = [
  'email',
  'sms',
  'whatsapp',
  'whatsapp_template',
  'call',
] as const;

const SaveSchema = z.object({
  kind: z.enum(TEMPLATE_KINDS),
  name: z
    .string()
    .regex(
      /^[a-z0-9_-]{1,80}$/,
      'name must be lowercase slug (a-z, 0-9, _, -; 1-80 chars)',
    ),
  displayName: z.string().min(1).max(200),
  subject: z.string().max(500).optional(),
  body: z.string().min(1).max(50_000),
  contentSid: z
    .string()
    .regex(/^HX[a-fA-F0-9]{32}$/, 'contentSid must be HX + 32 hex chars')
    .optional()
    .or(z.literal('')),
  variablesText: z.string().max(20_000).optional(),
  description: z.string().max(2000).optional(),
});

export async function saveTemplateAction(formData: FormData): Promise<void> {
  const { user } = await requireCompany();
  const parsed = SaveSchema.safeParse({
    kind: formData.get('kind')?.toString() ?? '',
    name: formData.get('name')?.toString() ?? '',
    displayName: formData.get('displayName')?.toString() ?? '',
    subject: formData.get('subject')?.toString() || undefined,
    body: formData.get('body')?.toString() ?? '',
    contentSid: formData.get('contentSid')?.toString() || undefined,
    variablesText: formData.get('variablesText')?.toString() ?? '',
    description: formData.get('description')?.toString() || undefined,
  });
  if (!parsed.success) {
    // Bubble validation up via redirect with error param. Quick MVP;
    // future polish: useActionState for inline form errors like the
    // email settings page does.
    redirect(
      `/settings/templates?error=${encodeURIComponent(parsed.error.issues[0]?.message ?? 'invalid input')}`,
    );
  }

  const variables = parseVariablesText(parsed.data.variablesText ?? '');
  await upsertCommunicationTemplate({
    kind: parsed.data.kind,
    name: parsed.data.name,
    displayName: parsed.data.displayName,
    body: parsed.data.body,
    subject: parsed.data.subject ?? null,
    contentSid:
      parsed.data.kind === 'whatsapp_template'
        ? parsed.data.contentSid || null
        : null,
    variables,
    description: parsed.data.description,
    createdBy: user.id,
  });
  revalidatePath('/settings/templates');
  redirect('/settings/templates');
}

export async function archiveTemplateAction(formData: FormData): Promise<void> {
  await requireCompany();
  const id = formData.get('id')?.toString() ?? '';
  if (!id) return;
  await archiveCommunicationTemplate(id);
  revalidatePath('/settings/templates');
}

/**
 * Parse the form's `variablesText` field. Each non-empty line is one
 * variable in `name | description | required(true|false) | default`
 * pipe-separated format. Lenient — only `name` is required; the
 * other fields are optional.
 *
 * Example:
 *   recipient_name | Recipient first name | true
 *   discharge_port | Port of discharge      |       | Varreux
 */
function parseVariablesText(text: string): CommunicationTemplateVariable[] {
  const out: CommunicationTemplateVariable[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split('|').map((p) => p.trim());
    const name = parts[0];
    if (!name || !/^[a-zA-Z0-9_]+$/.test(name)) continue;
    const v: CommunicationTemplateVariable = { name };
    if (parts[1]) v.description = parts[1];
    if (parts[2] && /^(true|required|yes|y)$/i.test(parts[2])) {
      v.required = true;
    }
    if (parts[3]) v.defaultValue = parts[3];
    out.push(v);
  }
  return out;
}
