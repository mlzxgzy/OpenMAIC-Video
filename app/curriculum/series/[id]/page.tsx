import { CurriculumWorkspace } from '@/components/curriculum/curriculum-workspace';

export const dynamic = 'force-dynamic';

export default async function CurriculumSeriesDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <CurriculumWorkspace seriesId={id} />;
}
