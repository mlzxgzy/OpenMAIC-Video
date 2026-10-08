/**
 * PATCH  /api/curriculum/design/tasks/[id]/units/[unitId]
 * DELETE /api/curriculum/design/tasks/[id]/units/[unitId]
 *
 * The PATCH is how a lecture item receives its teaching design and deck
 * design. Both are typed, and a deck page without a `goal` is refused: a page
 * that states only a heading answers no teaching question, and accepting it
 * here is how a designed lesson degrades back into a topic list.
 */
import type { NextRequest } from 'next/server';

import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { designInvalid, requiredParam, runDesignRoute } from '@/lib/server/curriculum/design-http';
import { deleteCurriculumUnit, updateCurriculumUnit } from '@/lib/server/curriculum/design-store';
import { parseUnitPatch } from '@/lib/server/curriculum/design-validation';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string; unitId: string }> };

export async function PATCH(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    const parsed = parseUnitPatch(await ctx.body());
    if (!parsed.ok) return designInvalid(parsed.message, ctx.headers);
    const unitId = requiredParam(ctx, 'unitId');
    const unit = await ctx.write((tx) =>
      updateCurriculumUnit(tx, ctx.ownerId, unitId, parsed.value),
    );
    return ownerJson({ unit }, 200, ctx.headers);
  });
}

export async function DELETE(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    const unitId = requiredParam(ctx, 'unitId');
    await ctx.write((tx) => deleteCurriculumUnit(tx, ctx.ownerId, unitId));
    return ownerJson({ deleted: true }, 200, ctx.headers);
  });
}
