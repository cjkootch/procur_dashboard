import Link from 'next/link';
import type { PursuitCard, PursuitStageKey } from '../../../../lib/capture-queries';
import { STAGE_LABEL, STAGE_ORDER } from '../../../../lib/capture-queries';
import { updatePursuitAction } from '../../actions';
import { createContractFromPursuitAction } from '../../../contract/actions';

/**
 * Right rail for the pursuit detail page. Four cards in this order:
 *   1. Members (assigned user; capture manager when K7 adds it)
 *   2. Quick edit (P(Win), notes)
 *   3. Linked items (proposal, contract, pricer, past-performance)
 *   4. Capture Progress (stage indicator, congratulations/create-contract on win)
 *
 * Mirrors the right rail in GovDash Screenshot 1.22.07 PM.
 */
export function PursuitRightRail({
  card,
  assignedUserName,
  linkedContractId,
}: {
  card: PursuitCard;
  assignedUserName: string | null;
  linkedContractId: string | null;
}) {
  const activeStage = card.stage as PursuitStageKey;
  const activeIndex = STAGE_ORDER.indexOf(activeStage);

  return (
    <aside className="w-full shrink-0 space-y-3 md:w-64">
      {/* Members */}
      <section className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-3">
        <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
          Members
        </h3>
        <div className="flex items-center gap-2">
          {assignedUserName ? (
            <>
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[color:var(--color-foreground)]/10 text-[10px] font-medium uppercase text-[color:var(--color-foreground)]">
                {initials(assignedUserName)}
              </span>
              <div className="min-w-0">
                <p className="truncate text-xs font-medium">{assignedUserName}</p>
                <p className="text-[10px] text-[color:var(--color-muted-foreground)]">
                  Capture manager
                </p>
              </div>
            </>
          ) : (
            <p className="text-xs text-[color:var(--color-muted-foreground)]">
              Unassigned
            </p>
          )}
        </div>
      </section>

      {/* Quick edit */}
      <section className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-3">
        <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
          Quick edit
        </h3>
        <form action={updatePursuitAction} className="space-y-2">
          <input type="hidden" name="pursuitId" value={card.id} />
          <label className="flex items-center justify-between gap-2 text-xs">
            <span className="text-[color:var(--color-muted-foreground)]">P(Win)</span>
            <input
              name="pWin"
              type="number"
              step="0.05"
              min="0"
              max="1"
              defaultValue={card.pWin ?? ''}
              placeholder="0.00"
              className="w-20 rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1 text-right text-xs"
            />
          </label>
          <label className="block text-xs">
            <span className="text-[color:var(--color-muted-foreground)]">Notes</span>
            <textarea
              name="notes"
              rows={3}
              defaultValue={card.notes ?? ''}
              placeholder="Internal notes"
              className="mt-1 w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1 text-xs"
            />
          </label>
          <button
            type="submit"
            className="w-full rounded-[var(--radius-sm)] bg-[color:var(--color-foreground)] py-1.5 text-xs font-medium text-[color:var(--color-background)]"
          >
            Save
          </button>
        </form>
      </section>

      {/* Capture progress */}
      <section className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-3">
        <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
          Capture progress
        </h3>
        <div className="space-y-1">
          {STAGE_ORDER.filter((s) => s !== 'lost').map((stage, i) => {
            const isActive = stage === activeStage;
            const isPast =
              i <= activeIndex && !['lost'].includes(activeStage as string);
            return (
              <div key={stage} className="flex items-center gap-2 text-[11px]">
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    isActive
                      ? 'bg-[color:var(--color-foreground)]'
                      : isPast
                        ? 'bg-emerald-500'
                        : 'bg-[color:var(--color-border)]'
                  }`}
                />
                <span
                  className={
                    isActive
                      ? 'font-medium'
                      : isPast
                        ? 'text-[color:var(--color-muted-foreground)]'
                        : 'text-[color:var(--color-muted-foreground)]/60'
                  }
                >
                  {STAGE_LABEL[stage]}
                </span>
              </div>
            );
          })}
        </div>

        {/* Won → contract link */}
        {card.stage === 'awarded' &&
          (linkedContractId ? (
            <Link
              href={`/contract/${linkedContractId}`}
              className="mt-3 block rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1 text-center text-[11px] font-medium hover:bg-[color:var(--color-muted)]/40"
            >
              View contract →
            </Link>
          ) : (
            <form action={createContractFromPursuitAction} className="mt-3">
              <input type="hidden" name="pursuitId" value={card.id} />
              <button
                type="submit"
                className="w-full rounded-[var(--radius-sm)] bg-[color:var(--color-foreground)] px-2 py-1 text-[11px] font-medium text-[color:var(--color-background)]"
              >
                Create contract
              </button>
            </form>
          ))}
      </section>

      {/* Related */}
      <section className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-3">
        <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
          Related
        </h3>
        <ul className="space-y-1 text-xs">
          <li>
            <Link href={`/proposal/${card.id}`} className="hover:underline">
              Proposal →
            </Link>
          </li>
          <li>
            <Link href={`/pricer/${card.id}`} className="hover:underline">
              Pricer →
            </Link>
          </li>
          {linkedContractId && (
            <li>
              <Link href={`/contract/${linkedContractId}`} className="hover:underline">
                Contract →
              </Link>
            </li>
          )}
        </ul>
      </section>
    </aside>
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((p) => p[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();
}
