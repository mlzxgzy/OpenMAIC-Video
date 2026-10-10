/**
 * POST /api/curriculum/knowledge-points — create one knowledge point.
 * Body: { name, seriesId?, parentId?, code?, type?, difficulty?, summary?, sortOrder? }
 */
import type { NextRequest } from 'next/server';

import { isServerPersistenceConfigured } from '@/lib/config/feature-flags';
import { fenceOwnerWrite, ownerWriteErrorResponse } from '@/lib/persistence/owner-merges';
import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { curriculumJsonError, mapCurriculumError } from '@/lib/server/curriculum/http';
import {
  createKnowledgePoint,
  getCurriculumProvider,
  type KnowledgePointInput,
} from '@/lib/server/curriculum/store';
import { parseKnowledgePointInput } from '@/lib/server/curriculum/validation';
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
  const parsed = parseKnowledgePointInput(body, { requireName: true });
  if (!parsed.ok) return curriculumJsonError(400, 'CURRICULUM_INVALID', parsed.message);

  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    try {
      const { withTransaction } = await getCurriculumProvider();
      const knowledgePoint = await withTransaction(async (tx) => {
        await fenceOwnerWrite(tx, ownerId);
        return createKnowledgePoint(tx, ownerId, parsed.value as KnowledgePointInput);
      });
      return ownerJson({ knowledgePoint }, 201, responseHeaders);
    } catch (error) {
      const claimed = ownerWriteErrorResponse(error, responseHeaders);
      if (claimed) return claimed;
      const known = mapCurriculumError(error, responseHeaders);
      if (known) return known;
      console.error(`[Curriculum] Failed to create knowledge point [owner=${ownerId}]:`, error);
      return curriculumJsonError(
        500,
        'CURRICULUM_KNOWLEDGE_POINT_FAILED',
        '创建知识点失败',
        responseHeaders,
      );
    }
  });
}
