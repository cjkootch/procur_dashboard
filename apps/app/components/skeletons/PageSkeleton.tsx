/**
 * Reusable skeleton primitives for `loading.tsx` Suspense boundaries.
 *
 * Plain server-renderable components — no animation library. Pulse via
 * Tailwind's `animate-pulse` utility on the gray block elements.
 */

export function SkeletonLine({
  width = 'w-full',
  height = 'h-3',
}: {
  width?: string;
  height?: string;
}) {
  return (
    <div
      className={`${width} ${height} animate-pulse rounded bg-[color:var(--color-muted)]/60`}
      aria-hidden
    />
  );
}

export function SkeletonBlock({
  className = '',
}: {
  className?: string;
}) {
  return (
    <div
      className={`animate-pulse rounded-[var(--radius-md)] bg-[color:var(--color-muted)]/40 ${className}`}
      aria-hidden
    />
  );
}

/** Card-shaped skeleton with a header bar + a few rows of content. */
export function SkeletonCard({
  rows = 3,
  className = '',
}: {
  rows?: number;
  className?: string;
}) {
  return (
    <div
      className={`rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-4 ${className}`}
      aria-hidden
    >
      <SkeletonLine width="w-1/3" height="h-4" />
      <div className="mt-3 space-y-2">
        {Array.from({ length: rows }).map((_, i) => (
          <SkeletonLine key={i} width={i === rows - 1 ? 'w-2/3' : 'w-full'} />
        ))}
      </div>
    </div>
  );
}

/** Table-shaped skeleton — header row + N body rows. */
export function SkeletonTable({
  rows = 5,
  cols = 4,
  className = '',
}: {
  rows?: number;
  cols?: number;
  className?: string;
}) {
  return (
    <div
      className={`overflow-hidden rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] ${className}`}
      aria-hidden
    >
      <div className="grid gap-2 border-b border-[color:var(--color-border)] px-3 py-2"
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0,1fr))` }}>
        {Array.from({ length: cols }).map((_, i) => (
          <SkeletonLine key={i} width="w-3/4" height="h-3" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div
          key={r}
          className="grid gap-2 border-t border-[color:var(--color-border)]/60 px-3 py-2"
          style={{ gridTemplateColumns: `repeat(${cols}, minmax(0,1fr))` }}
        >
          {Array.from({ length: cols }).map((_, i) => (
            <SkeletonLine key={i} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Generic page skeleton: heading + 4-stat strip + 2 content cards. */
export function PageSkeleton({ title }: { title?: string }) {
  return (
    <div className="mx-auto max-w-6xl px-6 py-10" aria-busy>
      {title ? (
        <h1 className="sr-only">{title}</h1>
      ) : (
        <SkeletonLine width="w-1/3" height="h-6" />
      )}
      <div className="mt-6 grid gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonBlock key={i} className="h-20" />
        ))}
      </div>
      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <SkeletonCard rows={4} />
        <SkeletonCard rows={4} />
      </div>
    </div>
  );
}
