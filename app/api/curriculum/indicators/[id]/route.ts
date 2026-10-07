/**
 * PATCH /api/curriculum/indicators/[id] — update one owned indicator.
 * DELETE /api/curriculum/indicators/[id] — delete one owned indicator.
 */
import type { NextRequest } from 'next/server';

import { isServerPersistenceConfigured } from '@/lib/config/feature-flags';
import { fenceOwnerWrite, ownerWriteErrorResponse } from '@/lib/persistence/owner-merges';
import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { curriculumJsonError, mapCurriculumError } from '@/lib/server/curriculum/http';
import {
  deleteGraduationIndicator,
  getCurriculumProvider,
  updateGraduationIndicator,
  type CurriculumGraduationIndicatorPatch,
} from '@/lib/server/curriculum/store';
import { parseGraduationIndicatorInput } from '@/lib/server/curriculum/validation';
import { withRequestOwner } from '@/lib/server/identity/with-owner';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, { params }: Params) {
  if (!isServerPersistenceConfigured()) return new Response('Not found', { status: 404 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return curriculumJsonError(400, 'CURRICULUM_INVALID', 'request body must be JSON');
  }
  const parsed = parseGraduationIndicatorInput(body, {
    requireProgramVersionId: false,
    requireCode: false,
    requireTitle: false,
  });
  if (!parsed.ok) return curriculumJsonError(400, 'CURRICULUM_INVALID', parsed.message);
  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    const { id } = await params;
    try {
      const { withTransaction } = await getCurriculumProvider();
      const indicator = await withTransaction(async (tx) => {
        await fenceOwnerWrite(tx, ownerId);
        return updateGraduationIndicator(
          tx,
          ownerId,
          id,
          parsed.value as CurriculumGraduationIndicatorPatch,
        );
      });
      return ownerJson({ indicator }, 200, responseHeaders);
    } catch (error) {
      const claimed = ownerWriteErrorResponse(error, responseHeaders);
      if (claimed) return claimed;
      const known = mapCurriculumError(error, responseHeaders);
      if (known) return known;
      console.error(`[CurriculumIndicator] Failed to update [owner=${ownerId}, id=${id}]:`, error);
      return curriculumJsonError(
        500,
        'CURRICULUM_INDICATOR_FAILED',
        'Failed to update the graduation indicator',
        responseHeaders,
      );
    }
  });
}

export async function DELETE(req: NextRequest, { params }: Params) {
  if (!isServerPersistenceConfigured()) return new Response('Not found', { status: 404 });
  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    const { id } = await params;
    try {
      const { withTransaction } = await getCurriculumProvider();
      await withTransaction(async (tx) => {
        await fenceOwnerWrite(tx, ownerId);
        return deleteGraduationIndicator(tx, ownerId, id);
      });
      return ownerJson({ ok: true }, 200, responseHeaders);
    } catch (error) {
      const claimed = ownerWriteErrorResponse(error, responseHeaders);
      if (claimed) return claimed;
      const known = mapCurriculumError(error, responseHeaders);
      if (known) return known;
      console.error(`[CurriculumIndicator] Failed to delete [owner=${ownerId}, id=${id}]:`, error);
      return curriculumJsonError(
        500,
        'CURRICULUM_INDICATOR_FAILED',
        'Failed to delete the graduation indicator',
        responseHeaders,
      );
    }
  });
}
