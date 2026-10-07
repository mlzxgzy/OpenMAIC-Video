/**
 * PATCH /api/curriculum/batches/[id] — pause, resume, cancel or retry one
 * batch. The action is owner-scoped; resume/retry wakes the local scanner.
 */
import type { NextRequest } from 'next/server';

import { isServerPersistenceConfigured } from '@/lib/config/feature-flags';
import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { actOnCurriculumBatch } from '@/lib/server/curriculum/batch';
import { curriculumJsonError, mapCurriculumError } from '@/lib/server/curriculum/http';
import { getCurriculumProvider } from '@/lib/server/curriculum/store';
import { withRequestOwner } from '@/lib/server/identity/with-owner';

export const runtime = 'nodejs';

const ACTIONS = ['pause', 'resume', 'cancel', 'retry'] as const;

export async function PATCH(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  if (!isServerPersistenceConfigured()) return new Response('Not found', { status: 404 });
  const { id } = await context.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return curriculumJsonError(400, 'CURRICULUM_INVALID', 'request body must be JSON');
  }
  const action =
    typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>).action
      : undefined;
  if (typeof action !== 'string' || !ACTIONS.includes(action as (typeof ACTIONS)[number])) {
    return curriculumJsonError(
      400,
      'CURRICULUM_INVALID',
      `action must be one of ${ACTIONS.join(', ')}`,
    );
  }

  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    try {
      // Ensure the batch store is provisioned even before the first GET.
      await getCurriculumProvider();
      const batch = await actOnCurriculumBatch(ownerId, id, action as (typeof ACTIONS)[number]);
      return ownerJson({ batch }, 200, responseHeaders);
    } catch (error) {
      const known = mapCurriculumError(error, responseHeaders);
      if (known) return known;
      console.error(`[CurriculumBatch] Failed to apply ${action} [owner=${ownerId}]:`, error);
      return curriculumJsonError(
        500,
        'CURRICULUM_BATCH_FAILED',
        'Failed to update the generation batch',
        responseHeaders,
      );
    }
  });
}
