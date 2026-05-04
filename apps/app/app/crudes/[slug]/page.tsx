import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getCrudeGradeDetail } from '@procur/catalog';
import { CrudeGradeCard } from '../../../components/assistant/CrudeGradeCard';

/**
 * Crude grade detail page — visualizes the curated `crude_grades`
 * row plus all linked producer assays (BP / Equinor / ExxonMobil /
 * TotalEnergies) plus the refineries whose slate accepts this grade.
 *
 * Server component. The `<CrudeGradeCard>` renderer is shared with
 * the chat assistant's `view_crude_grade_detail` tool result so the
 * same visualization works in both surfaces.
 */
export const dynamic = 'force-dynamic';

interface Props {
  params: Promise<{ slug: string }>;
}

export default async function CrudeGradeDetailPage({ params }: Props) {
  const { slug } = await params;
  const detail = await getCrudeGradeDetail(decodeURIComponent(slug));
  if (!detail) notFound();

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-4 px-4 py-6">
      <nav className="text-xs text-[color:var(--color-muted-foreground)]">
        <Link href="/crudes" className="hover:underline">
          Crudes
        </Link>
        <span className="mx-1.5">/</span>
        <span>{detail.grade.name}</span>
      </nav>
      <CrudeGradeCard output={detail} />
    </main>
  );
}
