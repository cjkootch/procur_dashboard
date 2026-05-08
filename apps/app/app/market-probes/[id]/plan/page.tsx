import Link from 'next/link';

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function ProbePlanPage({ params }: PageProps) {
  const { id } = await params;
  return (
    <section className="rounded-[var(--radius-lg)] border border-dashed border-[color:var(--color-border)] p-8 text-center">
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
        Plan
      </h2>
      <p className="text-sm text-[color:var(--color-muted-foreground)]">
        Plan, hypotheses, strategy proposals, variants, atlas facts, and
        learning report live on the Overview tab today; splitting into this
        tab in the next pass.
      </p>
      <Link
        href={`/market-probes/${id}/overview`}
        className="mt-3 inline-block text-sm hover:underline"
      >
        See plan in Overview →
      </Link>
    </section>
  );
}
