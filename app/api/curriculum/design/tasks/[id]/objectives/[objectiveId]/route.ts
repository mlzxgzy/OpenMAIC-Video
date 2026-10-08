/**
 * PATCH  /api/curriculum/design/tasks/[id]/objectives/[objectiveId]
 * DELETE /api/curriculum/design/tasks/[id]/objectives/[objectiveId]
 *
 * The PATCH re-derives `verifiable` against the MERGED outcome, not against
 * the fields this request happens to carry. Adding the expected behavior to an
 * outcome that only had a title is the ordinary way one becomes checkable, and
 * deriving from the patch alone would leave the flag false forever.
 */
import type { NextRequest } from 'next/server';

import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { designInvalid, requiredParam, runDesignRoute } from '@/lib/server/curriculum/design-http';
import {
  deleteCurriculumObjective,
  updateCurriculumObjective,
} from '@/lib/server/curriculum/design-store';
import { parseObjectivePatch } from '@/lib/server/curriculum/design-validation';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string; objectiveId: string }> };

export async function PATCH(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    const parsed = parseObjectivePatch(await ctx.body());
    if (!parsed.ok) return designInvalid(parsed.message, ctx.headers);
    const objectiveId = requiredParam(ctx, 'objectiveId');

    // The store re-derives `verifiable` against the merged outcome, which is
    // what makes "add the missing behavior" actually flip it.
    const objective = await ctx.write((tx) =>
      updateCurriculumObjective(tx, ctx.ownerId, objectiveId, parsed.value),
    );
    return ownerJson({ objective }, 200, ctx.headers);
  });
}

export async function DELETE(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    const objectiveId = requiredParam(ctx, 'objectiveId');
    await ctx.write((tx) => deleteCurriculumObjective(tx, ctx.ownerId, objectiveId));
    return ownerJson({ deleted: true }, 200, ctx.headers);
  });
}
