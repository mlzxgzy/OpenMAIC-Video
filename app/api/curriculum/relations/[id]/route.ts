/** DELETE /api/curriculum/relations/[id] — delete one owned course relation. */
import type { NextRequest } from 'next/server';

import { isServerPersistenceConfigured } from '@/lib/config/feature-flags';
import { fenceOwnerWrite, ownerWriteErrorResponse } from '@/lib/persistence/owner-merges';
import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { curriculumJsonError, mapCurriculumError } from '@/lib/server/curriculum/http';
import { deleteCurriculumRelation, getCurriculumProvider } from '@/lib/server/curriculum/store';
import { withRequestOwner } from '@/lib/server/identity/with-owner';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

export async function DELETE(req: NextRequest, { params }: Params) {
  if (!isServerPersistenceConfigured()) return new Response('Not found', { status: 404 });

  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    const { id } = await params;
    try {
      const { withTransaction } = await getCurriculumProvider();
      await withTransaction(async (tx) => {
        await fenceOwnerWrite(tx, ownerId);
        return deleteCurriculumRelation(tx, ownerId, id);
      });
      return ownerJson({ ok: true }, 200, responseHeaders);
    } catch (error) {
      const claimed = ownerWriteErrorResponse(error, responseHeaders);
      if (claimed) return claimed;
      const known = mapCurriculumError(error, responseHeaders);
      if (known) return known;
      console.error(`[Curriculum] Failed to delete relation [owner=${ownerId}, id=${id}]:`, error);
      return curriculumJsonError(
        500,
        'CURRICULUM_RELATION_FAILED',
        'Failed to delete the relation',
        responseHeaders,
      );
    }
  });
}
