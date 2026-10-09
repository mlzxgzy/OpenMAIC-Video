/**
 * POST /api/curriculum/export-jobs — enqueue MP4 exports for completed,
 * staged batch items. The server owns the durable ledger; a page-side worker
 * claims a job, builds/uploads the Hyperframes ZIP through the existing render
 * route and reports back the render job id and progress.
 */
import type { NextRequest } from 'next/server';

import { isServerPersistenceConfigured } from '@/lib/config/feature-flags';
import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { curriculumJsonError, mapCurriculumError } from '@/lib/server/curriculum/http';
import { createCurriculumExportJobs, getCurriculumProvider } from '@/lib/server/curriculum/store';
import { parseCurriculumExportJobsInput } from '@/lib/server/curriculum/validation';
import { withRequestOwner } from '@/lib/server/identity/with-owner';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  if (!isServerPersistenceConfigured()) return new Response('Not found', { status: 404 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return curriculumJsonError(400, 'CURRICULUM_INVALID', '请求体必须是 JSON');
  }
  const parsed = parseCurriculumExportJobsInput(body);
  if (!parsed.ok) return curriculumJsonError(400, 'CURRICULUM_INVALID', parsed.message);

  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    try {
      const { pool } = await getCurriculumProvider();
      const jobs = await createCurriculumExportJobs(
        pool as unknown as import('@openmaic/storage/document/pg').Queryable,
        ownerId,
        parsed.value,
      );
      return ownerJson({ jobs }, 202, responseHeaders);
    } catch (error) {
      const known = mapCurriculumError(error, responseHeaders);
      if (known) return known;
      console.error(`[CurriculumExport] Failed to enqueue [owner=${ownerId}]:`, error);
      return curriculumJsonError(
        500,
        'CURRICULUM_EXPORT_FAILED',
        '导出任务入队失败',
        responseHeaders,
      );
    }
  });
}
