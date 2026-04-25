import {
  CAPABILITY_CATEGORIES,
  COVERAGE_STATUSES,
  REQUIREMENT_PRIORITIES,
  type CompanyCapability,
  type CoverageStatus,
  type RequirementPriority,
} from '@procur/db';
import {
  CAPABILITY_CATEGORY_LABEL,
  COVERAGE_STATUS_LABEL,
  REQUIREMENT_PRIORITY_LABEL,
  type CapabilitySummary,
  type RequirementRow,
} from '../../../../lib/capability-queries';
import { chipClass, type ChipTone } from '../../../../lib/chips';
import {
  addCapabilityAction,
  addRequirementAction,
  removeCapabilityAction,
  removeRequirementAction,
  updateCapabilityAction,
  updateRequirementAction,
} from '../../actions';

const COVERAGE_TONE: Record<CoverageStatus, ChipTone> = {
  not_assessed: 'neutral',
  covered: 'success',
  partial: 'warning',
  gap: 'danger',
};

const PRIORITY_TONE: Record<RequirementPriority, ChipTone> = {
  must: 'danger',
  should: 'warning',
  nice: 'neutral',
};

/**
 * Capabilities tab — the per-pursuit requirement-to-capability matrix.
 *
 * Two halves:
 *   1. Requirement matrix (top): each row = one requirement extracted
 *      from the RFP, mapped to a capability from the company bank, with
 *      a coverage status (covered / partial / gap / not_assessed).
 *   2. Company capability bank (collapsed at the bottom): the reusable
 *      list of services/certs/tech/geographies the company has. Edited
 *      here, referenced from the requirement rows above.
 *
 * Roll-up at the very top makes the gap story obvious — if any
 * must-have requirements are gaps, that's a teaming trigger or a
 * no-bid signal.
 */
export function CapabilitiesTab({
  pursuitId,
  capabilities,
  requirements,
  summary,
}: {
  pursuitId: string;
  capabilities: CompanyCapability[];
  requirements: RequirementRow[];
  summary: CapabilitySummary;
}) {
  const coveragePct = summary.total === 0 ? 0 : Math.round((summary.covered / summary.total) * 100);

  return (
    <div className="space-y-4">
      {/* Roll-up */}
      <section className="grid gap-3 rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-4 sm:grid-cols-5">
        <Stat label="Requirements" value={summary.total.toString()} />
        <Stat label="Covered" value={`${summary.covered} (${coveragePct}%)`} tone="success" />
        <Stat label="Partial" value={summary.partial.toString()} tone="warning" />
        <Stat label="Gap" value={summary.gap.toString()} tone={summary.gap > 0 ? 'danger' : 'neutral'} />
        <Stat
          label="Must-have gaps"
          value={summary.mustGapCount.toString()}
          tone={summary.mustGapCount > 0 ? 'danger' : 'success'}
          hint={summary.mustGapCount > 0 ? 'Teaming trigger or no-bid signal' : null}
        />
      </section>

      {/* Add requirement */}
      <section className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-4">
        <h2 className="mb-1 text-sm font-semibold">Add a requirement</h2>
        <p className="mb-3 text-xs text-[color:var(--color-muted-foreground)]">
          One row per requirement extracted from the RFP. Map each to one
          of your capabilities; unmapped rows are visible gaps.
        </p>
        <form
          action={addRequirementAction}
          className="grid gap-2 sm:grid-cols-[2fr_0.8fr_1fr_1fr_auto]"
        >
          <input type="hidden" name="pursuitId" value={pursuitId} />
          <input
            name="requirement"
            placeholder="Requirement text"
            required
            className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
          />
          <select
            name="priority"
            defaultValue="must"
            className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
          >
            {REQUIREMENT_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {REQUIREMENT_PRIORITY_LABEL[p]}
              </option>
            ))}
          </select>
          <select
            name="capabilityId"
            defaultValue=""
            className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
          >
            <option value="">— Unmapped —</option>
            {capabilities.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({CAPABILITY_CATEGORY_LABEL[c.category]})
              </option>
            ))}
          </select>
          <select
            name="coverage"
            defaultValue="not_assessed"
            className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
          >
            {COVERAGE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {COVERAGE_STATUS_LABEL[s]}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-3 py-1.5 text-sm font-medium text-[color:var(--color-background)]"
          >
            + Add
          </button>
        </form>
      </section>

      {/* Requirement matrix */}
      {requirements.length === 0 ? (
        <section className="rounded-[var(--radius-md)] border border-dashed border-[color:var(--color-border)] p-8 text-center text-sm text-[color:var(--color-muted-foreground)]">
          No requirements yet. Add the first one above to start building the
          capability matrix.
        </section>
      ) : (
        <section className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)]">
          <div className="grid grid-cols-[2fr_0.8fr_1fr_1fr_auto] gap-2 border-b border-[color:var(--color-border)] px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
            <span>Requirement</span>
            <span>Priority</span>
            <span>Mapped capability</span>
            <span>Coverage</span>
            <span></span>
          </div>
          <ul>
            {requirements.map((r) => (
              <RequirementRowItem key={r.id} req={r} capabilities={capabilities} />
            ))}
          </ul>
        </section>
      )}

      {/* Capability bank */}
      <details className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)]">
        <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">
          Company capability bank
          <span className="ml-2 text-[11px] font-normal text-[color:var(--color-muted-foreground)]">
            {capabilities.length} capabilities
          </span>
        </summary>
        <div className="border-t border-[color:var(--color-border)] p-4 space-y-3">
          <p className="text-xs text-[color:var(--color-muted-foreground)]">
            Reusable across every pursuit. Add the services, certifications,
            technologies, geographies, and key personnel that distinguish
            your firm. Mapped requirements above pull from this list.
          </p>
          {/* Add capability */}
          <form
            action={addCapabilityAction}
            className="grid gap-2 sm:grid-cols-[1.6fr_1fr_2fr_auto]"
          >
            <input type="hidden" name="pursuitId" value={pursuitId} />
            <input
              name="name"
              placeholder="Capability name"
              required
              className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
            />
            <select
              name="category"
              defaultValue="service"
              className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
            >
              {CAPABILITY_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {CAPABILITY_CATEGORY_LABEL[c]}
                </option>
              ))}
            </select>
            <input
              name="description"
              placeholder="Short description (optional)"
              className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
            />
            <button
              type="submit"
              className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-3 py-1.5 text-sm font-medium text-[color:var(--color-background)]"
            >
              + Add
            </button>
          </form>

          {capabilities.length === 0 ? (
            <p className="rounded-[var(--radius-sm)] border border-dashed border-[color:var(--color-border)] p-4 text-center text-xs text-[color:var(--color-muted-foreground)]">
              No capabilities yet. Add a few above to start mapping requirements.
            </p>
          ) : (
            <ul className="space-y-1">
              {capabilities.map((c) => (
                <CapabilityBankRow key={c.id} cap={c} pursuitId={pursuitId} />
              ))}
            </ul>
          )}
        </div>
      </details>
    </div>
  );
}

