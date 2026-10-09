/**
 * GET /api/curriculum/program-versions/[id]/export — download one owned
 * program version as a portable, versioned JSON plan document.
 */
import type { NextRequest } from 'next/server';

import type { Queryable } from '@openmaic/storage/document/pg';

import { buildProgramPlanExport } from '@/lib/curriculum/program-io';
import { isServerPersistenceConfigured } from '@/lib/config/feature-flags';
import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { curriculumJsonError } from '@/lib/server/curriculum/http';
import { getCurriculumProvider, listCurriculum } from '@/lib/server/curriculum/store';
import { withRequestOwner } from '@/lib/server/identity/with-owner';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  if (!isServerPersistenceConfigured()) return new Response('Not found', { status: 404 });
  const { id } = await params;
  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    try {
      const { pool } = await getCurriculumProvider();
      const snapshot = await listCurriculum(pool as unknown as Queryable, ownerId);
      const document = buildProgramPlanExport(snapshot, id);
      if (!document) {
        return curriculumJsonError(
          404,
          'CURRICULUM_NOT_FOUND',
          '培养方案版本不存在',
          responseHeaders,
        );
      }
      return ownerJson({ document }, 200, responseHeaders);
    } catch (error) {
      console.error(`[CurriculumProgramExport] Failed [owner=${ownerId}, version=${id}]:`, error);
      return curriculumJsonError(
        500,
        'CURRICULUM_PROGRAM_EXPORT_FAILED',
        '导出培养方案版本失败',
        responseHeaders,
      );
    }
  });
}
