import { redirect } from 'next/navigation';
import { eq, and } from 'drizzle-orm';
import { requireCompany } from '@procur/auth';
import { db, opportunities, pursuits, type NewPursuit } from '@procur/db';

export const dynamic = 'force-dynamic';

/**
 * Entry point from Discover's "Track this opportunity" button.
 * Idempotent: if a pursuit already exists for this opportunity + company,
 * redirect to it. Otherwise create it at stage=identification and redirect
 * to the detail page.
 */
export default async function NewPursuitPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const raw = sp.opportunity;
  const opportunityId = Array.isArray(raw) ? raw[0] : raw;
  if (!opportunityId) {
    redirect('/capture');
  }

  const { user, company } = await requireCompany();

  const op = await db.query.opportunities.findFirst({
    where: eq(opportunities.id, opportunityId),
    columns: { id: true },
  });
  if (!op) redirect('/capture');

  const existing = await db.query.pursuits.findFirst({
    where: and(
      eq(pursuits.companyId, company.id),
      eq(pursuits.opportunityId, opportunityId),
    ),
  });
  if (existing) {
    redirect(`/capture/pursuits/${existing.id}`);
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
