/**
 * POST /api/curriculum/design/tasks/[id]/objectives — create a learning outcome.
 *
 * This is the entity the whole model rests on. `title` and `objectiveType` are
 * required, but an outcome without `expectedBehavior` and `minCriteria` is
 * stored as *not verifiable*: the verifiable flag is derived, never taken from
 * the body, so "了解 SQL 注入" cannot be claimed as a result no matter what the
 * caller sends.
 *
 * Writes are gated on the `outcomes` phase; before that the store answers 409
 * with the phase the task is actually in.
 */
import type { NextRequest } from 'next/server';

import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { designInvalid, runDesignRoute } from '@/lib/server/curriculum/design-http';
import { createCurriculumObjective } from '@/lib/server/curriculum/design-store';
import { parseObjectiveInput } from '@/lib/server/curriculum/design-validation';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    const parsed = parseObjectiveInput(await ctx.body());
    if (!parsed.ok) return designInvalid(parsed.message, ctx.headers);

    // `verifiable` is not sent: the store derives it from the behavior and
    // criteria, so this route and the agent tools cannot disagree about it.
    const objective = await ctx.write((tx) =>
      createCurriculumObjective(tx, ctx.ownerId, ctx.taskId, parsed.value),
    );
    return ownerJson({ objective }, 201, ctx.headers);
  });
}
