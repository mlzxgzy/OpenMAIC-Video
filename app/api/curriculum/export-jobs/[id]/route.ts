/**
 * PATCH /api/curriculum/export-jobs/[id] — browser-worker updates one export
 * job: attach a render job id, report progress, complete, fail, retry or
 * cancel. The action is owner-scoped and state-guarded in the store.
 */
import type { NextRequest } from 'next/server';

import type { Queryable } from '@openmaic/storage/document/pg';

import { isServerPersistenceConfigured } from '@/lib/config/feature-flags';
import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { curriculumJsonError, mapCurriculumError } from '@/lib/server/curriculum/http';
import {
  applyCurriculumExportJobAction,
  getCurriculumProvider,
} from '@/lib/server/curriculum/store';
import { parseCurriculumExportJobAction } from '@/lib/server/curriculum/validation';
import { withRequestOwner } from '@/lib/server/identity/with-owner';

export const runtime = 'nodejs';

export async function PATCH(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  if (!isServerPersistenceConfigured()) return new Response('Not found', { status: 404 });
  const { id } = await context.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return curriculumJsonError(400, 'CURRICULUM_INVALID', '请求体必须是 JSON');
  }
  const parsed = parseCurriculumExportJobAction(body);
  if (!parsed.ok) return curriculumJsonError(400, 'CURRICULUM_INVALID', parsed.message);

  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    try {
      const { pool } = await getCurriculumProvider();
      const job = await applyCurriculumExportJobAction(
        pool as unknown as Queryable,
        ownerId,
        id,
        parsed.value,
      );
      return ownerJson({ job }, 200, responseHeaders);
    } catch (error) {
      const known = mapCurriculumError(error, responseHeaders);
      if (known) return known;
      console.error(`[CurriculumExport] Failed to update ${id} [owner=${ownerId}]:`, error);
      return curriculumJsonError(
        500,
        'CURRICULUM_EXPORT_UPDATE_FAILED',
        '更新导出任务失败',
        responseHeaders,
      );
    }
  });
}
