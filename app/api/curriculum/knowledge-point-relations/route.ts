/**
 * POST /api/curriculum/knowledge-point-relations — create or update one
 * direction-aware relation between two owned knowledge points.
 * Body: { sourceKnowledgePointId, targetKnowledgePointId, relationType, note? }
 */
import type { NextRequest } from 'next/server';

import { isServerPersistenceConfigured } from '@/lib/config/feature-flags';
import { fenceOwnerWrite, ownerWriteErrorResponse } from '@/lib/persistence/owner-merges';
import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { curriculumJsonError, mapCurriculumError } from '@/lib/server/curriculum/http';
import {
  createKnowledgePointRelation,
  getCurriculumProvider,
  type KnowledgePointRelationInput,
} from '@/lib/server/curriculum/store';
import { parseKnowledgePointRelationInput } from '@/lib/server/curriculum/validation';
import { withRequestOwner } from '@/lib/server/identity/with-owner';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  if (!isServerPersistenceConfigured()) return new Response('Not found', { status: 404 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return curriculumJsonError(400, 'CURRICULUM_INVALID', 'request body must be JSON');
  }
  const parsed = parseKnowledgePointRelationInput(body);
  if (!parsed.ok) return curriculumJsonError(400, 'CURRICULUM_INVALID', parsed.message);

  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    try {
      const { withTransaction } = await getCurriculumProvider();
      const relation = await withTransaction(async (tx) => {
        await fenceOwnerWrite(tx, ownerId);
        return createKnowledgePointRelation(
          tx,
          ownerId,
          parsed.value as KnowledgePointRelationInput,
        );
      });
      return ownerJson({ relation }, 201, responseHeaders);
    } catch (error) {
      const claimed = ownerWriteErrorResponse(error, responseHeaders);
      if (claimed) return claimed;
      const known = mapCurriculumError(error, responseHeaders);
      if (known) return known;
      console.error(
        `[Curriculum] Failed to create knowledge point relation [owner=${ownerId}]:`,
        error,
      );
      return curriculumJsonError(
        500,
        'CURRICULUM_KNOWLEDGE_POINT_RELATION_FAILED',
        'Failed to create the knowledge point relation',
        responseHeaders,
      );
    }
  });
}
