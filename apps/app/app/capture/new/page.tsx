import { redirect } from 'next/navigation';
import Link from 'next/link';
import { eq, and } from 'drizzle-orm';
import { requireCompany } from '@procur/auth';
import { db, opportunities, pursuits, type NewPursuit } from '@procur/db';
import { Card, Label } from '@procur/ui';
import { getActivePursuitCount } from '../../../lib/capture-queries';
import { FREE_TIER_ACTIVE_PURSUIT_CAP } from '../../../lib/plan-limits';

export const dynamic = 'force-dynamic';

const DISCOVER_URL = process.env.NEXT_PUBLIC_DISCOVER_URL ?? 'https://discover.procur.app';

/**
 * Two-mode entry point:
 *
 *  1. With `?opportunity=<id>` (legacy "Track this opportunity" link from
 *     Discover) — idempotently create a pursuit and redirect to its
 *     detail page. Same behavior as before.
 *
 *  2. Without query params — render a chooser between "From Discover"
 *     (browse public tenders) and "Upload private bid" (bring your own
 *     RFP). Lets users into the upload flow without needing a deep link.
 */
export default async function NewPursuitPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const raw = sp.opportunity;
  const opportunityId = Array.isArray(raw) ? raw[0] : raw;

  if (opportunityId) {
    await trackFromDiscover(opportunityId);
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">Start a new pursuit</h1>
      <p className="mt-2 text-sm text-[color:var(--color-muted-foreground)]">
        Track a public tender from Discover, or upload private bid documents you
        received off-platform.
      </p>

      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        <Link
          href={`${DISCOVER_URL}/opportunities`}
          className="group focus-visible:outline-none"
        >
          <Card
            padding="lg"
            className="h-full transition-colors hover:border-[color:var(--color-foreground)]/40 group-focus-visible:ring-2 group-focus-visible:ring-[color:var(--color-foreground)]/30"
          >
            <Label as="div">From Discover</Label>
            <h2 className="mt-2 text-base font-semibold">Browse public tenders</h2>
            <p className="mt-2 text-sm text-[color:var(--color-muted-foreground)]">
              Search 10,000+ government opportunities scraped from public portals
              across 16 jurisdictions.
            </p>
            <span className="mt-4 inline-block text-sm font-medium">
              Open Discover →
            </span>
          </Card>
        </Link>

        <Link href="/capture/new/upload" className="group focus-visible:outline-none">
          <Card
            padding="lg"
            className="h-full transition-colors hover:border-[color:var(--color-foreground)]/40 group-focus-visible:ring-2 group-focus-visible:ring-[color:var(--color-foreground)]/30"
          >
            <Label as="div">Upload private bid</Label>
            <h2 className="mt-2 text-base font-semibold">Bring your own RFP</h2>
            <p className="mt-2 text-sm text-[color:var(--color-muted-foreground)]">
              Drop a tender you received via email or a private portal. We&rsquo;ll
              run it through the same AI pipeline (summary, requirements,
              category) and create a pursuit you can manage end-to-end.
            </p>
            <span className="mt-4 inline-block text-sm font-medium">
              Upload documents →
            </span>
          </Card>
        </Link>
      </div>
    </div>
  );
}

async function trackFromDiscover(opportunityId: string): Promise<never> {
  const { user, company } = await requireCompany();

  const op = await db.query.opportunities.findFirst({
    where: eq(opportunities.id, opportunityId),
    columns: { id: true, companyId: true },
  });
  // Privacy: never let a Discover-style track link point at someone
  // else's private opportunity. companyId IS NULL → public; non-null
  // means private and must match the current tenant.
  if (!op || (op.companyId !== null && op.companyId !== company.id)) {
    redirect('/capture');
  }

  const existing = await db.query.pursuits.findFirst({
    where: and(
      eq(pursuits.companyId, company.id),
      eq(pursuits.opportunityId, opportunityId),
    ),
  });
  if (existing) {
    redirect(`/capture/pursuits/${existing.id}`);
  }

  if (company.planTier === 'free') {
    const active = await getActivePursuitCount(company.id);
    if (active >= FREE_TIER_ACTIVE_PURSUIT_CAP) {
      redirect(`/billing?reason=pursuit-cap&opportunity=${opportunityId}`);
    }
  }

  const row: NewPursuit = {
    companyId: company.id,
    opportunityId,
    stage: 'identification',
    assignedUserId: user.id,
  };
  const [created] = await db.insert(pursuits).values(row).returning({ id: pursuits.id });
  if (!created) redirect('/capture');
  redirect(`/capture/pursuits/${created.id}`);
}
