import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireCompany } from '@procur/auth';
import { getPastPerformanceById } from '../../../lib/past-performance-queries';
import { formatDate, formatMoney } from '../../../lib/format';
import {
  deletePastPerformanceAction,
  updatePastPerformanceAction,
} from '../actions';

export const dynamic = 'force-dynamic';

export default async function PastPerformanceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { company } = await requireCompany();
  const entry = await getPastPerformanceById(company.id, id);
  if (!entry) notFound();

  const value = formatMoney(entry.totalValue, entry.currency);
  const accomplishments = entry.keyAccomplishments ?? [];

  return (
    <div className="mx-auto max-w-4xl px-8 py-10">
      <nav className="mb-6 text-sm text-[color:var(--color-muted-foreground)]">
        <Link href="/past-performance" className="hover:underline">
          Past performance
        </Link>
        <span> / </span>
        <span className="text-[color:var(--color-foreground)]">{entry.projectName}</span>
      </nav>

      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">{entry.projectName}</h1>
        <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">
          {entry.customerName}
          {entry.customerType && <> · {entry.customerType}</>}
        </p>
      </header>

      <section className="mb-8 grid gap-4 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-6 md:grid-cols-4">
        <Fact label="Value" value={value ?? '—'} />
        <Fact
          label="Period"
          value={
            entry.periodStart && entry.periodEnd
              ? `${formatDate(new Date(entry.periodStart))} → ${formatDate(new Date(entry.periodEnd))}`
              : '—'
          }
        />
        <Fact label="Categories" value={(entry.categories ?? []).join(', ') || '—'} />
        <Fact label="NAICS" value={(entry.naicsCodes ?? []).join(', ') || '—'} />
      </section>

      {accomplishments.length > 0 && (
        <section className="mb-8 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-6">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Key accomplishments
          </h2>
          <ul className="list-disc pl-5 text-sm">
            {accomplishments.map((a, i) => (
              <li key={i} className="mb-1">
                {a}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mb-10">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
          Edit entry
        </h2>
        <form
          action={updatePastPerformanceAction}
          className="grid gap-4 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-5 md:grid-cols-2"
        >
          <input type="hidden" name="id" value={entry.id} />

          <Field label="Project name" name="projectName" required defaultValue={entry.projectName} full />
          <Field label="Customer" name="customerName" required defaultValue={entry.customerName} />
          <Field label="Customer type" name="customerType" defaultValue={entry.customerType ?? ''} />

          <Field label="Period start" name="periodStart" type="date" defaultValue={entry.periodStart ?? ''} />
          <Field label="Period end" name="periodEnd" type="date" defaultValue={entry.periodEnd ?? ''} />
          <Field label="Total value" name="totalValue" type="number" step="0.01" defaultValue={entry.totalValue ?? ''} />
          <Field label="Currency" name="currency" defaultValue={entry.currency ?? 'USD'} maxLength={3} />

          <Textarea
            label="Scope description"
            name="scopeDescription"
            rows={3}
            required
            defaultValue={entry.scopeDescription}
            full
          />
          <Textarea
            label="Key accomplishments (one per line)"
            name="keyAccomplishments"
            rows={3}
            defaultValue={accomplishments.join('\n')}
            full
          />
          <Textarea label="Challenges" name="challenges" rows={2} defaultValue={entry.challenges ?? ''} full />
          <Textarea label="Outcomes" name="outcomes" rows={2} defaultValue={entry.outcomes ?? ''} full />

          <div className="md:col-span-2 mt-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Reference
          </div>
          <Field label="Contact name" name="referenceName" defaultValue={entry.referenceName ?? ''} />
          <Field label="Contact title" name="referenceTitle" defaultValue={entry.referenceTitle ?? ''} />
          <Field label="Contact email" name="referenceEmail" type="email" defaultValue={entry.referenceEmail ?? ''} />
          <Field label="Contact phone" name="referencePhone" defaultValue={entry.referencePhone ?? ''} />

          <div className="md:col-span-2 mt-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Classification
          </div>
          <Field
            label="NAICS codes"
            name="naicsCodes"
            placeholder="comma-separated"
            defaultValue={(entry.naicsCodes ?? []).join(', ')}
            full
          />
          <Field
            label="Categories"
            name="categories"
            placeholder="comma-separated"
            defaultValue={(entry.categories ?? []).join(', ')}
            full
          />
          <Field
            label="Keywords"
            name="keywords"
            placeholder="comma-separated"
            defaultValue={(entry.keywords ?? []).join(', ')}
            full
          />

          <div className="md:col-span-2">
            <button
              type="submit"
              className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-4 py-2 text-sm font-medium text-[color:var(--color-background)]"
            >
              Save
            </button>
          </div>
        </form>
      </section>

      <section>
        <form action={deletePastPerformanceAction}>
          <input type="hidden" name="id" value={entry.id} />
          <button
            type="submit"
            className="text-xs text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-brand)]"
          >
            Delete entry
          </button>
        </form>
      </section>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
        {label}
      </p>
      <p className="mt-1 text-base font-semibold">{value}</p>
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
  required,
  full,
  defaultValue,
}: {
  label: string;
  name: string;
  rows?: number;
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
    </label>
  );
}
