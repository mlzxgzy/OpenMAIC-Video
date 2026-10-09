/**
 * POST /api/curriculum/program-versions/sync
 *
 * Mirrors one owned program version's content into another. The target keeps
 * its own version metadata (name, version number, grade year, status and target
 * credits) while its indicators, planned courses and support matrix are
 * replaced by the source plan. The whole operation runs in one owner-fenced
 * transaction and reuses the same import writer as JSON replace.
 */
import type { NextRequest } from 'next/server';

import type { Queryable } from '@openmaic/storage/document/pg';

import { buildProgramPlanExport } from '@/lib/curriculum/program-io';
import { isServerPersistenceConfigured } from '@/lib/config/feature-flags';
import { fenceOwnerWrite, ownerWriteErrorResponse } from '@/lib/persistence/owner-merges';
import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { curriculumJsonError, mapCurriculumError } from '@/lib/server/curriculum/http';
import {
  CurriculumNotFoundError,
  getCurriculumProvider,
  importCurriculumProgramPlan,
  listCurriculum,
} from '@/lib/server/curriculum/store';
import { parseProgramVersionSyncInput } from '@/lib/server/curriculum/validation';
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
  const parsed = parseProgramVersionSyncInput(body);
  if (!parsed.ok) return curriculumJsonError(400, 'CURRICULUM_INVALID', parsed.message);

  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    try {
      const { withTransaction } = await getCurriculumProvider();
      const result = await withTransaction(async (tx) => {
        await fenceOwnerWrite(tx, ownerId);
        const snapshot = await listCurriculum(tx as unknown as Queryable, ownerId);
        const document = buildProgramPlanExport(snapshot, parsed.value.sourceVersionId);
        if (!document) {
          throw new CurriculumNotFoundError('源培养方案版本不存在');
        }
        return importCurriculumProgramPlan(tx as unknown as Queryable, ownerId, {
          mode: 'replace',
          document,
          programVersionId: parsed.value.targetVersionId,
          preserveVersionMetadata: true,
        });
      });
      return ownerJson({ result }, 200, responseHeaders);
    } catch (error) {
      const claimed = ownerWriteErrorResponse(error, responseHeaders);
      if (claimed) return claimed;
      const known = mapCurriculumError(error, responseHeaders);
      if (known) return known;
      console.error(`[CurriculumProgramSync] Failed [owner=${ownerId}]:`, error);
      return curriculumJsonError(
        500,
        'CURRICULUM_PROGRAM_SYNC_FAILED',
        '同步培养方案版本失败',
        responseHeaders,
      );
    }
  });
}
