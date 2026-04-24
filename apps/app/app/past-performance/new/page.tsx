import Link from 'next/link';
import { createPastPerformanceAction } from '../actions';

export const dynamic = 'force-dynamic';

export default function NewPastPerformancePage() {
  return (
    <div className="mx-auto max-w-3xl px-8 py-10">
      <nav className="mb-6 text-sm text-[color:var(--color-muted-foreground)]">
        <Link href="/past-performance" className="hover:underline">
          Past performance
        </Link>
        <span> / </span>
        <span className="text-[color:var(--color-foreground)]">New</span>
      </nav>
      <h1 className="mb-2 text-2xl font-semibold tracking-tight">New past performance</h1>
      <p className="mb-6 text-sm text-[color:var(--color-muted-foreground)]">
        Add a project reference manually. For completed Procur contracts, use the one-click
        generate button instead.
      </p>

      <form
        action={createPastPerformanceAction}
        className="grid gap-4 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-5 md:grid-cols-2"
      >
        <Field label="Project name" required name="projectName" full />
        <Field label="Customer" required name="customerName" />
        <Field label="Customer type" name="customerType" placeholder="government / commercial" />

        <Field label="Period start" name="periodStart" type="date" />
        <Field label="Period end" name="periodEnd" type="date" />
        <Field label="Total value" name="totalValue" type="number" step="0.01" />
        <Field label="Currency" name="currency" defaultValue="USD" maxLength={3} />

        <Textarea
          label="Scope description"
          required
          name="scopeDescription"
          rows={3}
          full
        />
        <Textarea
          label="Key accomplishments"
          name="keyAccomplishments"
          rows={3}
          helper="One per line. Becomes a bulleted list in the detail view."
          full
        />
        <Textarea label="Challenges" name="challenges" rows={2} full />
        <Textarea label="Outcomes" name="outcomes" rows={2} full />

        <div className="md:col-span-2 mt-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
          Reference
        </div>
        <Field label="Contact name" name="referenceName" />
        <Field label="Contact title" name="referenceTitle" />
        <Field label="Contact email" name="referenceEmail" type="email" />
        <Field label="Contact phone" name="referencePhone" />

        <div className="md:col-span-2 mt-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
          Classification
        </div>
        <Field label="NAICS codes" name="naicsCodes" placeholder="comma-separated" full />
        <Field label="Categories" name="categories" placeholder="comma-separated" full />
        <Field label="Keywords" name="keywords" placeholder="comma-separated" full />

        <div className="md:col-span-2 flex items-center gap-3">
          <button
            type="submit"
            className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-4 py-2 text-sm font-medium text-[color:var(--color-background)]"
          >
            Create entry
          </button>
          <Link
            href="/past-performance"
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
  placeholder,
  defaultValue,
  required,
  full,
  step,
  maxLength,
}: {
  label: string;
  name: string;
  type?: string;
  placeholder?: string;
  defaultValue?: string;
  required?: boolean;
  full?: boolean;
  step?: string;
  maxLength?: number;
}) {
  return (
    <label className={full ? 'md:col-span-2' : undefined}>
      <span className="text-xs text-[color:var(--color-muted-foreground)]">{label}</span>
      <input
        name={name}
        type={type}
        required={required}
        placeholder={placeholder}
        defaultValue={defaultValue}
        step={step}
        maxLength={maxLength}
        className="mt-1 w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
      />
    </label>
  );
}

function Textarea({
  label,
  name,
  rows = 3,
  helper,
  required,
  full,
  defaultValue,
}: {
  label: string;
  name: string;
  rows?: number;
  helper?: string;
  required?: boolean;
  full?: boolean;
  defaultValue?: string;
}) {
  return (
    <label className={full ? 'md:col-span-2' : undefined}>
      <span className="text-xs text-[color:var(--color-muted-foreground)]">{label}</span>
      <textarea
        name={name}
        rows={rows}
        required={required}
        defaultValue={defaultValue}
        className="mt-1 w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
      />
      {helper && (
        <span className="mt-1 block text-xs text-[color:var(--color-muted-foreground)]">
          {helper}
        </span>
      )}
    </label>
  );
}
