/**
 * PATCH  /api/curriculum/design/tasks/[id]/lab-tasks/[labTaskId]
 * DELETE /api/curriculum/design/tasks/[id]/lab-tasks/[labTaskId]
 *
 * A patch is also how a practice task is promoted to an exam: setting
 * `assessmentMode` to `exam` brings the strictness checks with it, so a
 * promotion that forgets to forbid hints and set a time limit is refused
 * rather than stored half-strict.
 */
import type { NextRequest } from 'next/server';

import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { designInvalid, requiredParam, runDesignRoute } from '@/lib/server/curriculum/design-http';
import {
  deleteCurriculumLabTask,
  updateCurriculumLabTask,
} from '@/lib/server/curriculum/design-store';
import { parseLabTaskPatch } from '@/lib/server/curriculum/design-validation';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string; labTaskId: string }> };

export async function PATCH(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    const parsed = parseLabTaskPatch(await ctx.body());
    if (!parsed.ok) return designInvalid(parsed.message, ctx.headers);
    const labTaskId = requiredParam(ctx, 'labTaskId');
    const labTask = await ctx.write((tx) =>
      updateCurriculumLabTask(tx, ctx.ownerId, labTaskId, parsed.value),
    );
    return ownerJson({ labTask }, 200, ctx.headers);
  });
}

export async function DELETE(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    const labTaskId = requiredParam(ctx, 'labTaskId');
    await ctx.write((tx) => deleteCurriculumLabTask(tx, ctx.ownerId, labTaskId));
    return ownerJson({ deleted: true }, 200, ctx.headers);
  });
}
