'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export function SidebarNavLink({
  href,
  label,
  external,
}: {
  href: string;
  label: string;
  external?: boolean;
}) {
  const pathname = usePathname();
  const active =
    !external &&
    (pathname === href ||
      (href !== '/' && pathname?.startsWith(`${href}/`)) ||
      (href !== '/' && pathname?.startsWith(href)));

  const baseCls =
    'block rounded-[var(--radius-sm)] px-2 py-1 text-sm transition hover:bg-[color:var(--color-background)]';
  const activeCls = active
    ? 'bg-[color:var(--color-background)] font-medium text-[color:var(--color-foreground)]'
    : 'text-[color:var(--color-foreground)]/85';

  if (external) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={`${baseCls} ${activeCls}`}>
        {label}
        <span className="ml-1 text-[10px] text-[color:var(--color-muted-foreground)]">↗</span>
      </a>
    );
  }

  return (
    <Link href={href} className={`${baseCls} ${activeCls}`}>
      {label}
    </Link>
  );
}
