/**
 * POST /api/curriculum/generation-jobs — one-click course generation.
 *
 * Builds the course assembly server-side from the owner's curriculum, creates
 * or updates the curriculum course, starts a server-side generation run, and
 * links the run to a durable curriculum job. The registered generation hooks
 * then write the produced `stage_id` back onto the course as the run commits.
 *
 * Body: { assembly: CourseAssemblyInput, courseId?, outlineReview?,
 *         interactive?, taskEngine?, voice? }
 */
import type { NextRequest } from 'next/server';
import type { Queryable } from '@openmaic/storage/document/pg';

import { isServerPersistenceConfigured } from '@/lib/config/feature-flags';
import { buildCourseAssembly } from '@/lib/curriculum/assembly';
import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { curriculumJsonError, mapCurriculumError } from '@/lib/server/curriculum/http';
import { startCurriculumGenerationJob } from '@/lib/server/curriculum/generation';
import { getCurriculumProvider, listCurriculum } from '@/lib/server/curriculum/store';
import { parseGenerationJobInput } from '@/lib/server/curriculum/validation';
import { runSnapshot } from '@/lib/server/generation/run/store';
import { startRefusal } from '@/lib/server/generation/run/start';
import { withRequestOwner } from '@/lib/server/identity/with-owner';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  if (!isServerPersistenceConfigured()) return new Response('Not found', { status: 404 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return curriculumJsonError(400, 'CURRICULUM_INVALID', '请求体必须是 JSON');
  }
  const parsed = parseGenerationJobInput(body);
  if (!parsed.ok) return curriculumJsonError(400, 'CURRICULUM_INVALID', parsed.message);

  return withRequestOwner(req, async (principal, responseHeaders) => {
    const { ownerId } = principal;
    try {
      const { pool } = await getCurriculumProvider();
      const snapshot = await listCurriculum(pool as unknown as Queryable, ownerId);
      const assembly = buildCourseAssembly(snapshot, parsed.value.assembly);
      if (assembly.knowledgePoints.length === 0) {
        return curriculumJsonError(
          400,
          'CURRICULUM_INVALID',
          '所选知识点在当前课程系列中均不可用',
          responseHeaders,
        );
      }
      const lessonOrder =
        snapshot.courses.filter((course) => course.seriesId === assembly.seriesId).length + 1;
      const started = await startCurriculumGenerationJob({
        ownerId,
        principal,
        request: req,
        assembly,
        parsed: parsed.value,
        lessonOrder,
      });
      return ownerJson(
        {
          job: started.job,
          run: runSnapshot(started.run),
          courseId: started.courseId,
          createdCourse: started.createdCourse,
        },
        202,
        responseHeaders,
      );
    } catch (error) {
      const refusal = startRefusal(error);
      if (refusal) {
        return curriculumJsonError(refusal.status, refusal.code, refusal.message, responseHeaders);
      }
      const known = mapCurriculumError(error, responseHeaders);
      if (known) return known;
      console.error(`[Curriculum] Failed to start generation [owner=${ownerId}]:`, error);
      return curriculumJsonError(
        500,
        'CURRICULUM_GENERATION_FAILED',
        '启动课程生成失败',
        responseHeaders,
      );
    }
  });
}
