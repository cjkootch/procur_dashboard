import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireCompany } from '@procur/auth';
import { getActivePursuitCount } from '../../../../lib/capture-queries';
import { FREE_TIER_ACTIVE_PURSUIT_CAP } from '../../../../lib/plan-limits';
import { UploadForm } from './upload-form';

export const dynamic = 'force-dynamic';

export default async function UploadPursuitPage() {
  const { company } = await requireCompany();

  // Free-tier check: same logic as the Discover-track path. We do this
  // BEFORE the user uploads a 50 MB PDF only to discover they're capped.
  if (company.planTier === 'free') {
    const active = await getActivePursuitCount(company.id);
    if (active >= FREE_TIER_ACTIVE_PURSUIT_CAP) {
      redirect('/billing?reason=pursuit-cap&source=upload');
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <nav className="mb-3 text-xs text-[color:var(--color-muted-foreground)]">
        <Link href="/capture" className="hover:underline">
          Capture
        </Link>
        <span> / </span>
        <Link href="/capture/new" className="hover:underline">
          New pursuit
        </Link>
        <span> / </span>
        <span className="text-[color:var(--color-foreground)]">Upload private bid</span>
      </nav>

      <h1 className="text-2xl font-semibold tracking-tight">Upload private bid</h1>
      <p className="mt-2 text-sm text-[color:var(--color-muted-foreground)]">
        Drop the solicitation, SOW, or any documents the customer sent. We&rsquo;ll
        extract requirements, generate a summary, and classify the opportunity
        once you create the pursuit.
      </p>

      <div className="mt-8">
        <UploadForm />
      </div>
    </div>
  );
}
