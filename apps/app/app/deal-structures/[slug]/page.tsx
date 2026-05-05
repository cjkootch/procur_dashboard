import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireCompany } from '@procur/auth';
import {
  lookupDealStructureTemplates,
  lookupCommissionStructures,
} from '@procur/catalog';
import type { CommissionStructure } from '@procur/db';

export const dynamic = 'force-dynamic';

const CATEGORY_LABEL: Record<string, string> = {
  'refined-product': 'Refined product',
  'specialty-crude': 'Specialty crude',
  'crude-conventional': 'Crude (conventional)',
  'food-commodity': 'Food commodity',
  vehicle: 'Vehicle',
  lng: 'LNG',
  lpg: 'LPG',
};

const ENTITY_LABEL: Record<string, string> = {
  'vtc-llc': 'VTC LLC',
  'vector-antilles': 'Vector Antilles',
  'vector-auto-exports': 'Vector Auto Exports',
  'vector-food-fund': 'Vector Food Fund',
  'stabroek-advisory': 'Stabroek Advisory',
};

export default async function DealStructureDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  await requireCompany();

  const all = await lookupDealStructureTemplates({ status: 'all', limit: 500 });
  const template = all.find((t) => t.slug === slug);
  if (!template) notFound();

  const commissions = await lookupCommissionStructures({
    status: 'all',
    dealCategory: template.category,
    dealTemplateSlug: template.slug,
    vtcEntity: template.vtcEntity,
    limit: 50,
  });

  return (
    <div className="mx-auto max-w-4xl px-8 py-10">
      <div className="mb-4 text-xs">
        <Link
          href="/deal-structures"
          className="text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"
        >
          ← Deal structures
        </Link>
      </div>

      <header className="mb-6 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{template.name}</h1>
          <p className="mt-1 font-mono text-xs text-[color:var(--color-muted-foreground)]">
            {template.slug}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {template.validatedByCounsel ? (
            <span
              className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-700 dark:text-emerald-300"
              title={
                template.validatedAt
                  ? `Validated ${formatDate(template.validatedAt)}${
                      template.validatedByFirm ? ` by ${template.validatedByFirm}` : ''
                    }`
                  : 'Validated by counsel'
              }
            >
              Counsel-validated
            </span>
          ) : (
            <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-300">
              Not counsel-reviewed
            </span>
          )}
          {template.status !== 'active' && (
            <span className="rounded-full border border-[color:var(--color-border)] px-2 py-0.5 text-xs uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
              {template.status}
            </span>
          )}
        </div>
      </header>

      <Section title="Identity">
        <Pair label="Category" value={CATEGORY_LABEL[template.category] ?? template.category} />
        <Pair label="Entity" value={ENTITY_LABEL[template.vtcEntity] ?? template.vtcEntity} />
        <Pair
          label="Applicable regions"
          value={template.applicableRegions.length ? template.applicableRegions.join(', ') : '—'}
        />
      </Section>

      <Section title="Commercial mechanics">
        <Pair label="Incoterm" value={template.incoterm.toUpperCase()} />
        <Pair label="Risk transfer" value={template.riskTransferPoint} />
        <Pair label="Payment instrument" value={template.paymentInstrument} />
        <Pair label="Payment currency" value={template.paymentCurrency} />
        {template.lcConfirmationRequired && (
          <Pair label="LC confirmation" value="Required" />
        )}
      </Section>

      {(template.cargoInsurance ||
        template.insuranceCoveragePct ||
        template.inspectionRequirement ||
        template.qualityStandard) && (
        <Section title="Insurance & inspection">
          {template.cargoInsurance && (
            <Pair label="Cargo insurance" value={template.cargoInsurance} />
          )}
          {template.insuranceCoveragePct && (
            <Pair label="Coverage" value={`${template.insuranceCoveragePct}% of CIF`} />
          )}
          {template.inspectionRequirement && (
            <Pair label="Inspection" value={template.inspectionRequirement} />
          )}
          {template.qualityStandard && (
            <Pair label="Quality standard" value={template.qualityStandard} />
          )}
        </Section>
      )}

      {template.standardDocuments.length > 0 && (
        <Section title="Standard documents">
          <div className="col-span-full">
            <ol className="ml-5 list-decimal space-y-1 text-sm">
              {template.standardDocuments.map((doc) => (
                <li key={doc} className="font-mono text-xs text-[color:var(--color-foreground)]">
                  {doc}
                </li>
              ))}
            </ol>
          </div>
        </Section>
      )}

      {(template.typicalCycleTimeDaysMin ||
        template.typicalCycleTimeDaysMax ||
        template.laycanWindow) && (
        <Section title="Timing">
          {(template.typicalCycleTimeDaysMin || template.typicalCycleTimeDaysMax) && (
            <Pair
              label="Cycle time"
              value={formatDayRange(
                template.typicalCycleTimeDaysMin,
                template.typicalCycleTimeDaysMax,
              )}
            />
          )}
          {template.laycanWindow && <Pair label="Laycan" value={template.laycanWindow} />}
        </Section>
      )}

      {(template.marginStructure ||
        template.typicalMarginMin ||
        template.typicalMarginMax) && (
        <Section title="Margin">
          {template.marginStructure && (
            <Pair label="Structure" value={template.marginStructure} />
          )}
          {(template.typicalMarginMin || template.typicalMarginMax) && (
            <Pair
              label="Range"
              value={
                formatMargin(
                  template.typicalMarginMin,
                  template.typicalMarginMax,
                  template.marginUnit,
                ) ?? '—'
              }
            />
          )}
        </Section>
      )}

      <Section title="Risk perimeter">
        <Pair
          label="OFAC screening"
          value={template.ofacScreeningRequired ? 'Required' : 'Not required'}
        />
        {template.excludedJurisdictions.length > 0 && (
          <Pair
            label="Excluded jurisdictions"
            value={template.excludedJurisdictions.join(', ')}
          />
        )}
        {template.excludedCounterpartyTypes.length > 0 && (
          <Pair
            label="Excluded counterparty types"
            value={template.excludedCounterpartyTypes.join(', ')}
          />
        )}
        {template.generalLicenseEligible && template.generalLicenseEligible.length > 0 && (
          <Pair label="GL-eligible" value={template.generalLicenseEligible.join(', ')} />
        )}
      </Section>

      {!template.validatedByCounsel ? null : (
        <Section title="Counsel validation">
          {template.validatedAt && (
            <Pair label="Validated" value={formatDate(template.validatedAt)} />
          )}
          {template.validatedByFirm && (
            <Pair label="Firm" value={template.validatedByFirm} />
          )}
          {template.validationNotes && (
            <Pair label="Notes" value={template.validationNotes} />
          )}
        </Section>
      )}

      {template.notes && (
        <section className="mb-8">
          <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Notes
          </h2>
          <p className="whitespace-pre-wrap text-sm">{template.notes}</p>
        </section>
      )}

      <section className="mb-8">
        <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
          Commissions that apply
        </h2>
        {commissions.length === 0 ? (
          <p className="text-sm text-[color:var(--color-muted-foreground)]">
            No commission structures match this template (category {template.category}, entity{' '}
            {template.vtcEntity}).
          </p>
        ) : (
          <div className="space-y-2">
            {commissions.map((c) => (
              <CommissionCard key={c.slug} commission={c} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
        {title}
      </h2>
      <div className="grid grid-cols-1 gap-x-6 gap-y-2 md:grid-cols-2">{children}</div>
    </section>
  );
}

function Pair({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="text-[10px] uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
        {label}
      </span>
      <p className="text-sm">{value}</p>
    </div>
  );
}

function CommissionCard({ commission: c }: { commission: CommissionStructure }) {
  return (
    <div className="rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium">{c.name}</p>
          <p className="font-mono text-xs text-[color:var(--color-muted-foreground)]">
            {c.slug}
          </p>
        </div>
        <div className="flex gap-1">
          {c.exclusivePerDeal && (
            <span className="rounded-full border border-[color:var(--color-border)] px-2 py-0.5 text-xs">
              Exclusive
            </span>
          )}
        </div>
      </div>
      <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">
        {c.basisType} · {c.partyRelationship} · trigger: {c.triggerEvent} · timing:{' '}
        {c.paymentTiming}
      </p>
      <pre className="mt-2 overflow-x-auto rounded-[var(--radius-md)] bg-[color:var(--color-muted)]/30 p-2 text-[11px]">
        {JSON.stringify(c.feeStructure ?? {}, null, 2)}
      </pre>
    </div>
  );
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function formatDayRange(min: number | null, max: number | null): string {
  if (min != null && max != null) return `${min}–${max} days`;
  if (min != null) return `${min}+ days`;
  if (max != null) return `up to ${max} days`;
  return '—';
}

function formatMargin(
  min: string | null,
  max: string | null,
  unit: string | null,
): string | null {
  if (min == null && max == null) return null;
  const u = unit ?? '';
  const fmt = (v: string) => {
    if (u === 'pct') {
      const n = Number(v);
      return Number.isFinite(n) ? `${(n * 100).toFixed(2).replace(/\.?0+$/, '')}%` : v;
    }
    return v;
  };
  if (min != null && max != null) {
    if (u === 'pct') return `${fmt(min)}–${fmt(max)}`;
    return `${fmt(min)}–${fmt(max)} ${u.replace(/^usd-per-/, '$/')}`.trim();
  }
  const v = (min ?? max) as string;
  return u === 'pct' ? fmt(v) : `${fmt(v)} ${u.replace(/^usd-per-/, '$/')}`.trim();
}
