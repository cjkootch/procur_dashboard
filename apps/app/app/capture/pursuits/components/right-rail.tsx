import Link from 'next/link';
import { Button, Card, Input, Label, Textarea } from '@procur/ui';
import type { PursuitCard, PursuitStageKey } from '../../../../lib/capture-queries';
import { STAGE_LABEL, STAGE_ORDER } from '../../../../lib/capture-queries';
import { updatePursuitAction } from '../../actions';
import { createContractFromPursuitAction } from '../../../contract/actions';

/**
 * Right rail for the pursuit detail page. Four cards in this order:
 *   1. Members (assigned user; capture manager when K7 adds it)
 *   2. Quick edit (P(Win), notes)
 *   3. Capture progress (stage indicator, congratulations/create-contract on win)
 *   4. Related (proposal, contract, pricer)
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
      <Card padding="md">
        <Label as="div" className="mb-3">
          Members
        </Label>
        <div className="flex items-center gap-2.5">
          {assignedUserName ? (
            <>
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[color:var(--color-foreground)]/10 text-[11px] font-semibold uppercase text-[color:var(--color-foreground)]">
                {initials(assignedUserName)}
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{assignedUserName}</p>
                <p className="text-xs text-[color:var(--color-muted-foreground)]">
                  Capture manager
                </p>
              </div>
            </>
          ) : (
            <p className="text-sm text-[color:var(--color-muted-foreground)]">
              Unassigned
            </p>
          )}
        </div>
      </Card>

      {/* Quick edit */}
      <Card padding="md">
        <Label as="div" className="mb-3">
          Quick edit
        </Label>
        <form action={updatePursuitAction} className="space-y-3">
          <input type="hidden" name="pursuitId" value={card.id} />
          <label className="flex items-center justify-between gap-2 text-sm">
            <span className="text-[color:var(--color-muted-foreground)]">P(Win)</span>
            <Input
              name="pWin"
              type="number"
              step="0.05"
              min="0"
              max="1"
              defaultValue={card.pWin ?? ''}
              placeholder="0.00"
              className="w-20 text-right"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm text-[color:var(--color-muted-foreground)]">
              Notes
            </span>
            <Textarea
              name="notes"
              rows={3}
              defaultValue={card.notes ?? ''}
              placeholder="Internal notes"
            />
          </label>
          <Button type="submit" size="sm" className="w-full">
            Save
          </Button>
        </form>
      </Card>

      {/* Capture progress */}
      <Card padding="md">
        <Label as="div" className="mb-3">
          Capture progress
        </Label>
        <div className="space-y-1.5">
          {STAGE_ORDER.filter((s) => s !== 'lost').map((stage, i) => {
            const isActive = stage === activeStage;
            const isPast =
              i <= activeIndex && !['lost'].includes(activeStage as string);
            return (
              <div key={stage} className="flex items-center gap-2 text-xs">
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
                      ? 'font-medium text-[color:var(--color-foreground)]'
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

        {card.stage === 'awarded' &&
          (linkedContractId ? (
            <Link
              href={`/contract/${linkedContractId}`}
              className="mt-3 block rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-3 py-1.5 text-center text-xs font-medium hover:bg-[color:var(--color-muted)]/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-foreground)]/30"
            >
              View contract →
            </Link>
          ) : (
            <form action={createContractFromPursuitAction} className="mt-3">
              <input type="hidden" name="pursuitId" value={card.id} />
              <Button type="submit" size="sm" className="w-full">
                Create contract
              </Button>
            </form>
          ))}
      </Card>

      {/* Related */}
      <Card padding="md">
        <Label as="div" className="mb-3">
          Related
        </Label>
        <ul className="space-y-2 text-sm">
          <li>
            <Link
              href={`/proposal/${card.id}`}
              className="hover:underline focus-visible:outline-none focus-visible:underline"
            >
              Proposal →
            </Link>
          </li>
          <li>
            <Link
              href={`/pricer/${card.id}`}
              className="hover:underline focus-visible:outline-none focus-visible:underline"
            >
              Pricer →
            </Link>
          </li>
          {linkedContractId && (
            <li>
              <Link
                href={`/contract/${linkedContractId}`}
                className="hover:underline focus-visible:outline-none focus-visible:underline"
              >
                Contract →
              </Link>
            </li>
          )}
        </ul>
      </Card>
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
