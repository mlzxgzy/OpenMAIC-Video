/**
 * GET /api/curriculum/coverage?seriesId=... — knowledge-point coverage report
 * for one owner, optionally limited to one curriculum series.
 *
 * The report is derived from the same persisted snapshot the ledger returns,
 * so the client and future program-matrix tools share one definition.
 */
import type { NextRequest } from 'next/server';

import type { Queryable } from '@openmaic/storage/document/pg';

import { isServerPersistenceConfigured } from '@/lib/config/feature-flags';
import { buildCurriculumCoverage } from '@/lib/curriculum/coverage';
import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { curriculumJsonError } from '@/lib/server/curriculum/http';
import { getCurriculumProvider, listCurriculum } from '@/lib/server/curriculum/store';
import { withRequestOwner } from '@/lib/server/identity/with-owner';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  if (!isServerPersistenceConfigured()) return new Response('未找到', { status: 404 });

  const rawSeriesId = req.nextUrl.searchParams.get('seriesId');
  const seriesId = rawSeriesId?.trim() || null;

  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    try {
      const { pool } = await getCurriculumProvider();
      const snapshot = await listCurriculum(pool as unknown as Queryable, ownerId);
      const report = buildCurriculumCoverage({
        courses: snapshot.courses,
        knowledgePoints: snapshot.knowledgePoints,
        courseKnowledgePoints: snapshot.courseKnowledgePoints,
        seriesId,
      });
      return ownerJson({ report }, 200, responseHeaders);
    } catch (error) {
      console.error(`[Curriculum] Failed to build coverage [owner=${ownerId}]:`, error);
      return curriculumJsonError(
        500,
        'CURRICULUM_COVERAGE_FAILED',
        '生成课程覆盖报告失败',
        responseHeaders,
      );
    }
  });
}
