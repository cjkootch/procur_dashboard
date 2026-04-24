import Link from 'next/link';

export type TabKey = 'overview' | 'obligations' | 'documents' | 'past-performance';

const TABS: Array<{ key: TabKey; label: string; countKey?: 'obligations' }> = [
  { key: 'overview', label: 'Overview' },
  { key: 'obligations', label: 'Obligations', countKey: 'obligations' },
  { key: 'documents', label: 'Documents' },
  { key: 'past-performance', label: 'Past Performance' },
];

export function isTabKey(v: string | undefined): v is TabKey {
  return (
    v === 'overview' ||
    v === 'obligations' ||
    v === 'documents' ||
    v === 'past-performance'
  );
}

export function ContractTabNav({
  active,
  contractId,
  obligationCount,
}: {
  active: TabKey;
  contractId: string;
  obligationCount: number;
}) {
  return (
    <nav className="flex border-b border-[color:var(--color-border)]">
      {TABS.map((t) => {
        const isActive = t.key === active;
        const count = t.countKey === 'obligations' ? obligationCount : null;
        return (
          <Link
            key={t.key}
            href={`/contract/${contractId}?tab=${t.key}`}
            className={`inline-flex items-center gap-1.5 border-b-2 px-4 py-2.5 text-sm transition ${
              isActive
                ? 'border-[color:var(--color-foreground)] font-medium text-[color:var(--color-foreground)]'
                : 'border-transparent text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]'
            }`}
          >
            {t.label}
            {count !== null && count > 0 && (
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
