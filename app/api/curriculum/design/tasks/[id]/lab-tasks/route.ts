/**
 * POST /api/curriculum/design/tasks/[id]/lab-tasks — one hands-on task.
 *
 * The body carries two fields that must never be confused, and the store keeps
 * them in separate columns for that reason:
 *
 * - `referenceSolution` — one recommended route. Used for hints and write-ups.
 * - `verifyRules` — what actually decides the result.
 *
 * A CTF task has many correct routes, so grading against the reference path
 * would mark a correct solve wrong. `verifyRules` is therefore required and
 * the store refuses a task without one; the refusal is deliberately not
 * duplicated in the parser, so the message comes from the layer that knows
 * what grading needs.
 *
 * `assessmentMode` is the only thing separating practice from exam. The
 * database additionally refuses an `exam` that allows hints, allows retries,
 * or sets no time limit — "independent, hint-free, scored" is enforced, not
 * merely intended.
 */
import type { NextRequest } from 'next/server';

import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { designInvalid, runDesignRoute } from '@/lib/server/curriculum/design-http';
import { createCurriculumLabTask } from '@/lib/server/curriculum/design-store';
import { parseLabTaskInput } from '@/lib/server/curriculum/design-validation';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    const parsed = parseLabTaskInput(await ctx.body());
    if (!parsed.ok) return designInvalid(parsed.message, ctx.headers);
    const labTask = await ctx.write((tx) =>
      createCurriculumLabTask(tx, ctx.ownerId, ctx.taskId, parsed.value),
    );
    return ownerJson({ labTask }, 201, ctx.headers);
  });
}
