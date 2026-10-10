/**
 * GET /api/curriculum — one owner's course ledger: series, courses and
 * relations. The route is gated on server persistence, owner-scoped through
 * `withRequestOwner`, and never accepts an owner id from the request.
 */
import type { NextRequest } from 'next/server';

import type { Queryable } from '@openmaic/storage/document/pg';

import { isServerPersistenceConfigured } from '@/lib/config/feature-flags';
import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { curriculumJsonError } from '@/lib/server/curriculum/http';
import { getCurriculumProvider, listCurriculum } from '@/lib/server/curriculum/store';
import { withRequestOwner } from '@/lib/server/identity/with-owner';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  if (!isServerPersistenceConfigured()) return new Response('未找到', { status: 404 });

  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    try {
      const { pool } = await getCurriculumProvider();
      const snapshot = await listCurriculum(pool as unknown as Queryable, ownerId);
      return ownerJson(snapshot as unknown as Record<string, unknown>, 200, responseHeaders);
    } catch (error) {
      console.error(`[Curriculum] Failed to list [owner=${ownerId}]:`, error);
      return curriculumJsonError(
        500,
        'CURRICULUM_LIST_FAILED',
        '加载课程台账失败',
        responseHeaders,
      );
    }
  });
}
