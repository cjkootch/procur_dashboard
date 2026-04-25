import Link from 'next/link';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { requireCompany } from '@procur/auth';
import { db, opportunities, pursuits, pursuitTasks, users } from '@procur/db';
import { toggleTaskAction } from '../actions';
import { CaptureViewSwitcher } from '../components/view-switcher';

export const dynamic = 'force-dynamic';

export default async function AllTasksPage() {
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

  const tasks = await db
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

  const open = tasks.filter((t) => !t.completedAt);
  const done = tasks.filter((t) => t.completedAt);

  return (
    <div className="mx-auto max-w-4xl px-8 py-10">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Tasks</h1>
        <div className="mt-2 flex items-center justify-between">
          <CaptureViewSwitcher active="tasks" />
          <p className="text-xs text-[color:var(--color-muted-foreground)]">
            {open.length} open · {done.length} completed
          </p>
        </div>
      </header>

      <ul className="space-y-2">
        {open.map((t) => (
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
        {done.length > 0 && (
          <>
            <li className="pt-4 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
              Completed
            </li>
            {done.map((t) => (
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
            No tasks yet. Add them from a pursuit detail page.
          </li>
        )}
      </ul>
    </div>
  );
}
