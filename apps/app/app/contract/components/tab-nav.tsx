import Link from 'next/link';

export type TabKey =
  | 'overview'
  | 'modifications'
  | 'clins'
  | 'task-areas'
  | 'obligations'
  | 'documents'
  | 'past-performance';

const TABS: Array<{ key: TabKey; label: string; countKey?: 'obligations' | 'modifications' | 'clins' | 'task-areas' }> = [
  { key: 'overview', label: 'Overview' },
  { key: 'modifications', label: 'Modifications', countKey: 'modifications' },
  { key: 'clins', label: 'CLINs', countKey: 'clins' },
  { key: 'task-areas', label: 'Task Areas', countKey: 'task-areas' },
  { key: 'obligations', label: 'Obligations', countKey: 'obligations' },
  { key: 'documents', label: 'Documents' },
  { key: 'past-performance', label: 'Past Performance' },
];

export function isTabKey(v: string | undefined): v is TabKey {
  return (
    v === 'overview' ||
    v === 'modifications' ||
    v === 'clins' ||
    v === 'task-areas' ||
    v === 'obligations' ||
    v === 'documents' ||
    v === 'past-performance'
  );
}

export function ContractTabNav({
  active,
  contractId,
  obligationCount,
  modificationCount,
  clinCount,
  taskAreaCount,
}: {
  active: TabKey;
  contractId: string;
  obligationCount: number;
  modificationCount: number;
  clinCount: number;
  taskAreaCount: number;
}) {
  return (
    <nav className="flex flex-wrap border-b border-[color:var(--color-border)]">
      {TABS.map((t) => {
        const isActive = t.key === active;
        const count =
          t.countKey === 'obligations'
            ? obligationCount
            : t.countKey === 'modifications'
              ? modificationCount
              : t.countKey === 'clins'
                ? clinCount
                : t.countKey === 'task-areas'
                  ? taskAreaCount
                  : null;
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
