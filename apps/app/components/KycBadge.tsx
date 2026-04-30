import type { SupplierApprovalStatus } from '@procur/db';

/**
 * Visual KYC / approval badge — Twitter-/Facebook-verified style.
 *
 * Approved states render as a self-contained colored circle with a
 * white checkmark icon (the icon IS the meaning, no text required —
 * just like Twitter's blue check). Other states render a small
 * pill with an icon AND a short label, since the icon alone would
 * be ambiguous for "in progress" / "expired" / "rejected".
 *
 * Used at three sizes:
 *   - 'lg'  → entity profile page header (next to the h1 name)
 *   - 'md'  → settings list and dense surfaces
 *   - 'sm'  → rolodex row inline with the entity name
 *
 * `status: null` (no engagement yet) shows a muted "Mark approval"
 * dashed pill at lg/md, and a faint dotted circle at sm — so the
 * gap is visible at a glance and the user is prompted to fill it
 * in instead of seeing nothing at all.
 */
export type KycBadgeProps = {
  status: SupplierApprovalStatus | null;
  size?: 'sm' | 'md' | 'lg';
  /** ISO-8601. Drives the renewal-due tooltip + the ⚠ indicator. */
  expiresAt?: string | null;
};

type IconStyle = {
  /** Bg color class for the icon disk. */
  bg: string;
  /** Stroke / glyph color. */
  fg: string;
  /** Border ring (subtle outline for contrast on light + dark). */
  ring: string;
};

type StatusSpec = {
  label: string;
  /** Inline icon — checkmark | clock | dot | warn | x. */
  icon: 'check' | 'clock' | 'dot' | 'warn' | 'x';
  iconStyle: IconStyle;
  /** When true, render icon-only (Twitter-verified style). When false,
   *  render icon + label as a pill. */
  iconOnly: boolean;
};

const SPEC: Record<SupplierApprovalStatus, StatusSpec> = {
  approved_with_kyc: {
    label: 'KYC Approved',
    icon: 'check',
    iconStyle: { bg: 'bg-sky-500', fg: 'text-white', ring: 'ring-sky-200' },
    iconOnly: true,
  },
  approved_without_kyc: {
    label: 'Approved',
    icon: 'check',
    iconStyle: { bg: 'bg-slate-500', fg: 'text-white', ring: 'ring-slate-200' },
    iconOnly: true,
  },
  kyc_in_progress: {
    label: 'KYC In Progress',
    icon: 'clock',
    iconStyle: { bg: 'bg-amber-400', fg: 'text-amber-950', ring: 'ring-amber-200' },
    iconOnly: false,
  },
  pending: {
    label: 'Outreach',
    icon: 'dot',
    iconStyle: { bg: 'bg-slate-300', fg: 'text-slate-700', ring: 'ring-slate-200' },
    iconOnly: false,
  },
  expired: {
    label: 'KYC Expired',
    icon: 'warn',
    iconStyle: { bg: 'bg-orange-500', fg: 'text-white', ring: 'ring-orange-200' },
    iconOnly: false,
  },
  rejected: {
    label: 'Rejected',
    icon: 'x',
    iconStyle: { bg: 'bg-red-500', fg: 'text-white', ring: 'ring-red-200' },
    iconOnly: false,
  },
};

const NOT_ENGAGED: StatusSpec = {
  label: 'Mark approval',
  icon: 'dot',
  iconStyle: {
    bg: 'bg-transparent border border-dashed border-[color:var(--color-border)]',
    fg: 'text-[color:var(--color-muted-foreground)]',
    ring: '',
  },
  iconOnly: false,
};

