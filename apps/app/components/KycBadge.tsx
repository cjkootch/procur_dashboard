import type { SupplierApprovalStatus } from '@procur/db';

/**
 * Visual KYC / approval badge — reads the per-tenant approval state
 * for a supplier entity and renders a colored pill. Used on the
 * entity profile page (large size, next to the entity name) and in
 * the rolodex list (small size, inline with the row).
 *
 * `status: null` renders nothing in 'sm' size and a muted "No
 * engagement" pill in 'lg' size — the entity profile wants the gap
 * called out so the user is prompted to mark approval; the rolodex
 * wants it hidden so unapproved suppliers don't get visual weight.
 */
export type KycBadgeProps = {
  status: SupplierApprovalStatus | null;
  size?: 'sm' | 'lg';
  /** ISO-8601. Surfaces a tooltip when set. */
  expiresAt?: string | null;
};

type StyleSpec = {
  label: string;
  // Tailwind classes — bg, text, border. Picked for high contrast at
  // small sizes (rolodex row) without being visually loud.
  cls: string;
  /** Single emoji-glyph indicator placed before the label. Empty for
   *  neutral states. */
  glyph?: string;
};

const STYLES: Record<SupplierApprovalStatus, StyleSpec> = {
  approved_with_kyc: {
    label: 'KYC Approved',
    cls: 'bg-emerald-100 text-emerald-900 border-emerald-400 ring-1 ring-emerald-200',
    glyph: '✓',
  },
  approved_without_kyc: {
    label: 'Approved (No KYC)',
    cls: 'bg-sky-100 text-sky-900 border-sky-400 ring-1 ring-sky-200',
    glyph: '✓',
  },
  kyc_in_progress: {
    label: 'KYC In Progress',
    cls: 'bg-amber-100 text-amber-900 border-amber-400 ring-1 ring-amber-200',
  },
  pending: {
    label: 'Outreach Pending',
    cls: 'bg-slate-100 text-slate-800 border-slate-300',
  },
  expired: {
    label: 'KYC Expired',
    cls: 'bg-orange-100 text-orange-900 border-orange-400 ring-1 ring-orange-200',
  },
  rejected: {
    label: 'Rejected',
    cls: 'bg-red-100 text-red-900 border-red-400',
  },
};

const NOT_ENGAGED: StyleSpec = {
  label: 'Not Engaged',
  cls: 'bg-[color:var(--color-muted)]/60 text-[color:var(--color-muted-foreground)] border-[color:var(--color-border)] border-dashed',
};

export function KycBadge({ status, size = 'sm', expiresAt }: KycBadgeProps) {
  const spec = status ? STYLES[status] : NOT_ENGAGED;
  if (!status && size === 'sm') return null;

  const sizeCls =
    size === 'lg'
      ? 'px-3 py-1 text-sm font-semibold rounded-md'
      : 'px-2 py-0.5 text-[11px] font-medium rounded';

  // Tooltip with the renewal date for KYC-approved status.
  const expiringSoon =
    status === 'approved_with_kyc' &&
    expiresAt &&
    new Date(expiresAt).getTime() - Date.now() < 1000 * 60 * 60 * 24 * 60;

  const titleAttr = expiresAt
    ? `KYC expires ${new Date(expiresAt).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })}`
    : undefined;

  return (
    <span
      title={titleAttr}
      className={`inline-flex items-center gap-1 whitespace-nowrap border ${spec.cls} ${sizeCls}`}
    >
      {spec.glyph && <span aria-hidden>{spec.glyph}</span>}
      <span>{spec.label}</span>
      {expiringSoon && (
        <span className="ml-1 text-amber-700" aria-label="renewal due soon">
          ⚠
        </span>
      )}
    </span>
  );
}
