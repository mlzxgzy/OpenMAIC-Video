/**
 * POST /api/curriculum/program-versions/import — create a new version from a
 * program-plan JSON document, or replace one existing version atomically.
 */
import type { NextRequest } from 'next/server';

import { isServerPersistenceConfigured } from '@/lib/config/feature-flags';
import { fenceOwnerWrite, ownerWriteErrorResponse } from '@/lib/persistence/owner-merges';
import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { curriculumJsonError, mapCurriculumError } from '@/lib/server/curriculum/http';
import { getCurriculumProvider, importCurriculumProgramPlan } from '@/lib/server/curriculum/store';
import { parseProgramPlanImportInput } from '@/lib/server/curriculum/validation';
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
  const parsed = parseProgramPlanImportInput(body);
  if (!parsed.ok) return curriculumJsonError(400, 'CURRICULUM_INVALID', parsed.message);

  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    try {
      const { withTransaction } = await getCurriculumProvider();
      const result = await withTransaction(async (tx) => {
        await fenceOwnerWrite(tx, ownerId);
        return importCurriculumProgramPlan(tx, ownerId, parsed.value);
      });
      return ownerJson({ result }, parsed.value.mode === 'create' ? 201 : 200, responseHeaders);
    } catch (error) {
      const claimed = ownerWriteErrorResponse(error, responseHeaders);
      if (claimed) return claimed;
      const known = mapCurriculumError(error, responseHeaders);
      if (known) return known;
      console.error(`[CurriculumProgramImport] Failed [owner=${ownerId}]:`, error);
      return curriculumJsonError(
        500,
        'CURRICULUM_PROGRAM_IMPORT_FAILED',
        '导入培养方案版本失败',
        responseHeaders,
      );
    }
  });
}
