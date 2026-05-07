import {
  listCommunicationTemplates,
  type CommunicationTemplate,
  type CommunicationTemplateVariable,
} from '@procur/catalog';
import type { CommunicationTemplateKindValue } from '@procur/db';
import { requireCompany } from '@procur/auth';
import { archiveTemplateAction, saveTemplateAction } from './actions';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ new?: string; edit?: string; error?: string }>;
}

interface SectionConfig {
  kind: CommunicationTemplateKindValue;
  heading: string;
  description: string;
  /** Subject field is shown on the form for these kinds. */
  hasSubject: boolean;
  /** Twilio Content SID field (HX + 32 hex). */
  hasContentSid: boolean;
}

const SECTIONS: SectionConfig[] = [
  {
    kind: 'whatsapp_template',
    heading: 'WhatsApp templates',
    description:
      "Meta-approved Content Templates registered in Twilio. Used for cold outreach (the recipient hasn't messaged us in the last 24h). Variables are positional — {{1}}, {{2}} — to match Twilio's contentVariables format.",
    hasSubject: false,
    hasContentSid: true,
  },
  {
    kind: 'email',
    heading: 'Email templates',
    description:
      'Subject + body with named placeholders. The chat agent resolves variables from the evidence pack at send time.',
    hasSubject: true,
    hasContentSid: false,
  },
  {
    kind: 'sms',
    heading: 'SMS templates',
    description:
      'Free-form SMS bodies. Use named placeholders like {{recipient_name}}; chat fills them at send time.',
    hasSubject: false,
    hasContentSid: false,
  },
  {
    kind: 'whatsapp',
    heading: 'WhatsApp freeform templates',
    description:
      "Freeform WhatsApp bodies (only valid inside Twilio's 24-hour conversation window). For cold outreach use a WhatsApp Content Template instead.",
    hasSubject: false,
    hasContentSid: false,
  },
  {
    kind: 'call',
    heading: 'Call templates',
    description:
      'Call goal + AI-mode system-prompt boilerplate. Operator references these by name when proposing an outbound call.',
    hasSubject: false,
    hasContentSid: false,
  },
];

/**
 * /settings/templates — operator-managed library of communication
 * templates the chat agent can reference by name. Layout matches
 * the vex screenshot Cole shared: section per kind (description +
 * cards + "+ Add") with each card showing slug + (HX-id or subject)
 * + description + body excerpt + variable chips + Edit / Delete.
 *
 * Edit/Delete + Add use direct server actions (operator IS the
 * approver here). The chat-tool path uses propose_save_template /
 * propose_archive_template when the assistant authors a change so
 * the audit trail stays clean.
 */
export default async function TemplatesPage({ searchParams }: PageProps) {
  await requireCompany();
  const sp = await searchParams;
  const templates = await listCommunicationTemplates({ limit: 200 });
  const grouped = new Map<CommunicationTemplateKindValue, CommunicationTemplate[]>();
  for (const t of templates) {
    const arr = grouped.get(t.kind) ?? [];
    arr.push(t);
    grouped.set(t.kind, arr);
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 md:px-8 md:py-10">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Templates</h1>
        <p className="mt-2 max-w-2xl text-sm text-[color:var(--color-muted-foreground)]">
          Operator-authored templates the chat assistant applies when you ask
          for them by name (e.g. <em>&ldquo;send acme the welcome email&rdquo;</em>).
          Untemplated freeform sends still work the same way — templates are
          an opt-in library. Variables use named placeholders like{' '}
          <code className="rounded-sm bg-[color:var(--color-muted)]/60 px-1 font-mono">
            {'{{recipient_name}}'}
          </code>{' '}
          ; the chat agent resolves them from the evidence pack at send time.
        </p>
        {sp.error && (
          <div className="mt-4 rounded-[var(--radius-md)] border border-red-200 bg-red-50 px-4 py-2 text-xs text-red-800">
            <strong>Couldn&apos;t save:</strong> {sp.error}
          </div>
        )}
      </header>

      {SECTIONS.map((section) => (
        <Section
          key={section.kind}
          config={section}
          templates={grouped.get(section.kind) ?? []}
          editingId={sp.edit ?? null}
          newKind={(sp.new as CommunicationTemplateKindValue) ?? null}
        />
      ))}
    </div>
  );
}

