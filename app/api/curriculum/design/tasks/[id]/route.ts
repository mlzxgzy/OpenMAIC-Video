/**
 * GET    /api/curriculum/design/tasks/[id] — the whole design of one task.
 * PATCH  /api/curriculum/design/tasks/[id] — update the brief.
 * DELETE /api/curriculum/design/tasks/[id] — delete the task and everything under it.
 *
 * The GET returns the full snapshot in one payload because the workspace needs
 * both directions at once — outcome → course and course → outcome — and
 * fetching them separately would let the two views disagree mid-edit. The
 * derived reports (matrix, coverage, review) are separate routes.
 */
import type { NextRequest } from 'next/server';

import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { designInvalid, runDesignRoute } from '@/lib/server/curriculum/design-http';
import {
  deleteCurriculumTask,
  getCurriculumDesignSnapshot,
  updateCurriculumTask,
} from '@/lib/server/curriculum/design-store';
import { parseTaskPatch } from '@/lib/server/curriculum/design-validation';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    const snapshot = await getCurriculumDesignSnapshot(ctx.queryable, ctx.ownerId, ctx.taskId);
    return ownerJson(snapshot, 200, ctx.headers);
  });
}

export async function PATCH(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    const parsed = parseTaskPatch(await ctx.body());
    if (!parsed.ok) return designInvalid(parsed.message, ctx.headers);
    const task = await ctx.write((tx) =>
      updateCurriculumTask(tx, ctx.ownerId, ctx.taskId, parsed.value),
    );
    return ownerJson({ task }, 200, ctx.headers);
  });
}

export async function DELETE(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    await ctx.write((tx) => deleteCurriculumTask(tx, ctx.ownerId, ctx.taskId));
    return ownerJson({ deleted: true }, 200, ctx.headers);
  });
}
