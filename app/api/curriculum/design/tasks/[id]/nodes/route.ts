/**
 * POST /api/curriculum/design/tasks/[id]/nodes — create a knowledge or skill node.
 *
 * Only `knowledge` and `skill` exist here. A competency is a learning outcome,
 * and a task is an external result; both belong on
 * `/objectives`, which is what finally gives them a success criterion. A node
 * is the raw material an outcome is built from, and a node that supports no
 * outcome blocks the move to the `outline` phase.
 */
import type { NextRequest } from 'next/server';

import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { designInvalid, runDesignRoute } from '@/lib/server/curriculum/design-http';
import { createCurriculumLearningNode } from '@/lib/server/curriculum/design-store';
import { parseNodeInput } from '@/lib/server/curriculum/design-validation';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    const parsed = parseNodeInput(await ctx.body());
    if (!parsed.ok) return designInvalid(parsed.message, ctx.headers);
    const node = await ctx.write((tx) =>
      createCurriculumLearningNode(tx, ctx.ownerId, ctx.taskId, parsed.value),
    );
    return ownerJson({ node }, 201, ctx.headers);
  });
}
