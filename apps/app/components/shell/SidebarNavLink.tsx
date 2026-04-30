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

  const baseCls =
    'flex items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-sm transition hover:bg-[color:var(--color-background)]';
  const activeCls = active
    ? 'bg-[color:var(--color-accent-subtle)] font-medium text-[color:var(--color-accent)]'
    : 'text-[color:var(--color-foreground)]/85';

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
