/**
 * PUT /api/curriculum/design/tasks/[id]/node-objectives — replace the
 * node-to-outcome links for the whole task.
 *
 * This is a set, not an append: the store deletes every link the task has and
 * inserts the ones sent. A client must therefore read the snapshot and send
 * the complete set back, which is what the workspace does. The natural key is
 * the `(nodeId, objectiveId)` pair, so several knowledge nodes can support one
 * outcome — that plurality is the point of the layer, since a competency is
 * normally assembled from more than one piece of knowledge.
 */
import type { NextRequest } from 'next/server';

import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { designInvalid, runDesignRoute } from '@/lib/server/curriculum/design-http';
import { setCurriculumNodeObjectives } from '@/lib/server/curriculum/design-store';
import { parseNodeObjectives } from '@/lib/server/curriculum/design-validation';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

export async function PUT(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    const parsed = parseNodeObjectives(await ctx.body());
    if (!parsed.ok) return designInvalid(parsed.message, ctx.headers);
    const links = await ctx.write((tx) =>
      setCurriculumNodeObjectives(tx, ctx.ownerId, ctx.taskId, parsed.value),
    );
    return ownerJson({ links }, 200, ctx.headers);
  });
}
