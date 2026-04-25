import {
  SkeletonBlock,
  SkeletonCard,
  SkeletonLine,
} from '../../../../components/skeletons/PageSkeleton';

/**
 * Pursuit detail uses a 3-column layout (left mini-nav, main content,
 * right rail). The skeleton mirrors the shape so the layout doesn't
 * pop when content arrives.
 */
export default function PursuitDetailLoading() {
  return (
    <div className="mx-auto max-w-7xl px-6 py-6" aria-busy>
      <SkeletonLine width="w-1/2" height="h-3" />
      <SkeletonLine width="w-2/3" height="h-7" />
      <SkeletonBlock className="mt-4 h-24" />

      <div className="mt-6 grid gap-6 md:grid-cols-[13rem_1fr_16rem]">
        <SkeletonBlock className="h-72" />
        <div className="space-y-4">
          <SkeletonCard rows={5} />
          <SkeletonCard rows={3} />
        </div>
        <SkeletonBlock className="h-72" />
      </div>
    </div>
  );
}
