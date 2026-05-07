import 'server-only';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  communicationTemplates,
  db,
  type CommunicationTemplate,
  type CommunicationTemplateKindValue,
  type CommunicationTemplateVariable,
  COMMUNICATION_TEMPLATE_KINDS,
} from '@procur/db';
import { createId } from '@procur/ai';

/**
 * Communication-template catalog helpers — Cole's vex-parity request.
 * Pre-built email / SMS / WhatsApp / call bodies the chat assistant
 * references by name, with `{{variable}}` substitution at render
 * time. Distinct from `deal_structure_templates` (deal-shape) and
 * from Twilio Content Templates (managed in Twilio's dashboard;
 * we pin to them via content_sid for whatsapp_template kinds).
 *
 * Render contract:
 *   - Required vars missing → returns `{ok: false, missingVars}`.
 *   - Unknown vars passed → ignored (extra slots are forgiving).
 *   - `{{variable}}` syntax with whitespace allowed: `{{ name }}`.
 *   - Default values fill in when the var is declared but not passed.
 *
 * Usage discipline (per CLAUDE.md / brief):
 *   - The chat assistant calls list/get to discover templates,
 *     supplies the variables map, and passes the rendered body
 *     verbatim into propose_email_send / propose_sms_send / etc.
 *   - Operator approves at /approvals before any send dispatches.
 *   - templateName carries through to touchpoints metadata for
 *     audit (which template did this send come from).
 */

// ----------------------------------------------------------------------------
// Public types
// ----------------------------------------------------------------------------

export type { CommunicationTemplate, CommunicationTemplateVariable };

export interface RenderedTemplate {
  ok: true;
  templateId: string;
  templateName: string;
  kind: CommunicationTemplateKindValue;
  /** Email subject after substitution. NULL for non-email kinds. */
  subject: string | null;
  body: string;
  /** Twilio Content SID, only set for kind=whatsapp_template. */
  contentSid: string | null;
  /** Vars actually used (after defaults applied). */
  variables: Record<string, string>;
}

export interface RenderTemplateError {
  ok: false;
  reason: 'not_found' | 'archived' | 'missing_variables';
  missingVariables?: string[];
  templateName?: string;
}

export type RenderTemplateResult = RenderedTemplate | RenderTemplateError;

export interface UpsertTemplateInput {
  kind: CommunicationTemplateKindValue;
  name: string;
  displayName: string;
  body: string;
  subject?: string | null;
  contentSid?: string | null;
  variables?: CommunicationTemplateVariable[];
  description?: string;
  createdBy?: string;
}

// ----------------------------------------------------------------------------
// Read helpers
// ----------------------------------------------------------------------------

/**
 * List templates, newest first, optionally filtered by kind. Skips
 * archived rows. Hard-capped at 200.
 */
export async function listCommunicationTemplates(
  options: { kind?: CommunicationTemplateKindValue; limit?: number } = {},
): Promise<CommunicationTemplate[]> {
  const limit = Math.min(options.limit ?? 100, 200);
  const where = options.kind
    ? and(
        eq(communicationTemplates.kind, options.kind),
        isNull(communicationTemplates.archivedAt),
      )
    : isNull(communicationTemplates.archivedAt);
  return db
    .select()
    .from(communicationTemplates)
    .where(where)
    .orderBy(
      desc(communicationTemplates.lastUsedAt),
      asc(communicationTemplates.displayName),
    )
    .limit(limit);
}

