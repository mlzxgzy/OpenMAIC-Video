import { DesignTaskShell } from '@/components/curriculum/design-task-shell';

export const dynamic = 'force-dynamic';

/**
 * The design screen for one course: the outcome × item matrix and the editor.
 *
 * `[id]` is a **design task** id, not a course or series id: both the matrix and
 * the authoring gates are properties of the design, and a series can hold several
 * designs.
 *
 * The page is a shell because the two halves share one read. The matrix owns the
 * phase and passes it down, so a phase advance re-gates the editor immediately
 * rather than leaving it briefly able to author rows the course has not reached.
 */
export default async function CurriculumDesignMatrixPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <DesignTaskShell taskId={id} />;
}