function RequirementRowItem({
  req,
  capabilities,
}: {
  req: RequirementRow;
  capabilities: CompanyCapability[];
}) {
  return (
    <li className="border-b border-[color:var(--color-border)]/60 last:border-b-0">
      <form
        action={updateRequirementAction}
        className="grid items-start grid-cols-[2fr_0.8fr_1fr_1fr_auto] gap-2 px-4 py-2"
      >
        <input type="hidden" name="requirementId" value={req.id} />
        <textarea
          name="requirement"
          rows={2}
          defaultValue={req.requirement}
          className="w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-sm"
        />
        <select
          name="priority"
          defaultValue={req.priority}
          className={`rounded-full px-2 py-1 text-[11px] font-medium ${chipClass(PRIORITY_TONE[req.priority])}`}
        >
          {REQUIREMENT_PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {REQUIREMENT_PRIORITY_LABEL[p]}
            </option>
          ))}
        </select>
        <select
          name="capabilityId"
          defaultValue={req.capabilityId ?? ''}
          className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-sm"
        >
          <option value="">— Unmapped —</option>
          {capabilities.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select
          name="coverage"
          defaultValue={req.coverage}
          className={`rounded-full px-2 py-1 text-[11px] font-medium ${chipClass(COVERAGE_TONE[req.coverage])}`}
        >
          {COVERAGE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {COVERAGE_STATUS_LABEL[s]}
            </option>
          ))}
        </select>
        <div className="flex flex-col gap-1">
          <button
            type="submit"
            className="rounded-[var(--radius-sm)] bg-[color:var(--color-foreground)] px-2 py-1 text-[10px] font-medium text-[color:var(--color-background)]"
          >
            Save
          </button>
        </div>
      </form>
      <form action={removeRequirementAction} className="px-4 pb-2 text-right">
        <input type="hidden" name="requirementId" value={req.id} />
        <button
          type="submit"
          className="text-[10px] text-[color:var(--color-muted-foreground)] hover:text-red-600"
        >
          Remove
        </button>
      </form>
    </li>
  );
}

function CapabilityBankRow({
  cap,
  pursuitId,
}: {
  cap: CompanyCapability;
  pursuitId: string;
}) {
  return (
    <li className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)]/60 p-2">
      <form
        action={updateCapabilityAction}
        className="grid items-center gap-2 sm:grid-cols-[1.6fr_0.8fr_2fr_auto]"
      >
        <input type="hidden" name="capabilityId" value={cap.id} />
        <input type="hidden" name="pursuitId" value={pursuitId} />
        <input
          name="name"
          defaultValue={cap.name}
          className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-sm"
        />
        <select
          name="category"
          defaultValue={cap.category}
          className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-sm"
        >
          {CAPABILITY_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {CAPABILITY_CATEGORY_LABEL[c]}
            </option>
          ))}
        </select>
        <input
          name="description"
          defaultValue={cap.description ?? ''}
          placeholder="Short description"
          className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-sm"
        />
        <button
          type="submit"
          className="rounded-[var(--radius-sm)] bg-[color:var(--color-foreground)] px-2 py-1 text-[10px] font-medium text-[color:var(--color-background)]"
        >
          Save
        </button>
      </form>
      <form action={removeCapabilityAction} className="mt-1 text-right">
        <input type="hidden" name="capabilityId" value={cap.id} />
        <input type="hidden" name="pursuitId" value={pursuitId} />
        <button
          type="submit"
          className="text-[10px] text-[color:var(--color-muted-foreground)] hover:text-red-600"
        >
          Remove
        </button>
      </form>
    </li>
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
