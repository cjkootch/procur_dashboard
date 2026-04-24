import Link from 'next/link';
import {
  listCategoryOptions,
  listJurisdictionOptions,
} from '../../../lib/alert-queries';
import { createAlertAction } from '../actions';
import { AlertForm } from '../alert-form';

export const dynamic = 'force-dynamic';

export default async function NewAlertPage() {
  const [jurisdictions, categories] = await Promise.all([
    listJurisdictionOptions(),
    listCategoryOptions(),
  ]);

  return (
    <div className="mx-auto max-w-3xl px-8 py-10">
      <nav className="mb-6 text-sm text-[color:var(--color-muted-foreground)]">
        <Link href="/alerts" className="hover:underline">
          Alerts
        </Link>
        <span> / </span>
        <span className="text-[color:var(--color-foreground)]">New</span>
      </nav>
      <h1 className="mb-2 text-2xl font-semibold tracking-tight">New alert</h1>
      <p className="mb-6 text-sm text-[color:var(--color-muted-foreground)]">
        Filter new tenders by jurisdiction, category, keywords, and value range. You&rsquo;ll
        get an email digest at the frequency you pick.
      </p>

      <AlertForm
        action={createAlertAction}
        jurisdictions={jurisdictions}
        categories={categories}
        submitLabel="Create alert"
      />
    </div>
  );
}
