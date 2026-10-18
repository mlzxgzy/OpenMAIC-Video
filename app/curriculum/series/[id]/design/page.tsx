import { SeriesDesignWorkspace } from '@/components/curriculum/series-design-workspace';

export const dynamic = 'force-dynamic';

export default async function CurriculumSeriesDesignPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <SeriesDesignWorkspace seriesId={id} />;
}
