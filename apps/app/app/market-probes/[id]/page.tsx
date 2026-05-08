import { redirect } from 'next/navigation';

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function ProbeRootPage({ params }: PageProps) {
  const { id } = await params;
  redirect(`/market-probes/${id}/overview`);
}
