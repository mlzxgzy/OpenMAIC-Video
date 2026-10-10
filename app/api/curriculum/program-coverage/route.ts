/**
 * GET /api/curriculum/program-coverage?programVersionId=... — credit,
 * indicator and knowledge-point coverage report for one program version.
 * It uses the same pure analysis function as the course workspace.
 */
import type { NextRequest } from 'next/server';

import type { Queryable } from '@openmaic/storage/document/pg';

import { isServerPersistenceConfigured } from '@/lib/config/feature-flags';
import { buildProgramCoverage } from '@/lib/curriculum/program';
import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { curriculumJsonError } from '@/lib/server/curriculum/http';
import { getCurriculumProvider, listCurriculum } from '@/lib/server/curriculum/store';
import { withRequestOwner } from '@/lib/server/identity/with-owner';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  if (!isServerPersistenceConfigured()) return new Response('未找到', { status: 404 });
  const programVersionId = new URL(req.url).searchParams.get('programVersionId')?.trim();
  if (!programVersionId) {
    return curriculumJsonError(400, 'CURRICULUM_INVALID', '查询参数 programVersionId 为必填');
  }
  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    try {
      const { pool } = await getCurriculumProvider();
      const snapshot = await listCurriculum(pool as unknown as Queryable, ownerId);
      const report = buildProgramCoverage({
        programVersionId,
        programs: snapshot.programs,
        programVersions: snapshot.programVersions,
        graduationIndicators: snapshot.graduationIndicators,
        programCourses: snapshot.programCourses,
        courseIndicatorSupports: snapshot.courseIndicatorSupports,
        courses: snapshot.courses,
        knowledgePoints: snapshot.knowledgePoints,
        courseKnowledgePoints: snapshot.courseKnowledgePoints,
      });
      if (!report) {
        return curriculumJsonError(
          404,
          'CURRICULUM_NOT_FOUND',
          '培养方案版本不存在',
          responseHeaders,
        );
      }
      return ownerJson({ report }, 200, responseHeaders);
    } catch (error) {
      console.error(
        `[CurriculumProgramCoverage] Failed [owner=${ownerId}, version=${programVersionId}]:`,
        error,
      );
      return curriculumJsonError(
        500,
        'CURRICULUM_PROGRAM_COVERAGE_FAILED',
        '生成培养方案覆盖报告失败',
        responseHeaders,
      );
    }
  });
}
