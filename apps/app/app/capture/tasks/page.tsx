import Link from 'next/link';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { requireCompany } from '@procur/auth';
import { db, opportunities, pursuits, pursuitTasks, users } from '@procur/db';
import { bulkCompleteTasksAction, toggleTaskAction } from '../actions';
import { CaptureViewSwitcher } from '../components/view-switcher';

export const dynamic = 'force-dynamic';

const PRIORITIES = ['urgent', 'high', 'medium', 'low'] as const;
const CATEGORIES = ['research', 'outreach', 'drafting', 'review', 'submission'] as const;

type SearchParams = {
  q?: string;
  priority?: string;
  category?: string;
  show?: string; // 'open' (default) | 'all' | 'completed'
};

export default async function AllTasksPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const q = (sp.q ?? '').trim();
  const priorityFilter =
    sp.priority && (PRIORITIES as readonly string[]).includes(sp.priority)
      ? sp.priority
      : null;
  const categoryFilter =
    sp.category && (CATEGORIES as readonly string[]).includes(sp.category)
      ? sp.category
      : null;
  const show = sp.show === 'all' || sp.show === 'completed' ? sp.show : 'open';

  const { company } = await requireCompany();

  const companyPursuits = await db
    .select({ id: pursuits.id })
    .from(pursuits)
    .where(eq(pursuits.companyId, company.id));

  if (companyPursuits.length === 0) {
    const discoverUrl =
      process.env.NEXT_PUBLIC_DISCOVER_URL ?? 'https://discover.procur.app';
    return (
      <div className="mx-auto max-w-4xl px-8 py-10">
        <h1 className="text-2xl font-semibold tracking-tight">Tasks</h1>
        <div className="mt-6 rounded-[var(--radius-lg)] border border-dashed border-[color:var(--color-border)] p-10 text-center">
          <p className="font-medium">No tasks yet</p>
          <p className="mt-2 text-sm text-[color:var(--color-muted-foreground)]">
            Tasks live on pursuits. Track an opportunity to start adding work.
          </p>
          <div className="mt-4 flex justify-center gap-2">
            <a
              href={discoverUrl}
              className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-4 py-2 text-sm font-medium text-[color:var(--color-background)]"
            >
              Browse opportunities
            </a>
            <Link
              href="/capture/new"
              className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-4 py-2 text-sm font-medium hover:bg-[color:var(--color-muted)]/40"
            >
              Add manually
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const allTasks = await db
    .select({
      id: pursuitTasks.id,
      title: pursuitTasks.title,
      dueDate: pursuitTasks.dueDate,
      category: pursuitTasks.category,
      priority: pursuitTasks.priority,
      completedAt: pursuitTasks.completedAt,
      pursuitId: pursuitTasks.pursuitId,
      opportunityTitle: opportunities.title,
      assignedUserFirstName: users.firstName,
    })
    .from(pursuitTasks)
    .innerJoin(pursuits, eq(pursuits.id, pursuitTasks.pursuitId))
    .innerJoin(opportunities, eq(opportunities.id, pursuits.opportunityId))
    .leftJoin(users, eq(users.id, pursuitTasks.assignedUserId))
    .where(
      and(
        inArray(
          pursuitTasks.pursuitId,
          companyPursuits.map((p) => p.id),
        ),
      ),
    )
    .orderBy(asc(pursuitTasks.completedAt), asc(pursuitTasks.dueDate));

  const needle = q.toLowerCase();
  const tasks = allTasks.filter((t) => {
    if (priorityFilter && t.priority !== priorityFilter) return false;
    if (categoryFilter && t.category !== categoryFilter) return false;
    if (needle.length > 0) {
      const haystack = [t.title, t.opportunityTitle, t.assignedUserFirstName]
        .filter(Boolean)
        .join('  ')
        .toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });

  const open = tasks.filter((t) => !t.completedAt);
  const done = tasks.filter((t) => t.completedAt);

  const hasActiveFilter = q || priorityFilter || categoryFilter || show !== 'open';

  // Render policy: by default we show open tasks, with completed in a
  // collapsed footer if any exist. ?show=all puts both inline at the
  // top; ?show=completed shows only the completed list (useful when
  // looking back at finished work).
  const visibleOpen = show === 'completed' ? [] : open;
  const visibleDone = show === 'open' ? [] : done;

  return (
    <div className="mx-auto max-w-4xl px-8 py-10">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Tasks</h1>
        <div className="mt-2 flex items-center justify-between gap-3">
          <CaptureViewSwitcher active="tasks" />
          <div className="flex items-center gap-3">
            {visibleOpen.length > 0 && (
              <form action={bulkCompleteTasksAction}>
                {visibleOpen.map((t) => (
                  <input key={t.id} type="hidden" name="taskId" value={t.id} />
                ))}
                <button
                  type="submit"
                  className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1 text-xs hover:bg-[color:var(--color-muted)]/40"
                >
                  Mark {visibleOpen.length} complete
                </button>
              </form>
            )}
            <p className="text-xs text-[color:var(--color-muted-foreground)]">
              {open.length} open · {done.length} completed
              {hasActiveFilter && ` · ${tasks.length} of ${allTasks.length} matching filters`}
            </p>
          </div>
        </div>
      </header>

      <form
        method="GET"
        className="mb-4 flex flex-wrap items-center gap-2 rounded-[var(--radius-md)] border border-[color:var(--color-border)] p-2 text-xs"
      >
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Search title, pursuit, assignee…"
          className="min-w-[12rem] flex-1 rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 focus:border-[color:var(--color-foreground)] focus:outline-none"
        />
        <FilterSelect
          name="priority"
          label="Priority"
          current={priorityFilter ?? ''}
          options={[{ value: '', label: 'Any' }, ...PRIORITIES.map((p) => ({ value: p, label: p }))]}
        />
        <FilterSelect
          name="category"
          label="Category"
          current={categoryFilter ?? ''}
          options={[{ value: '', label: 'Any' }, ...CATEGORIES.map((c) => ({ value: c, label: c }))]}
        />
        <FilterSelect
          name="show"
          label="Show"
          current={show}
          options={[
            { value: 'open', label: 'Open' },
            { value: 'all', label: 'All' },
            { value: 'completed', label: 'Completed' },
          ]}
        />
        <button
          type="submit"
          className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1"
        >
          Apply
        </button>
        {hasActiveFilter && (
          <Link
            href="/capture/tasks"
            className="text-[color:var(--color-muted-foreground)] hover:underline"
          >
            Clear
          </Link>
        )}
      </form>

      <ul className="space-y-2">
        {visibleOpen.map((t) => (
          <li
            key={t.id}
            className="flex items-start justify-between rounded-[var(--radius-md)] border border-[color:var(--color-border)] p-3"
          >
            <div className="flex items-start gap-3">
              <form action={toggleTaskAction} className="mt-0.5">
                <input type="hidden" name="taskId" value={t.id} />
                <input type="hidden" name="pursuitId" value={t.pursuitId} />
                <button
                  type="submit"
                  className="h-4 w-4 rounded border border-[color:var(--color-border)] bg-[color:var(--color-background)] hover:border-[color:var(--color-foreground)]"
                  aria-label="Mark complete"
                />
              </form>
              <div>
                <p className="text-sm font-medium">{t.title}</p>
                <Link
                  href={`/capture/pursuits/${t.pursuitId}`}
                  className="text-xs text-[color:var(--color-muted-foreground)] hover:underline"
                >
                  {t.opportunityTitle}
                </Link>
                <p className="text-xs text-[color:var(--color-muted-foreground)]">
                  {t.dueDate && <>Due {t.dueDate} · </>}
                  {t.category && <>{t.category} · </>}
                  {t.priority}
                </p>
              </div>
            </div>
          </li>
        ))}
        {visibleDone.length > 0 && (
          <>
            {show !== 'completed' && (
              <li className="pt-4 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
                Completed
              </li>
            )}
            {visibleDone.map((t) => (
              <li
                key={t.id}
                className="flex items-start justify-between rounded-[var(--radius-md)] border border-[color:var(--color-border)] p-3 opacity-60"
              >
                <div className="flex items-start gap-3">
                  <form action={toggleTaskAction} className="mt-0.5">
                    <input type="hidden" name="taskId" value={t.id} />
                    <input type="hidden" name="pursuitId" value={t.pursuitId} />
                    <button
                      type="submit"
                      className="h-4 w-4 rounded border border-[color:var(--color-foreground)] bg-[color:var(--color-foreground)] text-[color:var(--color-background)]"
                      aria-label="Mark incomplete"
                    >
                      ✓
                    </button>
                  </form>
                  <p className="text-sm line-through">{t.title}</p>
                </div>
              </li>
            ))}
          </>
        )}
        {tasks.length === 0 && (
          <li className="rounded-[var(--radius-md)] border border-dashed border-[color:var(--color-border)] p-10 text-center text-sm text-[color:var(--color-muted-foreground)]">
            {hasActiveFilter ? (
              <>
                No tasks match these filters.{' '}
                <Link href="/capture/tasks" className="underline">
                  Clear
                </Link>
              </>
            ) : (
              <>No tasks yet. Add them from a pursuit detail page.</>
            )}
          </li>
        )}
      </ul>
    </div>
  );
}

function FilterSelect({
  name,
  label,
  current,
  options,
}: {
  name: string;
  label: string;
  current: string;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <label className="flex items-center gap-1">
      <span className="text-[color:var(--color-muted-foreground)]">{label}:</span>
      <select
        name={name}
        defaultValue={current}
        className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 capitalize"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
