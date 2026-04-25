import { redirect } from 'next/navigation';
import { auth } from '@clerk/nextjs/server';
import { CreateOrganization, OrganizationList } from '@clerk/nextjs';

export const dynamic = 'force-dynamic';

/**
 * Onboarding for users who have signed up but don't yet have an active
 * organization in their Clerk session. Clerk's CreateOrganization
 * component handles name + slug; our Clerk webhook
 * (/api/webhooks/clerk) syncs the resulting Clerk org to a `companies`
 * row and the membership to the `users` row out-of-band.
 *
 * Webhook race protection lives in @procur/auth getCurrentCompany():
 * if the cookie has an orgId but our DB row hasn't been synced yet, it
 * hydrates synchronously from Clerk's API. So redirecting to / here
 * (rather than /capture) is safe — the home page will resolve the
 * company on the very first render even when the webhook is still in
 * flight, and the user lands on the SetupChecklist instead of an
 * empty Capture pipeline.
 */
export default async function OnboardingPage() {
  const { userId, orgId } = await auth();
  if (!userId) redirect('/sign-in');
  if (orgId) redirect('/');

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col items-center justify-center px-6 py-10">
      <header className="mb-8 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Create your company</h1>
        <p className="mt-2 text-sm text-[color:var(--color-muted-foreground)]">
          Procur is multi-tenant — every pursuit, task, and proposal belongs to a company.
          Create yours below, or join one you&rsquo;ve been invited to.
        </p>
      </header>

      <div className="w-full">
        <CreateOrganization
          afterCreateOrganizationUrl="/"
          skipInvitationScreen
        />
      </div>

      <section className="mt-10 w-full">
        <p className="mb-3 text-center text-sm text-[color:var(--color-muted-foreground)]">
          Or switch to an organization you already belong to
        </p>
        <OrganizationList
          hidePersonal
          afterSelectOrganizationUrl="/"
          afterCreateOrganizationUrl="/"
        />
      </section>
    </main>
  );
}
