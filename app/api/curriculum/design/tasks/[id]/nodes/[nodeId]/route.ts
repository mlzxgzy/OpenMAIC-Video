/**
 * PATCH  /api/curriculum/design/tasks/[id]/nodes/[nodeId]
 * DELETE /api/curriculum/design/tasks/[id]/nodes/[nodeId]
 */
import type { NextRequest } from 'next/server';

import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { designInvalid, requiredParam, runDesignRoute } from '@/lib/server/curriculum/design-http';
import {
  deleteCurriculumLearningNode,
  updateCurriculumLearningNode,
} from '@/lib/server/curriculum/design-store';
import { parseNodePatch } from '@/lib/server/curriculum/design-validation';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string; nodeId: string }> };

export async function PATCH(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    const parsed = parseNodePatch(await ctx.body());
    if (!parsed.ok) return designInvalid(parsed.message, ctx.headers);
    const nodeId = requiredParam(ctx, 'nodeId');
    const node = await ctx.write((tx) =>
      updateCurriculumLearningNode(tx, ctx.ownerId, nodeId, parsed.value),
    );
    return ownerJson({ node }, 200, ctx.headers);
  });
}

export async function DELETE(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    const nodeId = requiredParam(ctx, 'nodeId');
    await ctx.write((tx) => deleteCurriculumLearningNode(tx, ctx.ownerId, nodeId));
    return ownerJson({ deleted: true }, 200, ctx.headers);
  });
}
