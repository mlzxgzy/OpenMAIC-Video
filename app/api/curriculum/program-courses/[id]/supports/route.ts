/**
 * PUT /api/curriculum/program-courses/[id]/supports — replace the graduation
 * indicator support matrix of one planned course.
 * Body: { supports: [{ indicatorId, weight, note? }] }
 */
import type { NextRequest } from 'next/server';

import { isServerPersistenceConfigured } from '@/lib/config/feature-flags';
import { fenceOwnerWrite, ownerWriteErrorResponse } from '@/lib/persistence/owner-merges';
import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { curriculumJsonError, mapCurriculumError } from '@/lib/server/curriculum/http';
import {
  getCurriculumProvider,
  setCourseIndicatorSupports,
  type CourseIndicatorSupportInput,
} from '@/lib/server/curriculum/store';
import { parseCourseIndicatorSupportsInput } from '@/lib/server/curriculum/validation';
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
  const parsed = parseCourseIndicatorSupportsInput(body);
  if (!parsed.ok) return curriculumJsonError(400, 'CURRICULUM_INVALID', parsed.message);
  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    const { id } = await params;
    try {
      const { withTransaction } = await getCurriculumProvider();
      const supports = await withTransaction(async (tx) => {
        await fenceOwnerWrite(tx, ownerId);
        return setCourseIndicatorSupports(
          tx,
          ownerId,
          id,
          parsed.value.supports as CourseIndicatorSupportInput[],
        );
      });
      return ownerJson({ supports }, 200, responseHeaders);
    } catch (error) {
      const claimed = ownerWriteErrorResponse(error, responseHeaders);
      if (claimed) return claimed;
      const known = mapCurriculumError(error, responseHeaders);
      if (known) return known;
      console.error(`[CurriculumSupport] Failed to update [owner=${ownerId}, id=${id}]:`, error);
      return curriculumJsonError(
        500,
        'CURRICULUM_SUPPORT_FAILED',
        '更新指标点支撑矩阵失败',
        responseHeaders,
      );
    }
  });
}
