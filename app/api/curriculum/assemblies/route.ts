/**
 * POST /api/curriculum/assemblies — build a deterministic course-assembly
 * plan from one owner's curriculum snapshot.
 *
 * The route is a preview/authoring endpoint: it does not write to the
 * database. The returned `coursePackage` is compatible with
 * `scripts/start-lesson-generation.mjs`, and the UI can also use the same
 * plan to create a draft `curriculum_course` through the existing ledger API.
 */
import type { NextRequest } from 'next/server';

import type { Queryable } from '@openmaic/storage/document/pg';

import { isServerPersistenceConfigured } from '@/lib/config/feature-flags';
import { buildCourseAssembly } from '@/lib/curriculum/assembly';
import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { curriculumJsonError } from '@/lib/server/curriculum/http';
import { getCurriculumProvider, listCurriculum } from '@/lib/server/curriculum/store';
import { parseCourseAssemblyInput } from '@/lib/server/curriculum/validation';
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
  const parsed = parseCourseAssemblyInput(body);
  if (!parsed.ok) return curriculumJsonError(400, 'CURRICULUM_INVALID', parsed.message);

  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    try {
      const { pool } = await getCurriculumProvider();
      const snapshot = await listCurriculum(pool as unknown as Queryable, ownerId);
      const assembly = buildCourseAssembly(snapshot, parsed.value);
      if (assembly.knowledgePoints.length === 0) {
        return curriculumJsonError(
          400,
          'CURRICULUM_INVALID',
          '所选知识点在当前课程系列中均不可用',
          responseHeaders,
        );
      }
      return ownerJson({ assembly }, 200, responseHeaders);
    } catch (error) {
      console.error(`[Curriculum] Failed to assemble course [owner=${ownerId}]:`, error);
      return curriculumJsonError(
        500,
        'CURRICULUM_ASSEMBLY_FAILED',
        '生成课程组装方案失败',
        responseHeaders,
      );
    }
  });
}