/** Fetch one by (kind, name). Returns null when archived/not found. */
export async function getCommunicationTemplate(
  kind: CommunicationTemplateKindValue,
  name: string,
): Promise<CommunicationTemplate | null> {
  const rows = await db
    .select()
    .from(communicationTemplates)
    .where(
      and(
        eq(communicationTemplates.kind, kind),
        eq(communicationTemplates.name, name),
        isNull(communicationTemplates.archivedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

// ----------------------------------------------------------------------------
// Rendering
// ----------------------------------------------------------------------------

/**
 * Render a template against an operator-supplied variables map.
 * Returns the rendered subject + body, or a structured error when
 * required variables are missing.
 */
export async function renderTemplate(
  kind: CommunicationTemplateKindValue,
  name: string,
  variables: Record<string, string> = {},
): Promise<RenderTemplateResult> {
  const tmpl = await getCommunicationTemplate(kind, name);
  if (!tmpl) {
    return { ok: false, reason: 'not_found', templateName: name };
  }

  // Resolve the final variables map: caller-supplied wins, fall back
  // to defaults declared on the template's variable manifest.
  const resolved: Record<string, string> = {};
  for (const v of tmpl.variables ?? []) {
    if (variables[v.name] !== undefined) {
      resolved[v.name] = variables[v.name]!;
    } else if (v.defaultValue !== undefined) {
      resolved[v.name] = v.defaultValue;
    }
  }
  // Pass-through any extra vars the caller supplied not declared in
  // the manifest — operator might have a one-off slot they want to
  // fill. Render still substitutes if `{{name}}` appears.
  for (const [k, val] of Object.entries(variables)) {
    if (resolved[k] === undefined) resolved[k] = val;
  }

  // Required-variable check.
  const missing: string[] = [];
  for (const v of tmpl.variables ?? []) {
    if (v.required && resolved[v.name] === undefined) {
      missing.push(v.name);
    }
  }
  if (missing.length > 0) {
    return {
      ok: false,
      reason: 'missing_variables',
      missingVariables: missing,
      templateName: name,
    };
  }

  return {
    ok: true,
    templateId: tmpl.id,
    templateName: tmpl.name,
    kind: tmpl.kind,
    subject: tmpl.subject ? substitute(tmpl.subject, resolved) : null,
    body: substitute(tmpl.body, resolved),
    contentSid: tmpl.contentSid ?? null,
    variables: resolved,
  };
}

/**
 * Pure `{{variable}}` substitution. Whitespace inside braces is
 * tolerated (`{{ name }}`). Unknown placeholders pass through as-is —
 * easier to spot in a draft than a silent empty string. Exported
 * for tests.
 */
export function substitute(
  template: string,
  variables: Record<string, string>,
): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, name) => {
    return variables[name] !== undefined ? variables[name]! : match;
  });
}

// ----------------------------------------------------------------------------
// Write helpers
// ----------------------------------------------------------------------------

/**
 * Insert or update a template. Idempotent on (kind, name) — re-saving
 * with the same key updates in place. The `propose_save_template`
 * chat tool is the operator-facing path.
 */
export async function upsertCommunicationTemplate(
  input: UpsertTemplateInput,
): Promise<{ id: string; created: boolean }> {
  if (!COMMUNICATION_TEMPLATE_KINDS.includes(input.kind)) {
    throw new Error(`unknown template kind: ${input.kind}`);
  }
  if (!/^[a-z0-9_-]{1,80}$/.test(input.name)) {
    throw new Error(
      `template name must be a lowercase slug (a-z, 0-9, _, -; 1-80 chars): ${input.name}`,
    );
  }

  const existing = await db
    .select({ id: communicationTemplates.id })
    .from(communicationTemplates)
    .where(
      and(
        eq(communicationTemplates.kind, input.kind),
        eq(communicationTemplates.name, input.name),
        isNull(communicationTemplates.archivedAt),
      ),
    )
    .limit(1);

  if (existing[0]) {
    await db
      .update(communicationTemplates)
      .set({
        displayName: input.displayName,
        body: input.body,
        subject: input.subject ?? null,
        contentSid: input.contentSid ?? null,
        variables: input.variables ?? [],
        description: input.description ?? null,
        updatedAt: new Date(),
      })
      .where(eq(communicationTemplates.id, existing[0].id));
    return { id: existing[0].id, created: false };
  }

  const id = createId();
  await db.insert(communicationTemplates).values({
    id,
    kind: input.kind,
    name: input.name,
    displayName: input.displayName,
    body: input.body,
    subject: input.subject ?? null,
    contentSid: input.contentSid ?? null,
    variables: input.variables ?? [],
    description: input.description ?? null,
    createdBy: input.createdBy ?? null,
  });
  return { id, created: true };
}

/**
 * Soft-delete a template. The row stays so historical touchpoints
 * that reference it stay readable; the unique (kind, name) index is
 * partial on `archived_at IS NULL` so a new template with the same
 * slug can be created later.
 */
export async function archiveCommunicationTemplate(id: string): Promise<void> {
  await db
    .update(communicationTemplates)
    .set({ archivedAt: new Date(), updatedAt: new Date() })
    .where(eq(communicationTemplates.id, id));
}

/**
 * Bump `last_used_at` after a successful dispatch. Called by the
 * email/sms/whatsapp/call executors when their payload carried a
 * `templateName`. Idempotent — just stamps the latest time.
 */
export async function markCommunicationTemplateUsed(
  kind: CommunicationTemplateKindValue,
  name: string,
): Promise<void> {
  await db
    .update(communicationTemplates)
    .set({ lastUsedAt: new Date() })
    .where(
      and(
        eq(communicationTemplates.kind, kind),
        eq(communicationTemplates.name, name),
        isNull(communicationTemplates.archivedAt),
      ),
    );
}

// Drizzle's `sql` is referenced inside the schema's partial-index
// guard; importing here keeps tree-shaking simple for downstream
// consumers + silences unused-import lint when the helper isn't
// referenced inside a query in this file.
void sql;
