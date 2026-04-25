import {
  SkeletonBlock,
  SkeletonCard,
  SkeletonLine,
} from '../../../components/skeletons/PageSkeleton';

/**
 * Proposal detail is the longest server-side fetch in the app
 * (semantic library retrieval + comments + relevant past performance
 * + mention hints). Skeleton mirrors the wide single-column layout.
 */
export default function ProposalLoading() {
  return (
    <div className="mx-auto max-w-6xl px-6 py-6" aria-busy>
      <SkeletonLine width="w-1/3" height="h-3" />
      <SkeletonLine width="w-2/3" height="h-7" />
      <SkeletonBlock className="mt-6 h-32" />
      <div className="mt-6 grid gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonBlock key={i} className="h-20" />
        ))}
      </div>
      <SkeletonCard className="mt-6" rows={6} />
      <SkeletonCard className="mt-4" rows={6} />
    </div>
  );
}
