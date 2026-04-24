import Link from 'next/link';

export type CaptureView = 'dashboard' | 'pipeline' | 'lifecycle' | 'tasks';

const VIEWS: Array<{ key: CaptureView; label: string; href: string }> = [
  { key: 'dashboard', label: 'Dashboard', href: '/capture' },
  { key: 'pipeline', label: 'Pipeline', href: '/capture/pipeline' },
  { key: 'lifecycle', label: 'Lifecycle', href: '/capture/lifecycle' },
  { key: 'tasks', label: 'Tasks', href: '/capture/tasks' },
];

/**
 * Shared view switcher used across the Capture section, mirroring the
 * GovDash Capture tabs (Dashboard / Pipeline / Tasks + our new Lifecycle
 * Gantt view). One underlined tab at a time.
 */
export function CaptureViewSwitcher({ active }: { active: CaptureView }) {
  return (
    <nav className="flex gap-4 text-xs text-[color:var(--color-muted-foreground)]">
      {VIEWS.map((v) => {
        const isActive = v.key === active;
        return (
          <Link
            key={v.key}
            href={v.href}
            className={
              isActive
                ? 'border-b-2 border-[color:var(--color-foreground)] pb-0.5 font-medium text-[color:var(--color-foreground)]'
                : 'border-b-2 border-transparent pb-0.5 hover:text-[color:var(--color-foreground)]'
            }
          >
            {v.label}
          </Link>
        );
      })}
    </nav>
  );
}
