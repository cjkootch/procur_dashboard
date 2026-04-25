import {
  SkeletonBlock,
  SkeletonCard,
  SkeletonLine,
  SkeletonTable,
} from '../../../components/skeletons/PageSkeleton';

/**
 * Contract detail kicks off 4 parallel queries (mods + clins + task
 * areas + past-performance lookup). Skeleton mirrors the tab-nav +
 * stat-strip + content-table shape.
 */
export default function ContractDetailLoading() {
  return (
    <div className="mx-auto max-w-5xl px-6 py-6" aria-busy>
      <SkeletonLine width="w-1/4" height="h-3" />
      <SkeletonLine width="w-2/3" height="h-7" />
      <SkeletonBlock className="mt-4 h-12" />
      {/* Tab nav skeleton */}
      <div className="mt-4 flex gap-3 border-b border-[color:var(--color-border)] py-2">
        {Array.from({ length: 7 }).map((_, i) => (
          <SkeletonLine key={i} width="w-20" height="h-3" />
        ))}
      </div>
      <SkeletonCard className="mt-4" rows={3} />
      <SkeletonTable className="mt-4" rows={6} cols={5} />
    </div>
  );
}
