import { CourseWorkspace } from '@/components/curriculum/course-workspace';

export const dynamic = 'force-dynamic';

export default async function CurriculumCoursePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <CourseWorkspace courseId={id} />;
}
