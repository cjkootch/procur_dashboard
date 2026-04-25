import { SkeletonBlock, SkeletonLine } from '../../../components/skeletons/PageSkeleton';

/** Pipeline kanban skeleton — header bar + 7 narrow column stubs. */
export default function PipelineLoading() {
  return (
    <div className="flex h-full flex-col" aria-busy>
      <header className="flex items-start justify-between border-b border-[color:var(--color-border)] bg-[color:var(--color-background)] px-6 py-4">
        <SkeletonLine width="w-32" height="h-5" />
        <SkeletonLine width="w-20" height="h-5" />
      </header>
      <div className="flex-1 overflow-x-auto">
        <div className="flex min-h-full gap-3 p-4">
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="w-72 shrink-0 space-y-2">
              <SkeletonLine width="w-1/2" height="h-4" />
              <SkeletonBlock className="h-24" />
              <SkeletonBlock className="h-24" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
