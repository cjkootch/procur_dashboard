'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  { slug: 'overview', label: 'Overview' },
  { slug: 'targets', label: 'Targets' },
  { slug: 'communications', label: 'Communications' },
  { slug: 'plan', label: 'Plan' },
  { slug: 'settings', label: 'Settings' },
] as const;

interface Props {
  probeId: string;
}

export function ProbeTabs({ probeId }: Props) {
  const pathname = usePathname() ?? '';
  const base = `/market-probes/${probeId}`;
  return (
    <nav className="mb-6 flex gap-1 border-b border-[color:var(--color-border)] text-sm">
      {TABS.map((tab) => {
        const href = `${base}/${tab.slug}`;
        const isActive =
          pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={tab.slug}
            href={href}
            className={
              isActive
                ? 'border-b-2 border-[color:var(--color-foreground)] px-3 py-2 font-medium text-[color:var(--color-foreground)]'
                : 'border-b-2 border-transparent px-3 py-2 text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]'
            }
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
