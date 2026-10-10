/**
 * POST /api/curriculum/programs — create or reuse one training program.
 */
import type { NextRequest } from 'next/server';

import { isServerPersistenceConfigured } from '@/lib/config/feature-flags';
import { fenceOwnerWrite, ownerWriteErrorResponse } from '@/lib/persistence/owner-merges';
import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { curriculumJsonError, mapCurriculumError } from '@/lib/server/curriculum/http';
import {
  createCurriculumProgram,
  getCurriculumProvider,
  type CurriculumProgramInput,
} from '@/lib/server/curriculum/store';
import { parseProgramInput } from '@/lib/server/curriculum/validation';
import { withRequestOwner } from '@/lib/server/identity/with-owner';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  if (!isServerPersistenceConfigured()) return new Response('未找到', { status: 404 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return curriculumJsonError(400, 'CURRICULUM_INVALID', '请求体必须是 JSON');
  }
  const parsed = parseProgramInput(body, { requireName: true });
  if (!parsed.ok) return curriculumJsonError(400, 'CURRICULUM_INVALID', parsed.message);

  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    try {
      const { withTransaction } = await getCurriculumProvider();
      const program = await withTransaction(async (tx) => {
        await fenceOwnerWrite(tx, ownerId);
        return createCurriculumProgram(tx, ownerId, parsed.value as CurriculumProgramInput);
      });
      return ownerJson({ program }, 201, responseHeaders);
    } catch (error) {
      const claimed = ownerWriteErrorResponse(error, responseHeaders);
      if (claimed) return claimed;
      const known = mapCurriculumError(error, responseHeaders);
      if (known) return known;
      console.error(`[CurriculumProgram] Failed to create [owner=${ownerId}]:`, error);
      return curriculumJsonError(
        500,
        'CURRICULUM_PROGRAM_FAILED',
        '创建培养方案失败',
        responseHeaders,
      );
    }
  });
}
