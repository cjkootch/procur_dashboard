import Link from 'next/link';
import { requireCompany } from '@procur/auth';
import { createProbeAction } from '../actions';

export const dynamic = 'force-dynamic';

/**
 * Create-probe form. After submit, server action redirects to the
 * detail page where the operator runs plan generation + target
 * discovery. The form is deliberately short — daily/total send caps
 * have conservative defaults; advanced fields (allowed channels,
 * blocked terms) get edit-in-place on the detail page in Phase 1.1.
 */
export default async function NewMarketProbePage() {
  await requireCompany();

  return (
    <div className="mx-auto max-w-2xl px-8 py-10">
      <Link
        href="/market-probes"
        className="text-sm text-[color:var(--color-muted-foreground)] hover:underline"
      >
        ← Market Probes
      </Link>
      <header className="mt-4 mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">New Probe</h1>
        <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">
          Pick a small market and hand the agent a scope. Probes default
          to Tier 0 (research-only — every send operator-approved). You
          can graduate to Tier 1 (autopilot within caps) after you&apos;ve
          reviewed the agent&apos;s first drafts.
        </p>
      </header>

      <form
        action={createProbeAction}
        className="grid gap-4 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-5"
      >
        <Field
          label="Market name"
          name="marketName"
          required
          placeholder="e.g. Barbados food importers"
          helper="Short label that shows in the probe list."
        />
        <Field
          label="Country (ISO-2)"
          name="country"
          placeholder="e.g. BB"
          helper="Hard fence on the recommender — targets outside this country won't surface. Required for target discovery to work."
        />
        <Textarea
          label="Product thesis"
          name="productThesis"
          required
          rows={3}
          placeholder="e.g. Hotels and small distributors that periodically source powdered milk and cooking oil from outside the island."
          helper="One paragraph describing what activity might exist in this market that the desk could plug into."
        />
        <Field
          label="Objective (optional)"
          name="objective"
          placeholder="e.g. identify 3+ named procurement contacts; surface 1+ active buying process"
        />
        <Select
          label="Risk level"
          name="riskLevel"
          defaultValue="low"
          options={[
            { value: 'low', label: 'Low — small private companies, low-stakes' },
            { value: 'medium', label: 'Medium — mid-size, more visibility' },
            { value: 'high', label: 'High — strategic / reputationally important' },
          ]}
        />
        <div className="grid grid-cols-2 gap-4">
          <Field
            label="Daily send cap"
            name="dailySendLimit"
            type="number"
            defaultValue="10"
          />
          <Field
            label="Total send cap"
            name="totalSendLimit"
            type="number"
            defaultValue="50"
          />
        </div>
        <Field
          label="Allowed channels"
          name="allowedChannels"
          defaultValue="email"
          helper="Comma-separated. Email-only is the safest default. Calls/SMS/WhatsApp require explicit opt-in."
        />
        <Field
          label="Blocked terms"
          name="blockedTerms"
          placeholder="e.g. price, quote, $, USG, payment, LOI"
          helper="Comma-separated. Any draft containing one of these gets blocked from auto-send (Tier 1+). Phase 1 stores; Tier 1 enforces."
        />

        <div className="flex items-center gap-3 pt-2">
          <button
            type="submit"
            className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-4 py-2 text-sm font-medium text-[color:var(--color-background)]"
          >
            Create probe
          </button>
          <Link
            href="/market-probes"
            className="text-sm text-[color:var(--color-muted-foreground)] hover:underline"
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}

function Field({
  label,
  name,
  type = 'text',
  required,
  placeholder,
  defaultValue,
  helper,
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  placeholder?: string;
  defaultValue?: string;
  helper?: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium">
        {label}
        {required && <span className="ml-1 text-red-600">*</span>}
      </span>
      <input
        type={type}
        name={name}
        required={required}
        placeholder={placeholder}
        defaultValue={defaultValue}
        className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 focus:border-[color:var(--color-foreground)] focus:outline-none"
      />
      {helper && (
        <span className="text-[11px] text-[color:var(--color-muted-foreground)]">
          {helper}
        </span>
      )}
    </label>
  );
}

function Textarea({
  label,
  name,
  rows = 3,
  required,
  placeholder,
  helper,
}: {
  label: string;
  name: string;
  rows?: number;
  required?: boolean;
  placeholder?: string;
  helper?: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium">
        {label}
        {required && <span className="ml-1 text-red-600">*</span>}
      </span>
      <textarea
        name={name}
        rows={rows}
        required={required}
        placeholder={placeholder}
        className="resize-y rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 focus:border-[color:var(--color-foreground)] focus:outline-none"
      />
      {helper && (
        <span className="text-[11px] text-[color:var(--color-muted-foreground)]">
          {helper}
        </span>
      )}
    </label>
  );
}

function Select({
  label,
  name,
  options,
  defaultValue,
}: {
  label: string;
  name: string;
  options: Array<{ value: string; label: string }>;
  defaultValue?: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium">{label}</span>
      <select
        name={name}
        defaultValue={defaultValue}
        className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 focus:border-[color:var(--color-foreground)] focus:outline-none"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
