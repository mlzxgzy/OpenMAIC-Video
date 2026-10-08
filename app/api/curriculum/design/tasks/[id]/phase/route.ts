/**
 * GET  /api/curriculum/design/tasks/[id]/phase — where the design is, and what
 *      the next phase still needs.
 * POST /api/curriculum/design/tasks/[id]/phase — advance one phase.
 *
 * The GET is what makes the phase machine usable rather than merely
 * restrictive: it reports the current phase, the next one, and every concrete
 * gap blocking the move. `gaps` is empty exactly when POST will succeed.
 */
import type { NextRequest } from 'next/server';

import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { runDesignRoute } from '@/lib/server/curriculum/design-http';
import {
  advanceCurriculumTaskPhase,
  getCurriculumTask,
  phaseCompletionGaps,
} from '@/lib/server/curriculum/design-store';
import { nextCurriculumDesignPhase } from '@/lib/curriculum/design-types';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    const task = await getCurriculumTask(ctx.queryable, ctx.ownerId, ctx.taskId);
    if (!task) {
      return ownerJson(
        { error: { code: 'CURRICULUM_DESIGN_NOT_FOUND', message: 'course task not found' } },
        404,
        ctx.headers,
      );
    }
    const next = nextCurriculumDesignPhase(task.designPhase);
    const gaps = next
      ? await phaseCompletionGaps(ctx.queryable, ctx.ownerId, ctx.taskId, next)
      : [];
    return ownerJson(
      {
        phase: task.designPhase,
        nextPhase: next,
        // At the last phase there is nothing to advance to, so the boundary is
        // satisfied by definition rather than by an empty check list.
        gaps,
        readyToAdvance: next !== null && gaps.length === 0,
      },
      200,
      ctx.headers,
    );
  });
}

export async function POST(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    const task = await ctx.write((tx) => advanceCurriculumTaskPhase(tx, ctx.ownerId, ctx.taskId));
    return ownerJson({ task }, 200, ctx.headers);
  });
}
