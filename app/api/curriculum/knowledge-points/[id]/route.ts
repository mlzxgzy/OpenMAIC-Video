/**
 * PATCH /api/curriculum/knowledge-points/[id] — update one owned knowledge point.
 * DELETE /api/curriculum/knowledge-points/[id] — delete one owned knowledge point.
 *
 * Deleting a point cascades its course links and clears child parents.
 */
import type { NextRequest } from 'next/server';

import { isServerPersistenceConfigured } from '@/lib/config/feature-flags';
import { fenceOwnerWrite, ownerWriteErrorResponse } from '@/lib/persistence/owner-merges';
import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { curriculumJsonError, mapCurriculumError } from '@/lib/server/curriculum/http';
import {
  deleteKnowledgePoint,
  getCurriculumProvider,
  updateKnowledgePoint,
  type KnowledgePointInput,
} from '@/lib/server/curriculum/store';
import { parseKnowledgePointInput } from '@/lib/server/curriculum/validation';
import { withRequestOwner } from '@/lib/server/identity/with-owner';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, { params }: Params) {
  if (!isServerPersistenceConfigured()) return new Response('Not found', { status: 404 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return curriculumJsonError(400, 'CURRICULUM_INVALID', '请求体必须是 JSON');
  }
  const parsed = parseKnowledgePointInput(body, { requireName: false });
  if (!parsed.ok) return curriculumJsonError(400, 'CURRICULUM_INVALID', parsed.message);

  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    const { id } = await params;
    try {
      const { withTransaction } = await getCurriculumProvider();
      const knowledgePoint = await withTransaction(async (tx) => {
        await fenceOwnerWrite(tx, ownerId);
        return updateKnowledgePoint(tx, ownerId, id, parsed.value as Partial<KnowledgePointInput>);
      });
      return ownerJson({ knowledgePoint }, 200, responseHeaders);
    } catch (error) {
      const claimed = ownerWriteErrorResponse(error, responseHeaders);
      if (claimed) return claimed;
      const known = mapCurriculumError(error, responseHeaders);
      if (known) return known;
      console.error(
        `[Curriculum] Failed to update knowledge point [owner=${ownerId}, id=${id}]:`,
        error,
      );
      return curriculumJsonError(
        500,
        'CURRICULUM_KNOWLEDGE_POINT_FAILED',
        '更新知识点失败',
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
        return deleteKnowledgePoint(tx, ownerId, id);
      });
      return ownerJson({ ok: true }, 200, responseHeaders);
    } catch (error) {
      const claimed = ownerWriteErrorResponse(error, responseHeaders);
      if (claimed) return claimed;
      const known = mapCurriculumError(error, responseHeaders);
      if (known) return known;
      console.error(
        `[Curriculum] Failed to delete knowledge point [owner=${ownerId}, id=${id}]:`,
        error,
      );
      return curriculumJsonError(
        500,
        'CURRICULUM_KNOWLEDGE_POINT_FAILED',
        '删除知识点失败',
        responseHeaders,
      );
    }
  });
}
