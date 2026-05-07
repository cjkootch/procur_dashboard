'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { NavIcon, type NavIconName } from './nav-icons';

export function SidebarNavLink({
  href,
  label,
  iconName,
  external,
  onNavigate,
}: {
  href: string;
  label: string;
  iconName?: NavIconName;
  external?: boolean;
  /** Optional callback fired right before navigation. Used by the
      mobile drawer to close itself before the route changes. */
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const active =
    !external &&
    (pathname === href ||
      (href !== '/' && pathname?.startsWith(`${href}/`)) ||
      (href !== '/' && pathname?.startsWith(href)));

  // Active items get an accent-color left bar + filled accent-subtle
  // background + bold accent text. The base class always reserves a
  // 2px transparent left border so the layout doesn't shift when
  // navigating between items (Vercel-in-light-mode pattern: anchor
  // the active row, breathe the inactive ones).
  const baseCls =
    'group flex items-center gap-2 rounded-[var(--radius-sm)] border-l-2 border-transparent px-2 py-1.5 text-sm transition-colors';
  const activeCls = active
    ? 'border-[color:var(--color-accent)] bg-[color:var(--color-accent-subtle)] font-semibold text-[color:var(--color-accent)]'
    : 'text-[color:var(--color-foreground)]/80 hover:bg-[color:var(--color-muted)]/50 hover:text-[color:var(--color-foreground)]';

  const inner = (
    <>
      {iconName && <NavIcon name={iconName} />}
      <span className="truncate">{label}</span>
      {external && (
        <span className="ml-auto text-[10px] text-[color:var(--color-muted-foreground)]">↗</span>
      )}
    </>
  );

  if (external) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={`${baseCls} ${activeCls}`}
        onClick={onNavigate}
      >
        {inner}
      </a>
    );
  }

  return (
    <Link href={href} className={`${baseCls} ${activeCls}`} onClick={onNavigate}>
      {inner}
    </Link>
  );
}
