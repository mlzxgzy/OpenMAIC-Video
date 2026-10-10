/**
 * PUT /api/curriculum/courses/[id]/knowledge-points — replace all knowledge
 * point links of one owned course.
 * Body: { knowledgePoints: [{ knowledgePointId, coverageLevel?, sortOrder?, note? }] }
 */
import type { NextRequest } from 'next/server';

import { isServerPersistenceConfigured } from '@/lib/config/feature-flags';
import { fenceOwnerWrite, ownerWriteErrorResponse } from '@/lib/persistence/owner-merges';
import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { curriculumJsonError, mapCurriculumError } from '@/lib/server/curriculum/http';
import {
  getCurriculumProvider,
  setCourseKnowledgePoints,
  type CourseKnowledgePointInput,
} from '@/lib/server/curriculum/store';
import { parseCourseKnowledgePointsInput } from '@/lib/server/curriculum/validation';
import { withRequestOwner } from '@/lib/server/identity/with-owner';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

export async function PUT(req: NextRequest, { params }: Params) {
  if (!isServerPersistenceConfigured()) return new Response('未找到', { status: 404 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return curriculumJsonError(400, 'CURRICULUM_INVALID', '请求体必须是 JSON');
  }
  const parsed = parseCourseKnowledgePointsInput(body);
  if (!parsed.ok) return curriculumJsonError(400, 'CURRICULUM_INVALID', parsed.message);

  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    const { id } = await params;
    try {
      const { withTransaction } = await getCurriculumProvider();
      await withTransaction(async (tx) => {
        await fenceOwnerWrite(tx, ownerId);
        return setCourseKnowledgePoints(
          tx,
          ownerId,
          id,
          parsed.value as CourseKnowledgePointInput[],
        );
      });
      return ownerJson({ ok: true }, 200, responseHeaders);
    } catch (error) {
      const claimed = ownerWriteErrorResponse(error, responseHeaders);
      if (claimed) return claimed;
      const known = mapCurriculumError(error, responseHeaders);
      if (known) return known;
      console.error(
        `[Curriculum] Failed to set course knowledge points [owner=${ownerId}, course=${id}]:`,
        error,
      );
      return curriculumJsonError(
        500,
        'CURRICULUM_COURSE_KNOWLEDGE_POINTS_FAILED',
        '更新课程知识点失败',
        responseHeaders,
      );
    }
  });
}
