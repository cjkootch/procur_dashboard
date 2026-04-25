import {
  SkeletonBlock,
  SkeletonCard,
  SkeletonLine,
} from '../../../../components/skeletons/PageSkeleton';

export default function ShredLoading() {
  return (
    <div className="mx-auto max-w-7xl px-6 py-6" aria-busy>
      <SkeletonLine width="w-1/3" height="h-3" />
      <SkeletonLine width="w-1/4" height="h-6" />
      <div className="mt-5 grid gap-3 sm:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <SkeletonBlock key={i} className="h-20" />
        ))}
      </div>
      <div className="mt-5 grid gap-5 lg:grid-cols-[1fr_18rem]">
        <div className="space-y-4">
          <SkeletonCard rows={5} />
          <SkeletonCard rows={6} />
          <SkeletonCard rows={6} />
        </div>
        <SkeletonBlock className="h-64" />
      </div>
    </div>
  );
}
