import { clerkClient } from '@clerk/nextjs/server';
import { requireCompany } from '@procur/auth';
import {
  inviteTeamMemberAction,
  removeMemberAction,
  revokeInvitationAction,
} from './actions';

export const dynamic = 'force-dynamic';

function formatRole(clerkRole: string | null | undefined): string {
  if (!clerkRole) return 'Member';
  if (clerkRole === 'org:owner') return 'Owner';
  if (clerkRole === 'org:admin' || clerkRole.endsWith(':admin')) return 'Admin';
  return 'Member';
}

export default async function TeamPage() {
  const { user, company } = await requireCompany();
  const client = await clerkClient();

  const [memberships, invitations] = await Promise.all([
    client.organizations.getOrganizationMembershipList({
      organizationId: company.clerkOrgId,
    }),
    client.organizations.getOrganizationInvitationList({
      organizationId: company.clerkOrgId,
      status: ['pending'],
    }),
  ]);

  const canManage = user.role === 'owner' || user.role === 'admin';

  return (
    <div className="mx-auto max-w-3xl px-8 py-10">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Team</h1>
        <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">
          Invite teammates to access your Procur workspace. Invitations are sent
          by email; accepting one creates the account automatically.
        </p>
      </header>

      {canManage ? (
        <form
          action={inviteTeamMemberAction}
          className="mb-8 grid gap-3 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-5 md:grid-cols-[1fr_auto_auto]"
        >
          <input
            name="email"
            type="email"
            required
            placeholder="teammate@example.com"
            className="rounded-md border border-[color:var(--color-border)] bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[color:var(--color-ring)]"
          />
          <select
            name="role"
            defaultValue="org:member"
            className="rounded-md border border-[color:var(--color-border)] bg-transparent px-3 py-2 text-sm"
          >
            <option value="org:member">Member</option>
            <option value="org:admin">Admin</option>
          </select>
          <button
            type="submit"
            className="rounded-md bg-[color:var(--color-foreground)] px-4 py-2 text-sm font-medium text-[color:var(--color-background)] hover:opacity-90"
          >
            Send invite
          </button>
        </form>
      ) : (
        <div className="mb-8 rounded-[var(--radius-lg)] border border-dashed border-[color:var(--color-border)] p-4 text-sm text-[color:var(--color-muted-foreground)]">
          Only owners and admins can invite or remove teammates. Ask one of your
          admins if you need to update the team.
        </div>
      )}

      <section className="mb-8">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
          Members ({memberships.data.length})
        </h2>
        <ul className="divide-y divide-[color:var(--color-border)] rounded-[var(--radius-lg)] border border-[color:var(--color-border)]">
          {memberships.data.map((m) => {
            const memberClerkId = m.publicUserData?.userId ?? '';
            const isSelf = memberClerkId === user.clerkId;
            const isOwner = m.role === 'org:owner';
            const name =
              [m.publicUserData?.firstName, m.publicUserData?.lastName]
                .filter(Boolean)
                .join(' ') ||
              m.publicUserData?.identifier ||
              '—';
            return (
              <li key={m.id} className="flex items-center gap-4 px-4 py-3">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium">
                    {name}
                    {isSelf && (
                      <span className="ml-2 text-xs text-[color:var(--color-muted-foreground)]">
                        (you)
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-[color:var(--color-muted-foreground)]">
                    {m.publicUserData?.identifier}
                  </div>
                </div>
                <div className="text-xs text-[color:var(--color-muted-foreground)]">
                  {formatRole(m.role)}
                </div>
                {canManage && !isSelf && !isOwner && (
                  <form action={removeMemberAction}>
                    <input type="hidden" name="userId" value={memberClerkId} />
                    <button
                      type="submit"
                      className="text-xs text-[color:var(--color-destructive)] underline"
                    >
                      Remove
                    </button>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      {invitations.data.length > 0 && (
        <section>
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Pending invitations ({invitations.data.length})
          </h2>
          <ul className="divide-y divide-[color:var(--color-border)] rounded-[var(--radius-lg)] border border-[color:var(--color-border)]">
            {invitations.data.map((inv) => (
              <li key={inv.id} className="flex items-center gap-4 px-4 py-3">
                <div className="flex-1 min-w-0">
                  <div className="text-sm">{inv.emailAddress}</div>
                  <div className="text-xs text-[color:var(--color-muted-foreground)]">
                    Invited as {formatRole(inv.role)}
                  </div>
                </div>
                {canManage && (
                  <form action={revokeInvitationAction}>
                    <input type="hidden" name="invitationId" value={inv.id} />
                    <button
                      type="submit"
                      className="text-xs text-[color:var(--color-destructive)] underline"
                    >
                      Revoke
                    </button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
