import { STAGE_LABEL, type PursuitStageKey } from '../../../../lib/capture-queries';
import type { TaskRow } from './tasks-tab';
import { addTaskAction, toggleTaskAction } from '../../actions';
import { formatDate } from '../../../../lib/format';
import type { Pursuit } from '@procur/db';

export type AuditRow = {
  id: string;
  action: string;
  changes: unknown;
  metadata: unknown;
  createdAt: Date;
  actorFirstName: string | null;
  actorLastName: string | null;
};

/**
 * Activity tab — split-pane layout:
 *   LEFT  · Audit Log      derived from pursuit lifecycle + task events
 *   RIGHT · Task kanban    Pending / In Progress / Completed columns,
 *                          with an inline "+ New Task" form
 *
 * Mirrors the Activity tab in Govdash screenshots2/Screenshot 1.22.10 PM.
 *
 * The activity feed is derived from data we already track (pursuit
 * timestamps + tasks) rather than reading audit_log, because pursuit
 * actions don't currently write audit events. Adding audit writes to
 * createPursuitAction / moveStageAction / addTaskAction / toggleTaskAction
 * is a future improvement that will enrich this feed.
 */
export function PursuitActivityTab({
  pursuitId,
  pursuit,
  tasks,
  auditRows,
}: {
  pursuitId: string;
  pursuit: Pursuit;
  tasks: TaskRow[];
  auditRows: AuditRow[];
}) {
  const events = deriveActivityEvents(pursuit, tasks, auditRows);

  // Kanban columns: Pending / In Progress / Completed.
  // Same classification rule as the capture dashboard's Tasks widget so
  // the numbers line up across the product:
  //   - completed = has completedAt
  //   - in progress = not complete, due date before today (being worked on / overdue)
  //   - pending = not complete, due date today/future or no due date
  const todayIso = new Date().toISOString().slice(0, 10);
  const pending: TaskRow[] = [];
  const inProgress: TaskRow[] = [];
  const completed: TaskRow[] = [];
  for (const t of tasks) {
    if (t.completedAt) completed.push(t);
    else if (t.dueDate && t.dueDate < todayIso) inProgress.push(t);
    else pending.push(t);
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_1.5fr]">
      {/* Audit log */}
      <section className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)]">
        <header className="border-b border-[color:var(--color-border)] px-4 py-2.5">
          <h2 className="text-sm font-semibold">Audit log</h2>
          <p className="mt-0.5 text-[11px] text-[color:var(--color-muted-foreground)]">
            {events.length} event{events.length === 1 ? '' : 's'}
          </p>
        </header>
        {events.length === 0 ? (
          <p className="p-5 text-center text-xs text-[color:var(--color-muted-foreground)]">
            No activity yet.
          </p>
        ) : (
          <ul className="divide-y divide-[color:var(--color-border)]">
            {events.map((e) => (
              <li key={e.id} className="flex items-start gap-3 px-4 py-3">
                <span
                  className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${toneBg(e.tone)}`}
                  aria-hidden
                />
                <div className="flex-1 min-w-0">
                  <p className="text-xs">{e.text}</p>
                  <p className="mt-0.5 text-[10px] text-[color:var(--color-muted-foreground)]">
                    {formatRelative(e.at)}
                    {e.actor && <> · by {e.actor}</>}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Task mini-kanban */}
      <section className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)]">
        <header className="flex items-center justify-between border-b border-[color:var(--color-border)] px-4 py-2.5">
          <div>
            <h2 className="text-sm font-semibold">Tasks</h2>
            <p className="mt-0.5 text-[11px] text-[color:var(--color-muted-foreground)]">
              {pending.length + inProgress.length} open · {completed.length} done
            </p>
          </div>
          <div className="flex items-center gap-1 rounded-[var(--radius-sm)] border border-[color:var(--color-border)] p-0.5 text-[11px]">
            <span className="rounded-[var(--radius-sm)] bg-[color:var(--color-foreground)] px-2 py-0.5 text-[color:var(--color-background)]">
              Kanban
            </span>
            <span
              className="px-2 py-0.5 text-[color:var(--color-muted-foreground)]"
              title="Chat view coming soon"
            >
              Chat
            </span>
          </div>
        </header>

        <div className="grid grid-cols-3 gap-2 p-3">
          <Column title="Pending" count={pending.length} tone="neutral">
            {pending.map((t) => (
              <TaskCard key={t.id} task={t} pursuitId={pursuitId} />
            ))}
            {pending.length === 0 && <EmptyCell />}
          </Column>

          <Column title="In Progress" count={inProgress.length} tone="warning">
            {inProgress.map((t) => (
              <TaskCard key={t.id} task={t} pursuitId={pursuitId} />
            ))}
            {inProgress.length === 0 && <EmptyCell />}
          </Column>

          <Column title="Completed" count={completed.length} tone="success">
            {completed.slice(0, 10).map((t) => (
              <TaskCard key={t.id} task={t} pursuitId={pursuitId} completed />
            ))}
            {completed.length === 0 && <EmptyCell />}
            {completed.length > 10 && (
              <p className="px-1 py-1 text-[10px] text-[color:var(--color-muted-foreground)]">
                +{completed.length - 10} earlier
              </p>
            )}
          </Column>
        </div>

        {/* Inline new-task form */}
        <form
          action={addTaskAction}
          className="flex flex-wrap items-end gap-2 border-t border-[color:var(--color-border)] p-3 text-xs"
        >
          <input type="hidden" name="pursuitId" value={pursuitId} />
          <input
            name="title"
            required
            placeholder="+ New task"
            className="flex-1 rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-xs"
          />
          <input
            name="dueDate"
            type="date"
            className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-xs"
          />
          <select
            name="priority"
            defaultValue="medium"
            className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-xs"
          >
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="urgent">Urgent</option>
          </select>
          <button
            type="submit"
            className="rounded-[var(--radius-sm)] bg-[color:var(--color-foreground)] px-2.5 py-1 text-xs font-medium text-[color:var(--color-background)]"
          >
            Add
          </button>
        </form>
      </section>
    </div>
  );
}

// -- Column / Card components -----------------------------------------------

function Column({
  title,
  count,
  tone,
  children,
}: {
  title: string;
  count: number;
  tone: 'neutral' | 'warning' | 'success';
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-[var(--radius-sm)] bg-[color:var(--color-muted)]/30 p-2">
      <header className="flex items-baseline justify-between px-1 text-[11px] font-medium uppercase tracking-wider">
        <span
          className={
            tone === 'warning'
              ? 'text-amber-700'
              : tone === 'success'
                ? 'text-emerald-700'
                : 'text-[color:var(--color-muted-foreground)]'
          }
        >
          {title}
        </span>
        <span className="text-[10px] text-[color:var(--color-muted-foreground)]">{count}</span>
      </header>
      <div className="flex flex-col gap-1.5">{children}</div>
    </div>
  );
}

function TaskCard({
  task,
  pursuitId,
  completed = false,
}: {
  task: TaskRow;
  pursuitId: string;
  completed?: boolean;
}) {
  return (
    <div
      className={`rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-2 text-xs ${
        completed ? 'opacity-60' : ''
      }`}
    >
      <div className="flex items-start gap-2">
        <form action={toggleTaskAction} className="shrink-0">
          <input type="hidden" name="taskId" value={task.id} />
          <input type="hidden" name="pursuitId" value={pursuitId} />
          <button
            type="submit"
            className={`flex h-3.5 w-3.5 items-center justify-center rounded border text-[9px] ${
              completed
                ? 'border-[color:var(--color-foreground)] bg-[color:var(--color-foreground)] text-[color:var(--color-background)]'
                : 'border-[color:var(--color-border)] bg-[color:var(--color-background)] hover:border-[color:var(--color-foreground)]'
            }`}
            aria-label={completed ? 'Mark incomplete' : 'Mark complete'}
          >
            {completed ? '✓' : ''}
          </button>
        </form>
        <div className="flex-1 min-w-0">
          <p className={`${completed ? 'line-through' : 'font-medium'}`}>{task.title}</p>
          <div className="mt-1 flex items-center gap-1.5 text-[10px] text-[color:var(--color-muted-foreground)]">
            {task.dueDate && <span>Due {task.dueDate}</span>}
            {task.priority && task.priority !== 'medium' && (
              <span className={priorityClass(task.priority)}>{task.priority}</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function EmptyCell() {
  return (
    <p className="px-1 py-2 text-center text-[10px] text-[color:var(--color-muted-foreground)]/60">
      —
    </p>
  );
}

// -- Event derivation --------------------------------------------------------

type ActivityEvent = {
  id: string;
  at: Date;
  tone: 'neutral' | 'info' | 'success' | 'danger' | 'warning';
  text: string;
  actor?: string | null;
};

/**
 * Build the unified activity feed from three sources:
 *   1. pursuit lifecycle timestamps (submittedAt / wonAt / lostAt / bidDecisionAt)
 *   2. audit_log rows written by action handlers (stage moves, updates,
 *      capture answers, task created / completed / reopened)
 *   3. fallback: the pursuit's createdAt, for pursuits that predate
 *      audit writes
 *
 * Dedup: if the same logical event appears in both the pursuit row and
 * an audit log entry (e.g. pursuit.stage_moved to 'awarded' also sets
 * pursuit.wonAt), we prefer the audit entry because it carries the
 * actor name.
 */
function deriveActivityEvents(
  pursuit: Pursuit,
  tasks: TaskRow[],
  auditRows: AuditRow[],
): ActivityEvent[] {
  const out: ActivityEvent[] = [];
  const coveredByAudit = {
    submitted: false,
    won: false,
    lost: false,
    created: false,
  };

  for (const row of auditRows) {
    const actor = [row.actorFirstName, row.actorLastName].filter(Boolean).join(' ') || null;
    const ev = auditToEvent(row, actor);
    if (ev) out.push(ev);

    // Mark lifecycle events that audit already covers so we don't
    // double-render them from pursuit timestamps below.
    if (row.action === 'pursuit.created') coveredByAudit.created = true;
    if (row.action === 'pursuit.stage_moved') {
      const to = (row.changes as { after?: { stage?: string } } | null)?.after?.stage;
      if (to === 'submitted') coveredByAudit.submitted = true;
      if (to === 'awarded') coveredByAudit.won = true;
      if (to === 'lost') coveredByAudit.lost = true;
    }
  }

  // Pursuit lifecycle events — emit when audit doesn't already cover them
  // (older pursuits have no audit trail).
  if (!coveredByAudit.created) {
    out.push({
      id: `pursuit-${pursuit.id}-created`,
      at: pursuit.createdAt,
      tone: 'neutral',
      text: `Pursuit created — stage ${STAGE_LABEL[pursuit.stage as PursuitStageKey] ?? pursuit.stage}`,
    });
  }
  if (pursuit.bidDecisionAt) {
    const decision = pursuit.bidDecision ?? 'pending';
    out.push({
      id: `pursuit-${pursuit.id}-decision`,
      at: pursuit.bidDecisionAt,
      tone: decision === 'bid' ? 'info' : 'neutral',
      text: `Bid decision recorded: ${decision}`,
    });
  }
  if (pursuit.submittedAt && !coveredByAudit.submitted) {
    out.push({ id: `pursuit-${pursuit.id}-submitted`, at: pursuit.submittedAt, tone: 'info', text: 'Proposal submitted' });
  }
  if (pursuit.wonAt && !coveredByAudit.won) {
    out.push({ id: `pursuit-${pursuit.id}-won`, at: pursuit.wonAt, tone: 'success', text: 'Awarded' });
  }
  if (pursuit.lostAt && !coveredByAudit.lost) {
    out.push({ id: `pursuit-${pursuit.id}-lost`, at: pursuit.lostAt, tone: 'danger', text: 'Lost' });
  }

  // Task completion timestamps are also covered by audit task.completed /
  // task.reopened. For older tasks predating audit writes, fall back to
  // the row timestamp — dedupe by inspecting whether a matching audit
  // event exists.
  const taskEventsInAudit = new Set<string>();
  for (const r of auditRows) {
    if (r.action === 'task.completed' || r.action === 'task.reopened') {
      const taskId = (r.metadata as { taskId?: string } | null)?.taskId;
      if (taskId) taskEventsInAudit.add(`${r.action}:${taskId}:${r.createdAt.toISOString()}`);
    }
  }
  for (const t of tasks) {
    if (t.completedAt) {
      const key = `task.completed:${t.id}:${t.completedAt.toISOString()}`;
      if (!taskEventsInAudit.has(key)) {
        out.push({
          id: `task-${t.id}-completed`,
          at: t.completedAt,
          tone: 'success',
          text: `Task completed: ${t.title}`,
        });
      }
    }
  }

  // Newest first.
  return out.sort((a, b) => b.at.getTime() - a.at.getTime());
}

/**
 * Translate a single audit row into an activity event.
 */
function auditToEvent(row: AuditRow, actor: string | null): ActivityEvent | null {
  const base = {
    id: `audit-${row.id}`,
    at: row.createdAt,
    actor,
  };
  switch (row.action) {
    case 'pursuit.created':
      return { ...base, tone: 'neutral', text: 'Pursuit created' };
    case 'pursuit.stage_moved': {
      const ch = row.changes as { before?: { stage?: string }; after?: { stage?: string } } | null;
      const from = ch?.before?.stage;
      const to = ch?.after?.stage;
      if (!to) return { ...base, tone: 'neutral', text: 'Stage moved' };
      const fromLabel = from ? STAGE_LABEL[from as PursuitStageKey] ?? from : '?';
      const toLabel = STAGE_LABEL[to as PursuitStageKey] ?? to;
      const tone: ActivityEvent['tone'] =
        to === 'awarded' ? 'success' : to === 'lost' ? 'danger' : to === 'submitted' ? 'info' : 'neutral';
      return { ...base, tone, text: `Stage moved: ${fromLabel} → ${toLabel}` };
    }
    case 'pursuit.updated': {
      const fields = (row.metadata as { fields?: string[] } | null)?.fields ?? [];
      return {
        ...base,
        tone: 'neutral',
        text: fields.length > 0 ? `Updated: ${fields.join(', ')}` : 'Pursuit updated',
      };
    }
    case 'pursuit.capture_answers_saved': {
      const keys = (row.metadata as { answeredKeys?: string[] } | null)?.answeredKeys ?? [];
      return {
        ...base,
        tone: 'info',
        text: `Capture answers saved${keys.length > 0 ? ` (${keys.length} answered)` : ''}`,
      };
    }
    case 'task.created': {
      const title = (row.metadata as { title?: string } | null)?.title ?? 'Task';
      return { ...base, tone: 'neutral', text: `Task added: ${title}` };
    }
    case 'task.completed': {
      const title = (row.metadata as { title?: string } | null)?.title ?? 'Task';
      return { ...base, tone: 'success', text: `Task completed: ${title}` };
    }
    case 'task.reopened': {
      const title = (row.metadata as { title?: string } | null)?.title ?? 'Task';
      return { ...base, tone: 'warning', text: `Task reopened: ${title}` };
    }
    default:
      // Unknown action (e.g. assistant.*) — render the raw action name
      // rather than hide it entirely.
      return { ...base, tone: 'neutral', text: row.action.replace(/\./g, ' · ') };
  }
}

// -- Tiny helpers -----------------------------------------------------------

function toneBg(tone: ActivityEvent['tone']): string {
  switch (tone) {
    case 'success':
      return 'bg-emerald-500';
    case 'info':
      return 'bg-blue-500';
    case 'warning':
      return 'bg-amber-500';
    case 'danger':
      return 'bg-red-500';
    default:
      return 'bg-[color:var(--color-muted-foreground)]/50';
  }
}

function priorityClass(p: string): string {
  switch (p) {
    case 'urgent':
      return 'rounded-full bg-red-500/15 px-1.5 py-0.5 text-red-700';
    case 'high':
      return 'rounded-full bg-amber-500/15 px-1.5 py-0.5 text-amber-700';
    case 'low':
      return 'rounded-full bg-[color:var(--color-muted)]/60 px-1.5 py-0.5';
    default:
      return '';
  }
}

function formatRelative(d: Date): string {
  const diff = Date.now() - d.getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days} day${days === 1 ? '' : 's'} ago`;
  return formatDate(d);
}
