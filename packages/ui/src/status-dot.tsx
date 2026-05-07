import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';

/**
 * StatusDot — small colored disc, optionally paired with a label.
 * "Vercel-in-light-mode" pattern: a 6-8px circle in success / warn /
 * error / info / neutral hue, used inline with text to indicate state
 * without the visual weight of a pill. Use this for status indicators
 * that read as informational chrome rather than calls-to-action.
 *
 * When to reach for this vs. KycBadge or a Tailwind pill:
 *   - This: "Status: Active", "Ready · 6m ago", inline list rows.
 *   - Pill: when the status itself is the actionable affordance and
 *     needs more click-target / more text inside (KycBadge's
 *     "KYC Approved", "KYC In Progress").
 *
 * Sizes match the type system — sm pairs with text-xs, md with
 * text-sm. Colors map to the existing status tokens in tokens.css
 * so the dot stays in step with the rest of the system.
 */
export type StatusDotTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';
export type StatusDotSize = 'sm' | 'md';

const TONE_CLASSES: Record<StatusDotTone, string> = {
  success: 'bg-[color:var(--color-success)]',
  warning: 'bg-[color:var(--color-warning,#f59e0b)]',
  danger: 'bg-[color:var(--color-danger,#dc2626)]',
  // Info uses the procur-blue accent — same hue as sidebar active +
  // button focus rings for visual coherence.
  info: 'bg-[color:var(--color-accent)]',
  neutral: 'bg-[color:var(--color-muted-foreground)]',
};

const SIZE_CLASSES: Record<StatusDotSize, string> = {
  sm: 'h-1.5 w-1.5',
  md: 'h-2 w-2',
};

export type StatusDotProps = HTMLAttributes<HTMLSpanElement> & {
  tone?: StatusDotTone;
  size?: StatusDotSize;
  /** Optional inline label rendered to the right of the dot. */
  label?: ReactNode;
  /** When true, paint a soft surrounding ring at the same hue —
   *  reads as "active / pulsing" without an animation cost. Useful
   *  for "live" or "in-flight" statuses (e.g. running approvals). */
  ringed?: boolean;
};

export function StatusDot({
  tone = 'neutral',
  size = 'sm',
  label,
  ringed,
  className,
  ...rest
}: StatusDotProps) {
  const dot = (
    <span
      aria-hidden
      className={cn(
        'inline-block shrink-0 rounded-full',
        SIZE_CLASSES[size],
        TONE_CLASSES[tone],
        ringed && 'ring-2 ring-[color:var(--color-background)]',
      )}
    />
  );

  if (label == null) {
    return (
      <span
        className={cn('inline-flex items-center', className)}
        role="status"
        {...rest}
      >
        {dot}
      </span>
    );
  }

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5',
        size === 'sm' ? 'text-xs' : 'text-sm',
        className,
      )}
      role="status"
      {...rest}
    >
      {dot}
      <span className="text-[color:var(--color-foreground)]/85">{label}</span>
    </span>
  );
}
