/**
 * POST /api/curriculum/export-jobs/claim — atomically claim the oldest queued
 * export for the browser worker. Returns `{ job: null }` when the queue is
 * empty so the caller can stop without treating it as an error.
 */
import type { NextRequest } from 'next/server';

import type { Queryable } from '@openmaic/storage/document/pg';

import { isServerPersistenceConfigured } from '@/lib/config/feature-flags';
import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { curriculumJsonError } from '@/lib/server/curriculum/http';
import { claimNextCurriculumExportJob, getCurriculumProvider } from '@/lib/server/curriculum/store';
import { withRequestOwner } from '@/lib/server/identity/with-owner';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  if (!isServerPersistenceConfigured()) return new Response('未找到', { status: 404 });

  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    try {
      const { pool } = await getCurriculumProvider();
      const job = await claimNextCurriculumExportJob(pool as unknown as Queryable, ownerId);
      return ownerJson({ job }, 200, responseHeaders);
    } catch (error) {
      console.error(`[CurriculumExport] Failed to claim [owner=${ownerId}]:`, error);
      return curriculumJsonError(
        500,
        'CURRICULUM_EXPORT_CLAIM_FAILED',
        '领取导出任务失败',
        responseHeaders,
      );
    }
  });
}
