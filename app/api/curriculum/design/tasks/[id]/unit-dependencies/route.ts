/**
 * POST /api/curriculum/design/tasks/[id]/unit-dependencies — order two items.
 *
 * This is the teaching sequence, which is a different claim from the learning
 * dependency graph: `curriculum_dependency` says what a learner must know
 * first, this says what the course presents first. The audit compares the two,
 * because a dependency graph can be correct while the outline still puts an
 * advanced skill before the basic one it rests on.
 */
import type { NextRequest } from 'next/server';

import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { designInvalid, runDesignRoute } from '@/lib/server/curriculum/design-http';
import { createCurriculumUnitDependency } from '@/lib/server/curriculum/design-store';
import { parseUnitDependencyInput } from '@/lib/server/curriculum/design-validation';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    const parsed = parseUnitDependencyInput(await ctx.body());
    if (!parsed.ok) return designInvalid(parsed.message, ctx.headers);
    const dependency = await ctx.write((tx) =>
      createCurriculumUnitDependency(tx, ctx.ownerId, ctx.taskId, parsed.value),
    );
    return ownerJson({ dependency }, 201, ctx.headers);
  });
}
