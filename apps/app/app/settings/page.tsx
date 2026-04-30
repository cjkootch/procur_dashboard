import { requireCompany } from '@procur/auth';
import { clearSampleDataAction } from '../onboarding/sample-data-action';
import { hasSampleData } from '../../lib/sample-data';
import { updateCompanyProfileAction } from './actions';
import { AutofillCompanyProfileForm } from './AutofillCompanyProfileForm';

export const dynamic = 'force-dynamic';

export default async function CompanyProfilePage() {
  const { company } = await requireCompany();
  const showSampleClear = await hasSampleData(company.id);

  return (
    <div className="mx-auto max-w-3xl px-8 py-10">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Company profile</h1>
        <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">
          Procur uses these values when drafting proposals and classifying opportunities.
          Accurate capabilities and industry data directly improve AI output quality.
        </p>
      </header>

      <section className="mb-6 flex flex-wrap items-center gap-3 rounded-[var(--radius-lg)] border border-dashed border-[color:var(--color-border)] p-4">
        <div className="flex-1 min-w-[260px]">
          <p className="text-sm font-medium">Autofill from website</p>
          <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">
            Fetch your website and let Sonnet suggest industry, capabilities, and founding
            year. Existing values are preserved — new capabilities are appended.
          </p>
        </div>
        <AutofillCompanyProfileForm defaultUrl={company.websiteUrl ?? ''} />
      </section>

      <form
        action={updateCompanyProfileAction}
        className="grid gap-4 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-5 md:grid-cols-2"
      >
        <Field label="Legal name" name="name" required defaultValue={company.name} full />
        <Field label="Website" name="websiteUrl" type="url" defaultValue={company.websiteUrl ?? ''} />
        <Field label="Country" name="country" defaultValue={company.country ?? ''} />
        <Field label="Industry" name="industry" defaultValue={company.industry ?? ''} />
        <Field
          label="Year founded"
          name="yearFounded"
          type="number"
          defaultValue={company.yearFounded?.toString() ?? ''}
        />
        <Field
          label="Employee count"
          name="employeeCount"
          type="number"
          defaultValue={company.employeeCount?.toString() ?? ''}
        />
        <Field
          label="Annual revenue (range)"
          name="annualRevenue"
          placeholder="e.g. 1M - 5M USD"
          defaultValue={company.annualRevenue ?? ''}
        />

        <div className="md:col-span-2 mt-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
          Capabilities &amp; targeting
        </div>

        <Textarea
          label="Capabilities (one per line or comma-separated)"
          name="capabilities"
          rows={4}
          defaultValue={(company.capabilities ?? []).join('\n')}
          helper="Specific services you deliver — feeds the proposal AI to anchor claims in real offerings."
          full
        />
        <Field
          label="Preferred jurisdictions"
          name="preferredJurisdictions"
          placeholder="comma-separated, e.g. trinidad-and-tobago, jamaica, guyana"
          defaultValue={(company.preferredJurisdictions ?? []).join(', ')}
          full
        />
        <Field
          label="Preferred categories"
          name="preferredCategories"
          placeholder="comma-separated, e.g. IT services, consulting, construction"
          defaultValue={(company.preferredCategories ?? []).join(', ')}
          full
        />
        <Field
          label="Target contract size min (USD)"
          name="targetContractSizeMin"
          type="number"
          defaultValue={company.targetContractSizeMin?.toString() ?? ''}
        />
        <Field
          label="Target contract size max (USD)"
          name="targetContractSizeMax"
          type="number"
          defaultValue={company.targetContractSizeMax?.toString() ?? ''}
        />

        <div className="md:col-span-2 mt-4 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
          Trading economics (compose_deal_economics defaults)
        </div>
        <Select
          label="Default sourcing region"
          name="defaultSourcingRegion"
          defaultValue={company.defaultSourcingRegion ?? ''}
          helper="Picks the productCost cost-model fallback when you don't pass an explicit cost on a deal: usgc → NYH spot, anything else → Brent + crack. Leave blank to require setting it per deal."
          options={[
            { value: '', label: '— Require per-deal —' },
            { value: 'med', label: 'Mediterranean' },
            { value: 'nwe', label: 'NW Europe / ARA' },
            { value: 'usgc', label: 'US Gulf Coast' },
            { value: 'singapore', label: 'Singapore / Far East' },
            { value: 'mideast', label: 'Middle East (Fujairah, etc.)' },
            { value: 'india', label: 'India (Sikka, Vadinar)' },
            { value: 'west-africa', label: 'West Africa (intra)' },
            { value: 'east-africa', label: 'East Africa (intra)' },
            { value: 'black-sea', label: 'Black Sea' },
          ]}
          full
        />
        <Field
          label="Target gross margin (%)"
          name="targetGrossMarginPct"
          type="number"
          step="0.1"
          placeholder="e.g. 5"
          defaultValue={
            company.targetGrossMarginPct != null
              ? (Number(company.targetGrossMarginPct) * 100).toString()
              : ''
          }
          helper="Min gross margin floor. Below this the scorecard flips to do_not_proceed. Default 4%."
        />
        <Field
          label="Target net margin ($/USG)"
          name="targetNetMarginPerUsg"
          type="number"
          step="0.001"
          placeholder="e.g. 0.025"
          defaultValue={company.targetNetMarginPerUsg?.toString() ?? ''}
          helper="Min net margin per US gallon (after freight, finance, overhead). Default $0.020."
        />
        <Field
          label="Monthly fixed overhead (USD)"
          name="monthlyFixedOverheadUsdDefault"
          type="number"
          placeholder="e.g. 200000"
          defaultValue={company.monthlyFixedOverheadUsdDefault?.toString() ?? ''}
          helper="Default desk overhead allocated to deal P&L. Leave blank for $0."
          full
        />

        <div className="md:col-span-2">
          <button
            type="submit"
            className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-4 py-2 text-sm font-medium text-[color:var(--color-background)]"
          >
            Save profile
          </button>
        </div>
      </form>

      <section className="mt-10 rounded-[var(--radius-lg)] border border-dashed border-[color:var(--color-border)] p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
          Plan
        </h2>
        <p className="mt-2 text-sm">
          Current plan: <span className="font-medium capitalize">{company.planTier}</span>
        </p>
        <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">
          Manage billing, invoices, and plan changes in{' '}
          <a href="/billing" className="underline">
            Billing
          </a>
          .
        </p>
      </section>

      {showSampleClear && (
        <section className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-lg)] border border-dashed border-[color:var(--color-border)] p-5">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
              Sample data
            </h2>
            <p className="mt-2 text-sm">
              Your workspace contains the seeded demo content (rows tagged{' '}
              <span className="font-mono">[Sample]</span>).
            </p>
            <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">
              Clearing removes the two sample pursuits, the sample contract, the
              sample library doc, and the sample past-performance entry — along
              with anything you built on top of them. Real data is untouched.
            </p>
          </div>
          <form action={clearSampleDataAction}>
            <button
              type="submit"
              className="rounded-[var(--radius-md)] border border-red-300 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-800 hover:bg-red-100"
            >
              Clear sample data
            </button>
          </form>
        </section>
      )}
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
  helper,
}: {
  label: string;
  name: string;
  type?: string;
  placeholder?: string;
  defaultValue?: string;
  required?: boolean;
  full?: boolean;
  step?: string;
  helper?: string;
}) {
  return (
    <label className={full ? 'md:col-span-2' : undefined}>
      <span className="text-xs text-[color:var(--color-muted-foreground)]">{label}</span>
      <input
        name={name}
        type={type}
        step={step}
        required={required}
        placeholder={placeholder}
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

function Select({
  label,
  name,
  defaultValue,
  options,
  helper,
  full,
}: {
  label: string;
  name: string;
  defaultValue?: string;
  options: Array<{ value: string; label: string }>;
  helper?: string;
  full?: boolean;
}) {
  return (
    <label className={full ? 'md:col-span-2' : undefined}>
      <span className="text-xs text-[color:var(--color-muted-foreground)]">{label}</span>
      <select
        name={name}
        defaultValue={defaultValue}
        className="mt-1 w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {helper && (
        <span className="mt-1 block text-xs text-[color:var(--color-muted-foreground)]">
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
  defaultValue,
  helper,
  full,
}: {
  label: string;
  name: string;
  rows?: number;
  defaultValue?: string;
  helper?: string;
  full?: boolean;
}) {
  return (
    <label className={full ? 'md:col-span-2' : undefined}>
      <span className="text-xs text-[color:var(--color-muted-foreground)]">{label}</span>
      <textarea
        name={name}
        rows={rows}
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