export function KycBadge({ status, size = 'sm', expiresAt }: KycBadgeProps) {
  // sm-sized rendering of the "not engaged" state would put a CTA
  // pill on every unengaged row in the rolodex — too much visual
  // weight on the long tail. Render nothing instead; the larger
  // surfaces (entity profile / settings) still surface the prompt.
  if (status == null && size === 'sm') return null;

  const spec = status ? SPEC[status] : NOT_ENGAGED;

  const expiringSoon =
    status === 'approved_with_kyc' &&
    expiresAt &&
    new Date(expiresAt).getTime() - Date.now() < 1000 * 60 * 60 * 24 * 60;

  const tooltipParts: string[] = [spec.label];
  if (expiresAt) {
    tooltipParts.push(
      `KYC expires ${new Date(expiresAt).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })}`,
    );
  }
  const titleAttr = tooltipParts.join(' · ');

  // Disk size scales with the parent context. lg sits next to an h1
  // (text-2xl ≈ 24px), so 24px keeps the optical alignment clean.
  const diskSize =
    size === 'lg' ? 'h-6 w-6 text-sm' : size === 'md' ? 'h-5 w-5 text-xs' : 'h-4 w-4 text-[10px]';

  // Icon-only path: just the disk, no text. The shape itself reads as
  // "verified" without any label — same visual contract as Twitter's
  // blue check.
  if (spec.iconOnly && status != null) {
    return (
      <span
        title={titleAttr}
        aria-label={titleAttr}
        className={`inline-flex shrink-0 items-center justify-center rounded-full ring-2 align-middle ${diskSize} ${spec.iconStyle.bg} ${spec.iconStyle.fg} ${spec.iconStyle.ring}`}
      >
        <Icon kind={spec.icon} />
        {expiringSoon && <span className="sr-only">renewal due soon</span>}
      </span>
    );
  }

  // Pill path: icon disk + short text label. Used for in-progress,
  // expired, rejected, and the "Mark approval" empty state.
  const labelCls =
    size === 'lg'
      ? 'px-2.5 py-1 text-sm font-medium'
      : size === 'md'
        ? 'px-2 py-0.5 text-xs font-medium'
        : 'px-1.5 py-0.5 text-[11px] font-medium';

  return (
    <span
      title={titleAttr}
      aria-label={titleAttr}
      className={`inline-flex items-center gap-1.5 rounded-full border border-transparent align-middle ${labelCls} ${
        status == null
          ? 'border-dashed border-[color:var(--color-border)] text-[color:var(--color-muted-foreground)]'
          : 'bg-[color:var(--color-muted)]/40 text-[color:var(--color-foreground)]'
      }`}
    >
      <span
        className={`inline-flex shrink-0 items-center justify-center rounded-full ${diskSize} ${spec.iconStyle.bg} ${spec.iconStyle.fg} ${spec.iconStyle.ring ? `ring-2 ${spec.iconStyle.ring}` : ''}`}
      >
        <Icon kind={spec.icon} />
      </span>
      <span>{spec.label}</span>
      {expiringSoon && (
        <span className="text-amber-700" aria-label="renewal due soon">
          ⚠
        </span>
      )}
    </span>
  );
}

/** Small inline SVG glyph for the disk. Inline SVG keeps us off any
 *  icon-library dependency and renders crisply at every size. */
function Icon({ kind }: { kind: StatusSpec['icon'] }) {
  switch (kind) {
    case 'check':
      return (
        <svg viewBox="0 0 16 16" fill="none" className="h-[60%] w-[60%]" aria-hidden>
          <path
            d="M3 8.5L6.5 12L13 4.5"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case 'clock':
      return (
        <svg viewBox="0 0 16 16" fill="none" className="h-[65%] w-[65%]" aria-hidden>
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.6" />
          <path d="M8 4.5V8L10.5 9.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      );
    case 'dot':
      return (
        <span
          className="inline-block h-1.5 w-1.5 rounded-full bg-current"
          aria-hidden
        />
      );
    case 'warn':
      return (
        <svg viewBox="0 0 16 16" fill="none" className="h-[65%] w-[65%]" aria-hidden>
          <path
            d="M8 3v5.5"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
          />
          <circle cx="8" cy="11.5" r="1.1" fill="currentColor" />
        </svg>
      );
    case 'x':
      return (
        <svg viewBox="0 0 16 16" fill="none" className="h-[55%] w-[55%]" aria-hidden>
          <path
            d="M4 4L12 12M12 4L4 12"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
          />
        </svg>
      );
  }
}
