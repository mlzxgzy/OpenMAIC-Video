import { DesignTaskList } from '@/components/curriculum/design-task-list';

export const dynamic = 'force-dynamic';

/**
 * Entry point to the design side of the curriculum workspace.
 *
 * The ledger pages (`/curriculum`, `/curriculum/series`) list courses as
 * products. This lists *designs* in progress, which is a different thing: a
 * design begins as a brief and only becomes a course once its outcome loop
 * closes. Keeping the two lists apart is the point of the refactor — a
 * half-designed course must not look like a course.
 */
export default function CurriculumDesignIndexPage() {
  return <DesignTaskList />;
}
