/**
 * DELETE /api/curriculum/design/tasks/[id]/unit-dependencies/[unitDependencyId]
 *
 * The write counterpart is POST on the parent route, which is an upsert: it can
 * record an ordering claim or restate one, but never withdraw it. An edge is a
 * row rather than a field, so without this route a teaching order recorded
 * wrongly during the outline phase could only be undone by deleting the task
 * and losing the whole design.
 */
import type { NextRequest } from 'next/server';

import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { requiredParam, runDesignRoute } from '@/lib/server/curriculum/design-http';
import { deleteCurriculumUnitDependency } from '@/lib/server/curriculum/design-store';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string; unitDependencyId: string }> };

export async function DELETE(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    const unitDependencyId = requiredParam(ctx, 'unitDependencyId');
    await ctx.write((tx) => deleteCurriculumUnitDependency(tx, ctx.ownerId, unitDependencyId));
    return ownerJson({ deleted: true }, 200, ctx.headers);
  });
}