function Section({
  config,
  templates,
  editingId,
  newKind,
}: {
  config: SectionConfig;
  templates: CommunicationTemplate[];
  editingId: string | null;
  newKind: CommunicationTemplateKindValue | null;
}) {
  const showNewForm = newKind === config.kind;
  return (
    <section className="mb-10">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
        {config.heading}
      </h2>
      <p className="mt-1 max-w-2xl text-xs text-[color:var(--color-muted-foreground)]">
        {config.description}
      </p>

      <div className="mt-4 space-y-3">
        {templates.map((t) => (
          <TemplateCard
            key={t.id}
            template={t}
            section={config}
            editing={editingId === t.id}
          />
        ))}

        {showNewForm ? (
          <TemplateForm
            section={config}
            template={null}
            cancelHref="/settings/templates"
          />
        ) : (
          <a
            href={`/settings/templates?new=${config.kind}`}
            className="inline-block rounded-[var(--radius-md)] border border-dashed border-[color:var(--color-border)] px-3 py-2 text-xs text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"
          >
            + Add {config.heading.replace(/ templates$/, '')} template
          </a>
        )}
      </div>
    </section>
  );
}

function TemplateCard({
  template,
  section,
  editing,
}: {
  template: CommunicationTemplate;
  section: SectionConfig;
  editing: boolean;
}) {
  if (editing) {
    return (
      <TemplateForm
        section={section}
        template={template}
        cancelHref="/settings/templates"
      />
    );
  }
  return (
    <article className="rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4">
      <header className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-baseline gap-2">
            <code className="font-mono text-sm font-semibold">
              {template.name}
            </code>
            {template.contentSid && (
              <span className="font-mono text-[10px] uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
                {template.contentSid}
              </span>
            )}
            {template.subject && (
              <span className="text-[10px] uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
                {template.subject}
              </span>
            )}
          </div>
          {template.description && (
            <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">
              {template.description}
            </p>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          <a
            href={`/settings/templates?edit=${template.id}`}
            className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2.5 py-1 text-xs font-medium hover:border-[color:var(--color-foreground)]"
          >
            Edit
          </a>
          <form action={archiveTemplateAction}>
            <input type="hidden" name="id" value={template.id} />
            <button
              type="submit"
              className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2.5 py-1 text-xs font-medium hover:border-red-700 hover:text-red-700"
            >
              Delete
            </button>
          </form>
        </div>
      </header>
      <pre className="mt-3 max-h-56 overflow-y-auto whitespace-pre-wrap break-words rounded-[var(--radius-sm)] bg-[color:var(--color-muted)]/30 px-3 py-2 font-mono text-xs">
        {template.body}
      </pre>
      {template.variables && template.variables.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {template.variables.map((v) => (
            <code
              key={v.name}
              className="rounded-sm bg-[color:var(--color-muted)]/60 px-1.5 py-0.5 font-mono text-[10px]"
              title={v.description ?? undefined}
            >
              {`{{${v.name}}}`}
              {v.required && <span className="ml-1 text-red-700">*</span>}
            </code>
          ))}
        </div>
      )}
      <p className="mt-3 text-[10px] text-[color:var(--color-muted-foreground)]">
        Updated{' '}
        <time dateTime={template.updatedAt.toISOString()}>
          {template.updatedAt.toLocaleString()}
        </time>
        {template.lastUsedAt && (
          <>
            {' · last used '}
            <time dateTime={template.lastUsedAt.toISOString()}>
              {template.lastUsedAt.toLocaleDateString()}
            </time>
          </>
        )}
      </p>
    </article>
  );
}

function TemplateForm({
  section,
  template,
  cancelHref,
}: {
  section: SectionConfig;
  template: CommunicationTemplate | null;
  cancelHref: string;
}) {
  const isNew = template === null;
  const variablesText = template
    ? (template.variables ?? [])
        .map((v) => formatVariableLine(v))
        .join('\n')
    : '';
  return (
    <form
      action={saveTemplateAction}
      className="rounded-[var(--radius-lg)] border-2 border-[color:var(--color-foreground)]/20 p-4"
    >
      <input type="hidden" name="kind" value={section.kind} />
      <h3 className="text-sm font-semibold">
        {isNew ? `New ${section.heading.toLowerCase().replace(/s$/, '')}` : `Edit ${template.name}`}
      </h3>

      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field label="Slug (lowercase, _ or -)" hint="Reference name in chat. Cannot change after creation.">
          <input
            type="text"
            name="name"
            required
            maxLength={80}
            pattern="[a-z0-9_-]+"
            defaultValue={template?.name ?? ''}
            readOnly={!isNew}
            placeholder="caribbean_refined_first_touch"
            className="block w-full rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-3 py-2 font-mono text-sm read-only:opacity-60"
          />
        </Field>
        <Field label="Display name" hint="Human-readable. Shown in lists.">
          <input
            type="text"
            name="displayName"
            required
            maxLength={200}
            defaultValue={template?.displayName ?? ''}
            placeholder="Caribbean refined first-touch"
            className="block w-full rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-3 py-2 text-sm"
          />
        </Field>

        {section.hasContentSid && (
          <Field
            label="Twilio Content SID"
            hint="HX + 32 hex chars. Get this from Twilio Console after Meta approves the template."
          >
            <input
              type="text"
              name="contentSid"
              maxLength={120}
              pattern="HX[a-fA-F0-9]{32}"
              defaultValue={template?.contentSid ?? ''}
              placeholder="HX23BFCFA9DB76F5B5A55BEEE9E84F1627"
              className="block w-full rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-3 py-2 font-mono text-xs"
            />
          </Field>
        )}

        {section.hasSubject && (
          <Field label="Subject line" hint="Supports {{variable}} substitution.">
            <input
              type="text"
              name="subject"
              maxLength={500}
              defaultValue={template?.subject ?? ''}
              placeholder="{{recipient_company}} — Q3 supply availability"
              className="block w-full rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-3 py-2 text-sm"
            />
          </Field>
        )}
      </div>

      <Field
        label="Description"
        hint="Operator-only — explains when to use this template."
      >
        <input
          type="text"
          name="description"
          maxLength={2000}
          defaultValue={template?.description ?? ''}
          placeholder="First-touch outreach to Caribbean / LatAm refined product buyers."
          className="block w-full rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-3 py-2 text-sm"
        />
      </Field>

      <Field label="Body" hint="{{variable}} placeholders get filled at send time.">
        <textarea
          name="body"
          required
          maxLength={50_000}
          rows={12}
          defaultValue={template?.body ?? ''}
          placeholder="Hi {{recipient_name}},&#10;&#10;Cole Kutschinski with Vector Trade Capital…"
          className="block w-full rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-3 py-2 font-mono text-xs"
        />
      </Field>

      <Field
        label="Variables"
        hint="One per line: name | description | required(true) | default. Only `name` is required; the others are optional."
      >
        <textarea
          name="variablesText"
          maxLength={20_000}
          rows={5}
          defaultValue={variablesText}
          placeholder={
            'recipient_name | Recipient first name | true\nrecipient_company | Counterparty legal name | true\ndischarge_port | Port of discharge | | Varreux'
          }
          className="block w-full rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-3 py-2 font-mono text-[11px]"
        />
      </Field>

      <div className="mt-4 flex items-center gap-3">
        <button
          type="submit"
          className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-4 py-2 text-sm font-medium text-[color:var(--color-background)]"
        >
          {isNew ? 'Save template' : 'Save changes'}
        </button>
        <a
          href={cancelHref}
          className="text-xs text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"
        >
          Cancel
        </a>
      </div>
    </form>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="mt-3 block">
      <div className="mb-1 text-xs font-medium text-[color:var(--color-muted-foreground)]">
        {label}
      </div>
      {children}
      {hint && (
        <p className="mt-1 text-[10px] text-[color:var(--color-muted-foreground)]">
          {hint}
        </p>
      )}
    </label>
  );
}

function formatVariableLine(v: CommunicationTemplateVariable): string {
  const parts = [v.name];
  parts.push(v.description ?? '');
  parts.push(v.required ? 'true' : '');
  parts.push(v.defaultValue ?? '');
  // Trim trailing empties so simple lines stay clean (`name` alone).
  while (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
  return parts.join(' | ');
}
