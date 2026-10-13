/**
 * POST /api/curriculum/export-jobs — enqueue MP4 exports. Two shapes are
 * accepted: completed/staged batch items (the 旧台账 path) and bare stage ids
 * (the 目工作台 path, where a design was generated straight into a classroom).
 * The server owns the durable ledger; a page-side worker claims a job,
 * builds/uploads the Hyperframes ZIP through the existing render route and
 * reports back the render job id and progress.
 *
 * GET /api/curriculum/export-jobs?stageIds=a,b — read the jobs of those stages.
 * The 目工作台 polls this while its own classrooms are exporting; without it the
 * only way to see an export's progress server-side would be the whole-curriculum
 * snapshot, which carries every table this panel does not use.
 */
import type { NextRequest } from 'next/server';

import { isServerPersistenceConfigured } from '@/lib/config/feature-flags';
import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { curriculumJsonError, mapCurriculumError } from '@/lib/server/curriculum/http';
import {
  createCurriculumExportJobs,
  getCurriculumProvider,
  listCurriculumExportJobs,
} from '@/lib/server/curriculum/store';
import { parseCurriculumExportJobsInput } from '@/lib/server/curriculum/validation';
import { withRequestOwner } from '@/lib/server/identity/with-owner';

export const runtime = 'nodejs';

/**
 * 上限与入队一致（`stageIds 数量过多` 也是 50）。超过就当作"没有筛选"是错的：
 * 那会让调用方以为自己在看一个子集，实际看到全部。
 */
const MAX_STAGE_FILTERS = 50;

export async function GET(req: NextRequest) {
  if (!isServerPersistenceConfigured()) return new Response('未找到', { status: 404 });

  const raw = req.nextUrl.searchParams.get('stageIds');
  const stageIds = (raw ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (stageIds.length > MAX_STAGE_FILTERS) {
    return curriculumJsonError(400, 'CURRICULUM_INVALID', 'stageIds 数量过多');
  }

  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    try {
      const { pool } = await getCurriculumProvider();
      const jobs = await listCurriculumExportJobs(
        pool as unknown as import('@openmaic/storage/document/pg').Queryable,
        ownerId,
        stageIds,
      );
      return ownerJson({ jobs }, 200, responseHeaders);
    } catch (error) {
      const known = mapCurriculumError(error, responseHeaders);
      if (known) return known;
      console.error(`[CurriculumExport] Failed to list [owner=${ownerId}]:`, error);
      return curriculumJsonError(
        500,
        'CURRICULUM_EXPORT_FAILED',
        '读取导出任务失败',
        responseHeaders,
      );
    }
  });
}

export async function POST(req: NextRequest) {
  if (!isServerPersistenceConfigured()) return new Response('未找到', { status: 404 });

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
