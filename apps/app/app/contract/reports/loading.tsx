import {
  SkeletonBlock,
  SkeletonLine,
} from '../../../components/skeletons/PageSkeleton';

export default function ReportsLoading() {
  return (
    <div className="mx-auto max-w-7xl px-6 py-6" aria-busy>
      <SkeletonLine width="w-1/4" height="h-3" />
      <SkeletonLine width="w-1/3" height="h-6" />
      <SkeletonBlock className="mt-4 h-24" />
      <SkeletonBlock className="mt-3 h-16" />
      <div className="mt-5 grid gap-5 lg:grid-cols-[1fr_24rem]">
        <SkeletonBlock className="h-96" />
        <SkeletonBlock className="h-96" />
      </div>
    </div>
  );
}
