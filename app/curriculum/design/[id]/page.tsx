import { DesignHeatmap } from '@/components/curriculum/design-heatmap';

export const dynamic = 'force-dynamic';

/**
 * The outcome × item matrix for one course design task.
 *
 * `[id]` is a **design task** id, not a course or series id: the matrix is a
 * property of the design, and a series can hold several designs.
 */
export default async function CurriculumDesignMatrixPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <DesignHeatmap taskId={id} />;
}
