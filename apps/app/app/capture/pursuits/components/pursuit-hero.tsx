import type { PursuitCard } from '../../../../lib/capture-queries';
import { STAGE_LABEL } from '../../../../lib/capture-queries';
import { flagFor, formatDate, formatMoney, timeUntil } from '../../../../lib/format';
import {
  chipClass,
  fundingChip,
  lifecycleChip,
  matchChip,
  preferenceChips,
  typeChip,
  type Chip,
} from '../../../../lib/chips';

/**
 * Header block for the pursuit detail page: flag + title + agency sub +
 * multi-chip strip using the shared lib/chips.ts vocabulary. Mirrors the
 * GovDash detail-page hero without the US-federal-only chips.
 */
export function PursuitHero({
  card,
  raw,
  discoverUrl,
}: {
  card: PursuitCard;
  raw: { aiSummary?: string | null } | null | undefined;
  discoverUrl: string;
}) {
  const op = card.opportunity;
  const countdown = timeUntil(op.deadlineAt);
  const contextText = `${op.agencyName ?? ''} ${raw?.aiSummary ?? ''}`;

  const chips: Chip[] = [
    { label: STAGE_LABEL[card.stage], tone: stageTone(card.stage) },
  ];
  const lc = lifecycleChip(op.deadlineAt);
  if (lc) chips.push(lc);
  const tc = typeChip(op.type);
  if (tc) chips.push(tc);
  const fc = fundingChip(contextText);
  if (fc) chips.push(fc);
  for (const p of preferenceChips(contextText).slice(0, 2)) chips.push(p);
  const mc = matchChip(card.pWin);
  if (mc) chips.push(mc);

  const value = formatMoney(op.valueEstimate, op.currency);

  // Private uploaded opportunities have no jurisdiction; render a neutral
  // "Private bid" badge so the hero layout still has a leading visual.
  const isPrivate = op.jurisdictionCountry == null;

  return (
    <div>
      <div className="flex items-start gap-3">
        {isPrivate ? (
          <span
            aria-label="Private bid"
            className="rounded-[var(--radius-sm)] bg-[color:var(--color-muted)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-[color:var(--color-muted-foreground)]"
          >
            Private
          </span>
        ) : (
          <span aria-label={op.jurisdictionName ?? undefined} className="text-2xl leading-none">
            {flagFor(op.jurisdictionCountry)}
          </span>
        )}
        <div className="flex-1">
          <h1 className="text-xl font-semibold tracking-tight">{op.title}</h1>
          <p className="mt-0.5 text-xs text-[color:var(--color-muted-foreground)]">
            {op.jurisdictionName ?? 'Private bid'}
            {op.agencyName && <> · {op.agencyName}</>}
            {op.referenceNumber && (
              <>
                {' · '}
                <span className="font-mono">{op.referenceNumber}</span>
              </>
            )}
          </p>
        </div>
        {op.slug && (
          <a
            href={`${discoverUrl}/opportunities/${op.slug}`}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 text-xs underline text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"
          >
            View on Discover ↗
          </a>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {chips.map((c, i) => (
          <span
            key={`${c.label}-${i}`}
            title={c.title}
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${chipClass(c.tone)}`}
          >
            {c.label}
          </span>
        ))}
        {value && (
          <span className="inline-flex items-center rounded-full border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-0.5 text-[11px]">
            <span className="font-semibold">{value}</span>
            {op.valueEstimateUsd && op.currency !== 'USD' && (
              <span className="ml-1 text-[color:var(--color-muted-foreground)]">
                ≈ {formatMoney(op.valueEstimateUsd, 'USD')}
              </span>
            )}
          </span>
        )}
        {op.deadlineAt && (
          <span className="inline-flex items-center rounded-full border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-0.5 text-[11px]">
            <span className="text-[color:var(--color-muted-foreground)]">Closes:</span>
            <span className="ml-1 font-medium">{formatDate(op.deadlineAt)}</span>
            {countdown && countdown !== 'closed' && (
              <span className="ml-1 text-[color:var(--color-muted-foreground)]">· in {countdown}</span>
            )}
          </span>
        )}
      </div>
    </div>
  );
}

function stageTone(stage: PursuitCard['stage']) {
  switch (stage) {
    case 'awarded':
      return 'success';
    case 'lost':
      return 'danger';
    case 'submitted':
      return 'info';
    case 'proposal_development':
      return 'accent';
    default:
      return 'neutral';
  }
}
