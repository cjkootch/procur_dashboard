import Link from 'next/link';

export type TabKey = 'overview' | 'labor' | 'indirect' | 'line-items';

export const TABS: Array<{ key: TabKey; label: string; countKey?: 'labor' }> = [
  { key: 'overview', label: 'Overview' },
  { key: 'labor', label: 'Labor Categories', countKey: 'labor' },
  { key: 'indirect', label: 'Indirect Rates' },
  { key: 'line-items', label: 'Line Items' },
];

export function isTabKey(v: string | undefined): v is TabKey {
  return v === 'overview' || v === 'labor' || v === 'indirect' || v === 'line-items';
}

export function PricerTabNav({
  active,
  pursuitId,
  laborCount,
}: {
  active: TabKey;
  pursuitId: string;
  laborCount: number;
}) {
  return (
    <nav className="flex border-b border-[color:var(--color-border)]">
      {TABS.map((t) => {
        const isActive = t.key === active;
        const count = t.countKey === 'labor' ? laborCount : null;
        return (
          <Link
            key={t.key}
            href={`/pricer/${pursuitId}?tab=${t.key}`}
            className={`relative inline-flex items-center gap-1.5 border-b-2 px-4 py-2.5 text-sm transition ${
              isActive
                ? 'border-[color:var(--color-foreground)] font-medium text-[color:var(--color-foreground)]'
                : 'border-transparent text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]'
            }`}
          >
            {t.label}
            {count !== null && (
              <span className="rounded-full bg-[color:var(--color-muted)]/60 px-1.5 py-0.5 text-[10px] font-medium">
                {count}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
