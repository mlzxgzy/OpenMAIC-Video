/**
 * POST /api/curriculum/design/tasks/[id]/dependencies — add one learning-order
 * edge between two outcomes, two nodes, or an outcome and a node.
 *
 * Both endpoint kinds live in one table so the graph stays a single DAG, which
 * is why the body carries `sourceKind`/`targetKind` and why the store validates
 * that both endpoints exist and belong to this task. Ordering edges are kept
 * acyclic; a cycle in `related` or `composes` is not an order claim and is
 * allowed, so only the directed types are checked.
 */
import type { NextRequest } from 'next/server';

import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { designInvalid, runDesignRoute } from '@/lib/server/curriculum/design-http';
import { createCurriculumDependency } from '@/lib/server/curriculum/design-store';
import { parseDependencyInput } from '@/lib/server/curriculum/design-validation';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    const parsed = parseDependencyInput(await ctx.body());
    if (!parsed.ok) return designInvalid(parsed.message, ctx.headers);
    const dependency = await ctx.write((tx) =>
      createCurriculumDependency(tx, ctx.ownerId, ctx.taskId, parsed.value),
    );
    return ownerJson({ dependency }, 201, ctx.headers);
  });
}
