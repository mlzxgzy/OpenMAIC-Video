/**
 * DELETE /api/curriculum/design/tasks/[id]/dependencies/[dependencyId]
 */
import type { NextRequest } from 'next/server';

import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { requiredParam, runDesignRoute } from '@/lib/server/curriculum/design-http';
import { deleteCurriculumDependency } from '@/lib/server/curriculum/design-store';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string; dependencyId: string }> };

export async function DELETE(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    const dependencyId = requiredParam(ctx, 'dependencyId');
    await ctx.write((tx) => deleteCurriculumDependency(tx, ctx.ownerId, dependencyId));
    return ownerJson({ deleted: true }, 200, ctx.headers);
  });
}
