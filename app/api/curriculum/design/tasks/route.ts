/**
 * GET  /api/curriculum/design/tasks — the caller's course design tasks.
 * POST /api/curriculum/design/tasks — start a new course design task.
 *
 * A design task is not a course; it is the brief a course gets designed from.
 * It begins in the `task` phase, and the phase machine will not let outcomes,
 * knowledge, an outline or materials be authored until the brief is filled in.
 */
import type { NextRequest } from 'next/server';

import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { designInvalid, runDesignRoute } from '@/lib/server/curriculum/design-http';
import { createCurriculumTask, listCurriculumTasks } from '@/lib/server/curriculum/design-store';
import { parseTaskInput } from '@/lib/server/curriculum/design-validation';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  return runDesignRoute(req, undefined, async (ctx) => {
    const seriesId = req.nextUrl.searchParams.get('seriesId');
    // Absent means every task the owner has, which is what the workspace list
    // wants; an explicit id narrows to one series.
    const tasks = await listCurriculumTasks(ctx.queryable, ctx.ownerId, seriesId?.trim() || null);
    return ownerJson({ tasks }, 200, ctx.headers);
  });
}

export async function POST(req: NextRequest) {
  return runDesignRoute(req, undefined, async (ctx) => {
    const parsed = parseTaskInput(await ctx.body());
    if (!parsed.ok) return designInvalid(parsed.message, ctx.headers);
    const task = await ctx.write((tx) => createCurriculumTask(tx, ctx.ownerId, parsed.value));
    return ownerJson({ task }, 201, ctx.headers);
  });
}
