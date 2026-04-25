import { and, asc, eq, inArray } from 'drizzle-orm';
import { db, opportunities, pursuits, pursuitTasks, users } from '@procur/db';
import { requireCompany } from '@procur/auth';
import { csvResponse, toCsv } from '../../../../../lib/csv';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PRIORITIES = ['urgent', 'high', 'medium', 'low'] as const;
const CATEGORIES = ['research', 'outreach', 'drafting', 'review', 'submission'] as const;

/**
 * Tasks CSV export. Cross-pursuit, scoped to the current company.
 *
 * Honors the same `?q=`, `?priority=`, `?category=`, `?show=` params
 * as /capture/tasks so the export matches the on-screen filter once
 * the page-side toolbar (PR #70) lands. Without params, exports every
 * task — useful for full-team standups + post-mortems.
 */
export async function GET(req: Request): Promise<Response> {
  const { company } = await requireCompany();
  const url = new URL(req.url);
  const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
  const priorityParam = url.searchParams.get('priority');
  const categoryParam = url.searchParams.get('category');
  const showParam = url.searchParams.get('show');
  const priority =
    priorityParam && (PRIORITIES as readonly string[]).includes(priorityParam)
      ? priorityParam
      : null;
  const category =
    categoryParam && (CATEGORIES as readonly string[]).includes(categoryParam)
      ? categoryParam
      : null;
  const show = showParam === 'all' || showParam === 'completed' ? showParam : 'open';

  const companyPursuits = await db
    .select({ id: pursuits.id })
    .from(pursuits)
    .where(eq(pursuits.companyId, company.id));

  if (companyPursuits.length === 0) {
    return csvResponse(
      `procur-tasks-${new Date().toISOString().slice(0, 10)}.csv`,
      toCsv(
        [
          'Task ID',
          'Title',
          'Pursuit',
          'Pursuit ID',
          'Status',
          'Priority',
          'Category',
          'Due date',
          'Completed at',
          'Assignee',
        ],
        [],
      ),
    );
  }

  const allRows = await db
    .select({
      id: pursuitTasks.id,
      title: pursuitTasks.title,
      dueDate: pursuitTasks.dueDate,
      category: pursuitTasks.category,
      priority: pursuitTasks.priority,
      completedAt: pursuitTasks.completedAt,
      pursuitId: pursuitTasks.pursuitId,
      opportunityTitle: opportunities.title,
      assignedFirstName: users.firstName,
      assignedLastName: users.lastName,
      assignedEmail: users.email,
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

  const filtered = allRows.filter((t) => {
    if (priority && t.priority !== priority) return false;
    if (category && t.category !== category) return false;
    if (show === 'open' && t.completedAt) return false;
    if (show === 'completed' && !t.completedAt) return false;
    if (q.length > 0) {
      const haystack = [t.title, t.opportunityTitle, t.assignedFirstName]
        .filter(Boolean)
        .join('  ')
        .toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  const headers = [
    'Task ID',
    'Title',
    'Pursuit',
    'Pursuit ID',
    'Status',
    'Priority',
    'Category',
    'Due date',
    'Completed at',
    'Assignee',
  ];

  const csvRows = filtered.map((t) => {
    const assignee =
      [t.assignedFirstName, t.assignedLastName].filter(Boolean).join(' ') ||
      t.assignedEmail ||
      '';
    return [
      t.id,
      t.title,
      t.opportunityTitle,
      t.pursuitId,
      t.completedAt ? 'completed' : 'open',
      t.priority ?? '',
      t.category ?? '',
      t.dueDate ?? '',
      t.completedAt ? t.completedAt.toISOString() : '',
      assignee,
    ];
  });

  const csv = toCsv(headers, csvRows);
  const today = new Date().toISOString().slice(0, 10);
  return csvResponse(`procur-tasks-${today}.csv`, csv);
}
