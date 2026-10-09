/**
 * POST /api/curriculum/indicators — add a graduation indicator to one version.
 */
import type { NextRequest } from 'next/server';

import { isServerPersistenceConfigured } from '@/lib/config/feature-flags';
import { fenceOwnerWrite, ownerWriteErrorResponse } from '@/lib/persistence/owner-merges';
import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { curriculumJsonError, mapCurriculumError } from '@/lib/server/curriculum/http';
import {
  createGraduationIndicator,
  getCurriculumProvider,
  type CurriculumGraduationIndicatorInput,
} from '@/lib/server/curriculum/store';
import { parseGraduationIndicatorInput } from '@/lib/server/curriculum/validation';
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
  const parsed = parseGraduationIndicatorInput(body, {
    requireProgramVersionId: true,
    requireCode: true,
    requireTitle: true,
  });
  if (!parsed.ok) return curriculumJsonError(400, 'CURRICULUM_INVALID', parsed.message);
  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    try {
      const { withTransaction } = await getCurriculumProvider();
      const indicator = await withTransaction(async (tx) => {
        await fenceOwnerWrite(tx, ownerId);
        return createGraduationIndicator(
          tx,
          ownerId,
          parsed.value as CurriculumGraduationIndicatorInput,
        );
      });
      return ownerJson({ indicator }, 201, responseHeaders);
    } catch (error) {
      const claimed = ownerWriteErrorResponse(error, responseHeaders);
      if (claimed) return claimed;
      const known = mapCurriculumError(error, responseHeaders);
      if (known) return known;
      console.error(`[CurriculumIndicator] Failed to create [owner=${ownerId}]:`, error);
      return curriculumJsonError(
        500,
        'CURRICULUM_INDICATOR_FAILED',
        '创建毕业要求指标点失败',
        responseHeaders,
      );
    }
  });
}
