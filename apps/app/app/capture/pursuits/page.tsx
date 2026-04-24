import Link from 'next/link';
import { requireCompany } from '@procur/auth';
import {
  listCompanyPursuits,
  STAGE_LABEL,
  STAGE_ORDER,
  type PursuitStageKey,
} from '../../../lib/capture-queries';
import { PursuitCard } from '../components/pursuit-card';

export const dynamic = 'force-dynamic';

function getOne(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

function isStage(v: string | undefined): v is PursuitStageKey {
  return STAGE_ORDER.includes(v as PursuitStageKey);
}

export default async function PursuitsListPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const stageParam = getOne(sp.stage);
  const activeStage: PursuitStageKey | null = isStage(stageParam) ? stageParam : null;

  const { company } = await requireCompany();
  const all = await listCompanyPursuits(company.id);
  const filtered = activeStage
    ? all.filter((p) => p.stage === activeStage)
    : all;

  return (
    <div className="mx-auto max-w-6xl px-8 py-10">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">All pursuits</h1>
        <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">
          {filtered.length} of {all.length} total
        </p>
      </header>

      <nav className="mb-6 flex flex-wrap gap-2 text-sm">
        <FilterLink href="/capture/pursuits" active={!activeStage}>
          All
        </FilterLink>
        {STAGE_ORDER.map((s) => (
          <FilterLink
            key={s}
            href={`/capture/pursuits?stage=${s}`}
            active={activeStage === s}
          >
            {STAGE_LABEL[s]}
          </FilterLink>
        ))}
      </nav>

      {filtered.length === 0 ? (
        <div className="rounded-[var(--radius-lg)] border border-dashed border-[color:var(--color-border)] p-10 text-center">
          <p className="font-medium">No pursuits at this stage</p>
          <p className="mt-2 text-sm text-[color:var(--color-muted-foreground)]">
            Track an opportunity from{' '}
            <a
              className="underline"
              href={process.env.NEXT_PUBLIC_DISCOVER_URL ?? 'https://discover.procur.app'}
            >
              Discover
            </a>
            .
          </p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filtered.map((p) => (
            <PursuitCard key={p.id} card={p} />
          ))}
        </div>
      )}
    </div>
  );
}

function FilterLink({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={`rounded-full border px-3 py-1 ${
        active
          ? 'border-[color:var(--color-foreground)] bg-[color:var(--color-foreground)] text-[color:var(--color-background)]'
          : 'border-[color:var(--color-border)] hover:border-[color:var(--color-foreground)]'
      }`}
    >
      {children}
    </Link>
  );
}
