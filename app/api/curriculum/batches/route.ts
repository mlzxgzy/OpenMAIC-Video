/**
 * POST /api/curriculum/batches — enqueue a batch of assembled course
 * generations. Each item carries either an existing curriculum course (its
 * bound knowledge points are assembled server-side) or a full assembly body.
 */
import type { NextRequest } from 'next/server';

import { isServerPersistenceConfigured } from '@/lib/config/feature-flags';
import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { enqueueCurriculumBatch } from '@/lib/server/curriculum/batch';
import { curriculumJsonError, mapCurriculumError } from '@/lib/server/curriculum/http';
import { parseCurriculumBatchInput } from '@/lib/server/curriculum/validation';
import { withRequestOwner } from '@/lib/server/identity/with-owner';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  if (!isServerPersistenceConfigured()) return new Response('未找到', { status: 404 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return curriculumJsonError(400, 'CURRICULUM_INVALID', '请求体必须是 JSON');
  }
  const parsed = parseCurriculumBatchInput(body);
  if (!parsed.ok) return curriculumJsonError(400, 'CURRICULUM_INVALID', parsed.message);

  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    try {
      const created = await enqueueCurriculumBatch(ownerId, parsed.value);
      return ownerJson(created, 202, responseHeaders);
    } catch (error) {
      const known = mapCurriculumError(error, responseHeaders);
      if (known) return known;
      console.error(`[CurriculumBatch] Failed to enqueue [owner=${ownerId}]:`, error);
      return curriculumJsonError(
        500,
        'CURRICULUM_BATCH_FAILED',
        '生成批次入队失败',
        responseHeaders,
      );
    }
  });
}
