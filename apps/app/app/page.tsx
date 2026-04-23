import { getCurrentCompany, getCurrentUser } from '@procur/auth';
import { UserButton } from '@clerk/nextjs';
import Link from 'next/link';
import { redirect } from 'next/navigation';

const products = [
  {
    slug: 'capture',
    name: 'Capture',
    description: 'Pipeline, pursuits, tasks',
    tier: 'Pro',
    href: '/capture',
    available: false,
  },
  {
    slug: 'proposal',
    name: 'Proposal',
    description: 'AI-drafted proposals and compliance matrix',
    tier: 'Pro',
    href: '/proposal',
    available: false,
  },
  {
    slug: 'pricer',
    name: 'Pricer',
    description: 'Cost estimation and labor category modeling',
    tier: 'Add-on',
    href: '/pricer',
    available: false,
  },
  {
    slug: 'contract',
    name: 'Contract',
    description: 'Post-award contract lifecycle management',
    tier: 'Enterprise',
    href: '/contract',
    available: false,
  },
] as const;

export default async function DashboardPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/sign-in');

  const company = await getCurrentCompany();
  const displayName =
    [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email || 'there';

  return (
    <main className="mx-auto max-w-6xl px-6 py-12">
      <header className="mb-10 flex items-start justify-between">
        <div>
          <p className="text-sm text-[color:var(--color-muted-foreground)]">Welcome back,</p>
          <h1 className="text-3xl font-semibold tracking-tight">{displayName}</h1>
          {company ? (
            <p className="mt-2 text-sm text-[color:var(--color-muted-foreground)]">
              {company.name} · Plan:{' '}
              <span className="font-medium capitalize">{company.planTier}</span>
            </p>
          ) : (
            <p className="mt-2 text-sm text-[color:var(--color-muted-foreground)]">
              <Link className="underline" href="/onboarding">
                Complete onboarding to create your organization
              </Link>
            </p>
          )}
        </div>
        <UserButton afterSignOutUrl="/sign-in" />
      </header>

      <section>
        <h2 className="mb-4 text-lg font-medium">Products</h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {products.map((p) => (
            <article
              key={p.slug}
              className="rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-6"
            >
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-base font-semibold">{p.name}</h3>
                <span className="rounded-[var(--radius-sm)] bg-[color:var(--color-muted)] px-2 py-0.5 text-xs text-[color:var(--color-muted-foreground)]">
                  {p.tier}
                </span>
              </div>
              <p className="text-sm text-[color:var(--color-muted-foreground)]">{p.description}</p>
              <p className="mt-4 text-xs text-[color:var(--color-muted-foreground)]">
                Coming in a future phase
              </p>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
