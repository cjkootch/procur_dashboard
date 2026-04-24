import type { PursuitTeamMember, TeamingStatus, TeamRole } from '@procur/db';
import { TEAM_ROLES, TEAMING_STATUSES } from '@procur/db';
import {
  TEAM_ROLE_LABEL,
  TEAMING_STATUS_LABEL,
  type TeamSummary,
} from '../../../../lib/team-queries';
import { chipClass, type ChipTone } from '../../../../lib/chips';
import {
  addTeamMemberAction,
  removeTeamMemberAction,
  updateTeamMemberAction,
} from '../../actions';

const ROLE_TONE: Record<TeamRole, ChipTone> = {
  prime: 'success',
  subcontractor: 'info',
  joint_venture: 'accent',
  mentor: 'warning',
  consultant: 'neutral',
};

const STATUS_TONE: Record<TeamingStatus, ChipTone> = {
  engaging: 'neutral',
  nda_signed: 'info',
  teaming_agreement: 'accent',
  executed: 'success',
  declined: 'danger',
};

/**
 * Teaming module — list of partners on this pursuit. Each row is
 * editable inline (role, status, allocation %). The "+ Add partner"
 * row at the top opens a stacked form so capture managers can build
 * out the team without leaving the tab.
 *
 * Allocation rolls up at the top so it's obvious when the team is
 * under- or over-allocated relative to 100% of contract value.
 */
export function TeamingTab({
  pursuitId,
  members,
  summary,
}: {
  pursuitId: string;
  members: PursuitTeamMember[];
  summary: TeamSummary;
}) {
  const allocationOver = summary.totalAllocationPct > 100.01;
  const allocationUnder = summary.totalCount > 0 && summary.totalAllocationPct < 99.99;
  const allocationLabel = `${summary.totalAllocationPct.toFixed(1)}%`;

  return (
    <div className="space-y-4">
      {/* Roll-up */}
      <section className="grid gap-3 rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-4 sm:grid-cols-4">
        <Stat label="Partners" value={summary.totalCount.toString()} />
        <Stat
          label="Allocated"
          value={allocationLabel}
          hint={
            allocationOver
              ? 'Over 100% — review allocations'
              : allocationUnder
                ? 'Below 100% — gap to fill'
                : null
          }
          tone={allocationOver ? 'danger' : allocationUnder ? 'warning' : 'success'}
        />
        <Stat
          label="Prime"
          value={summary.hasPrime ? 'Set' : 'Missing'}
          tone={summary.hasPrime ? 'success' : 'warning'}
        />
        <Stat label="Signed" value={`${summary.signedCount} of ${summary.totalCount}`} />
      </section>

      {/* Add partner */}
      <section className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-4">
        <h2 className="mb-1 text-sm font-semibold">Add a teaming partner</h2>
        <p className="mb-3 text-xs text-[color:var(--color-muted-foreground)]">
          Capture every firm in the bid — prime, subs, JV partners, mentors,
          and consultants — with the work share and current agreement status.
        </p>
        <form action={addTeamMemberAction} className="grid gap-2 sm:grid-cols-[1.5fr_1fr_1fr_0.6fr_auto]">
          <input type="hidden" name="pursuitId" value={pursuitId} />
          <input
            name="partnerName"
            placeholder="Partner name"
            required
            className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
          />
          <select
            name="role"
            defaultValue="subcontractor"
            className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
          >
            {TEAM_ROLES.map((r) => (
              <option key={r} value={r}>
                {TEAM_ROLE_LABEL[r]}
              </option>
            ))}
          </select>
          <select
            name="status"
            defaultValue="engaging"
            className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
          >
            {TEAMING_STATUSES.map((s) => (
              <option key={s} value={s}>
                {TEAMING_STATUS_LABEL[s]}
              </option>
            ))}
          </select>
          <input
            name="allocationPct"
            type="number"
            min="0"
            max="100"
            step="0.1"
            placeholder="% share"
            className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
          />
          <button
            type="submit"
            className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-3 py-1.5 text-sm font-medium text-[color:var(--color-background)]"
          >
            + Add
          </button>
        </form>
      </section>

      {/* Members list */}
      {members.length === 0 ? (
        <section className="rounded-[var(--radius-md)] border border-dashed border-[color:var(--color-border)] p-8 text-center text-sm text-[color:var(--color-muted-foreground)]">
          No teaming partners yet. Add the prime + any subs above.
        </section>
      ) : (
        <div className="space-y-2">
          {members.map((m) => (
            <TeamMemberCard key={m.id} member={m} />
          ))}
        </div>
      )}
    </div>
  );
}

