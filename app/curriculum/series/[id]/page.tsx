import { SeriesCockpit } from '@/components/curriculum/series-cockpit';

export const dynamic = 'force-dynamic';

export default async function CurriculumSeriesDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <SeriesCockpit seriesId={id} />;
}
