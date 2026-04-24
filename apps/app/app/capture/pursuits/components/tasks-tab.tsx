import { addTaskAction, toggleTaskAction } from '../../actions';

export type TaskRow = {
  id: string;
  title: string;
  description: string | null;
  dueDate: string | null;
  completedAt: Date | null;
  priority: string | null;
  category: string | null;
  assignedUserFirstName: string | null;
  assignedUserLastName: string | null;
};

/**
 * Tasks tab — open tasks on top, completed at the bottom, add-task form
 * at the top. Same behavior as before; the GovDash equivalent is an
 * embedded mini-kanban (Pending / In Progress) which we'll build in K4.
 */
export function PursuitTasksTab({
  pursuitId,
  tasks,
}: {
  pursuitId: string;
  tasks: TaskRow[];
}) {
  const open = tasks.filter((t) => !t.completedAt);
  const done = tasks.filter((t) => t.completedAt);

  return (
    <div className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)]">
      <header className="flex items-center justify-between border-b border-[color:var(--color-border)] px-5 py-3">
        <h2 className="text-sm font-semibold">
          Tasks ({open.length} open{done.length > 0 ? ` · ${done.length} done` : ''})
        </h2>
      </header>

      <form
        action={addTaskAction}
        className="flex flex-wrap items-end gap-2 border-b border-[color:var(--color-border)] p-4"
      >
        <input type="hidden" name="pursuitId" value={pursuitId} />
        <label className="flex flex-1 min-w-[200px] flex-col gap-1 text-sm">
          <span className="text-[11px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
            New task
          </span>
          <input
            name="title"
            required
            placeholder="Meet with customer · Research incumbent · Draft past performance"
            className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[11px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
            Due
          </span>
          <input
            name="dueDate"
            type="date"
            className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[11px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
            Category
          </span>
          <select
            name="category"
            className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-sm"
          >
            <option value="">—</option>
            <option value="research">Research</option>
            <option value="outreach">Outreach</option>
            <option value="drafting">Drafting</option>
            <option value="review">Review</option>
            <option value="submission">Submission</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[11px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
            Priority
          </span>
          <select
            name="priority"
            defaultValue="medium"
            className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-sm"
          >
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="urgent">Urgent</option>
          </select>
        </label>
        <button
          type="submit"
          className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-3 py-1.5 text-sm font-medium text-[color:var(--color-background)]"
        >
          + Add
        </button>
      </form>

      {tasks.length === 0 ? (
        <p className="p-6 text-center text-sm text-[color:var(--color-muted-foreground)]">
          No tasks yet — add the first one above.
        </p>
      ) : (
        <ul className="divide-y divide-[color:var(--color-border)]">
          {open.map((t) => (
            <Row key={t.id} task={t} pursuitId={pursuitId} />
          ))}
          {done.length > 0 && (
            <li className="bg-[color:var(--color-muted)]/20 px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
              Completed ({done.length})
            </li>
          )}
          {done.map((t) => (
            <Row key={t.id} task={t} pursuitId={pursuitId} completed />
          ))}
        </ul>
      )}
    </div>
  );
}

function Row({
  task,
  pursuitId,
  completed = false,
}: {
  task: TaskRow;
  pursuitId: string;
  completed?: boolean;
}) {
  return (
    <li className={`flex items-start gap-3 p-3 ${completed ? 'opacity-60' : ''}`}>
      <form action={toggleTaskAction} className="mt-0.5 shrink-0">
        <input type="hidden" name="taskId" value={task.id} />
        <input type="hidden" name="pursuitId" value={pursuitId} />
        <button
          type="submit"
          className={`flex h-4 w-4 items-center justify-center rounded border text-[10px] ${
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
        <p className={`text-sm ${completed ? 'line-through' : 'font-medium'}`}>{task.title}</p>
        <p className="mt-0.5 text-[11px] text-[color:var(--color-muted-foreground)]">
          {task.dueDate && <>Due {task.dueDate}</>}
          {task.category && <> · {task.category}</>}
          {task.priority && <> · {task.priority}</>}
          {(task.assignedUserFirstName || task.assignedUserLastName) && (
            <>
              {' · '}
              {[task.assignedUserFirstName, task.assignedUserLastName].filter(Boolean).join(' ')}
            </>
          )}
        </p>
      </div>
    </li>
  );
}
