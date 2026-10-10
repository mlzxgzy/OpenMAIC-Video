/**
 * PATCH /api/curriculum/program-versions/[id] — update one owned version.
 * DELETE /api/curriculum/program-versions/[id] — delete one owned version.
 */
import type { NextRequest } from 'next/server';

import { isServerPersistenceConfigured } from '@/lib/config/feature-flags';
import { fenceOwnerWrite, ownerWriteErrorResponse } from '@/lib/persistence/owner-merges';
import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { curriculumJsonError, mapCurriculumError } from '@/lib/server/curriculum/http';
import {
  deleteCurriculumProgramVersion,
  getCurriculumProvider,
  updateCurriculumProgramVersion,
  type CurriculumProgramVersionPatch,
} from '@/lib/server/curriculum/store';
import { parseProgramVersionInput } from '@/lib/server/curriculum/validation';
import { withRequestOwner } from '@/lib/server/identity/with-owner';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, { params }: Params) {
  if (!isServerPersistenceConfigured()) return new Response('未找到', { status: 404 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return curriculumJsonError(400, 'CURRICULUM_INVALID', '请求体必须是 JSON');
  }
  const parsed = parseProgramVersionInput(body, { requireProgramId: false, requireName: false });
  if (!parsed.ok) return curriculumJsonError(400, 'CURRICULUM_INVALID', parsed.message);
  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    const { id } = await params;
    try {
      const { withTransaction } = await getCurriculumProvider();
      const programVersion = await withTransaction(async (tx) => {
        await fenceOwnerWrite(tx, ownerId);
        return updateCurriculumProgramVersion(
          tx,
          ownerId,
          id,
          parsed.value as CurriculumProgramVersionPatch,
        );
      });
      return ownerJson({ programVersion }, 200, responseHeaders);
    } catch (error) {
      const claimed = ownerWriteErrorResponse(error, responseHeaders);
      if (claimed) return claimed;
      const known = mapCurriculumError(error, responseHeaders);
      if (known) return known;
      console.error(
        `[CurriculumProgramVersion] Failed to update [owner=${ownerId}, id=${id}]:`,
        error,
      );
      return curriculumJsonError(
        500,
        'CURRICULUM_PROGRAM_VERSION_FAILED',
        '更新培养方案版本失败',
        responseHeaders,
      );
    }
  });
}

export async function DELETE(req: NextRequest, { params }: Params) {
  if (!isServerPersistenceConfigured()) return new Response('未找到', { status: 404 });
  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    const { id } = await params;
    try {
      const { withTransaction } = await getCurriculumProvider();
      await withTransaction(async (tx) => {
        await fenceOwnerWrite(tx, ownerId);
        return deleteCurriculumProgramVersion(tx, ownerId, id);
      });
      return ownerJson({ ok: true }, 200, responseHeaders);
    } catch (error) {
      const claimed = ownerWriteErrorResponse(error, responseHeaders);
      if (claimed) return claimed;
      const known = mapCurriculumError(error, responseHeaders);
      if (known) return known;
      console.error(
        `[CurriculumProgramVersion] Failed to delete [owner=${ownerId}, id=${id}]:`,
        error,
      );
      return curriculumJsonError(
        500,
        'CURRICULUM_PROGRAM_VERSION_FAILED',
        '删除培养方案版本失败',
        responseHeaders,
      );
    }
  });
}