function TeamMemberCard({ member }: { member: PursuitTeamMember }) {
  const allocPct = member.allocationPct == null ? '' : Number(member.allocationPct).toString();

  return (
    <details className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)]">
      <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <span className="text-sm font-semibold">{member.partnerName}</span>
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${chipClass(ROLE_TONE[member.role])}`}
          >
            {TEAM_ROLE_LABEL[member.role]}
          </span>
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${chipClass(STATUS_TONE[member.status])}`}
          >
            {TEAMING_STATUS_LABEL[member.status]}
          </span>
          {member.allocationPct != null && (
            <span className="text-[11px] text-[color:var(--color-muted-foreground)]">
              {Number(member.allocationPct).toFixed(1)}% share
            </span>
          )}
        </div>
        <div className="shrink-0 text-[11px] text-[color:var(--color-muted-foreground)]">
          {member.contactName ?? member.contactEmail ?? '—'}
        </div>
      </summary>

      <div className="border-t border-[color:var(--color-border)] p-4">
        <form
          action={updateTeamMemberAction}
          className="grid gap-3 sm:grid-cols-2"
        >
          <input type="hidden" name="teamMemberId" value={member.id} />

          <Field label="Partner name">
            <input
              name="partnerName"
              defaultValue={member.partnerName}
              className="w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-sm"
            />
          </Field>
          <Field label="Allocation %">
            <input
              name="allocationPct"
              type="number"
              min="0"
              max="100"
              step="0.1"
              defaultValue={allocPct}
              placeholder="—"
              className="w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-sm"
            />
          </Field>

          <Field label="Role">
            <select
              name="role"
              defaultValue={member.role}
              className="w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-sm"
            >
              {TEAM_ROLES.map((r) => (
                <option key={r} value={r}>
                  {TEAM_ROLE_LABEL[r]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Status">
            <select
              name="status"
              defaultValue={member.status}
              className="w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-sm"
            >
              {TEAMING_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {TEAMING_STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Capabilities / scope" full>
            <textarea
              name="capabilities"
              rows={2}
              defaultValue={member.capabilities ?? ''}
              placeholder="What this partner brings (services, tech, certifications, geography…)"
              className="w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-sm"
            />
          </Field>

          <Field label="Contact name">
            <input
              name="contactName"
              defaultValue={member.contactName ?? ''}
              className="w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-sm"
            />
          </Field>
          <Field label="Contact email">
            <input
              name="contactEmail"
              type="email"
              defaultValue={member.contactEmail ?? ''}
              className="w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-sm"
            />
          </Field>

          <Field label="Notes" full>
            <textarea
              name="notes"
              rows={2}
              defaultValue={member.notes ?? ''}
              className="w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-sm"
            />
          </Field>

          <div className="sm:col-span-2 flex items-center justify-between">
            <button
              type="submit"
              className="rounded-[var(--radius-sm)] bg-[color:var(--color-foreground)] px-3 py-1.5 text-xs font-medium text-[color:var(--color-background)]"
            >
              Save changes
            </button>
          </div>
        </form>

        <form action={removeTeamMemberAction} className="mt-3 text-right">
          <input type="hidden" name="teamMemberId" value={member.id} />
          <button
            type="submit"
            className="text-[10px] text-[color:var(--color-muted-foreground)] hover:text-red-600"
          >
            Remove partner
          </button>
        </form>
      </div>
    </details>
  );
}

function Field({
  label,
  full,
  children,
}: {
  label: string;
  full?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className={`block ${full ? 'sm:col-span-2' : ''}`}>
      <span className="text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
        {label}
      </span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string | null;
  tone?: ChipTone;
}) {
  const valueClass =
    tone === 'danger'
      ? 'text-red-700'
      : tone === 'warning'
        ? 'text-amber-700'
        : tone === 'success'
          ? 'text-emerald-700'
          : 'text-[color:var(--color-foreground)]';
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
        {label}
      </p>
      <p className={`mt-0.5 text-sm font-semibold ${valueClass}`}>{value}</p>
      {hint && (
        <p className="mt-0.5 text-[11px] text-[color:var(--color-muted-foreground)]">{hint}</p>
      )}
    </div>
  );
}
