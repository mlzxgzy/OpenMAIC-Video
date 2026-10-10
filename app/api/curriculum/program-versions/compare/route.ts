/**
 * GET /api/curriculum/program-versions/compare?baseVersionId=...&targetVersionId=...
 *
 * Returns a structured diff between two owned program versions. The workspace
 * can compute the same report from the `/api/curriculum` snapshot; this route
 * exists for API clients and for reports that should not depend on client-side
 * snapshot freshness.
 */
import type { NextRequest } from 'next/server';

import type { Queryable } from '@openmaic/storage/document/pg';

import { buildProgramVersionDiff } from '@/lib/curriculum/program-diff';
import { isServerPersistenceConfigured } from '@/lib/config/feature-flags';
import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { curriculumJsonError } from '@/lib/server/curriculum/http';
import { getCurriculumProvider, listCurriculum } from '@/lib/server/curriculum/store';
import { withRequestOwner } from '@/lib/server/identity/with-owner';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  if (!isServerPersistenceConfigured()) return new Response('未找到', { status: 404 });

  const params = new URL(req.url).searchParams;
  const baseVersionId = params.get('baseVersionId')?.trim();
  const targetVersionId = params.get('targetVersionId')?.trim();
  if (!baseVersionId || !targetVersionId) {
    return curriculumJsonError(
      400,
      'CURRICULUM_INVALID',
      '查询参数 baseVersionId、targetVersionId 均为必填',
    );
  }

  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    try {
      const { pool } = await getCurriculumProvider();
      const snapshot = await listCurriculum(pool as unknown as Queryable, ownerId);
      const report = buildProgramVersionDiff(snapshot, baseVersionId, targetVersionId);
      if (!report) {
        return curriculumJsonError(
          404,
          'CURRICULUM_NOT_FOUND',
          'baseVersionId 或 targetVersionId 对应的培养方案版本不存在',
          responseHeaders,
        );
      }
      return ownerJson({ report }, 200, responseHeaders);
    } catch (error) {
      console.error(
        `[CurriculumProgramCompare] Failed [owner=${ownerId}, base=${baseVersionId}, target=${targetVersionId}]:`,
        error,
      );
      return curriculumJsonError(
        500,
        'CURRICULUM_PROGRAM_COMPARE_FAILED',
        '对比培养方案版本失败',
        responseHeaders,
      );
    }
  });
}
