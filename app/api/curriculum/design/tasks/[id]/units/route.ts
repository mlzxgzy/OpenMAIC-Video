/**
 * POST /api/curriculum/design/tasks/[id]/units — create a chapter or an item.
 *
 * A chapter classifies and carries no role; an item is the teaching unit and
 * must be one of `lecture`, `practice` or `exam`. The store enforces that
 * split, so a chapter cannot be given content here. An item may carry a
 * `teachingDesign` (what to teach in full, briefly, mention, or deliberately
 * omit) and a `deckDesign` (the typed page plan), which are what the slide
 * generator consumes instead of a free-text requirement.
 */
import type { NextRequest } from 'next/server';

import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { designInvalid, runDesignRoute } from '@/lib/server/curriculum/design-http';
import { createCurriculumUnit } from '@/lib/server/curriculum/design-store';
import { parseUnitInput } from '@/lib/server/curriculum/design-validation';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    const parsed = parseUnitInput(await ctx.body());
    if (!parsed.ok) return designInvalid(parsed.message, ctx.headers);
    const unit = await ctx.write((tx) =>
      createCurriculumUnit(tx, ctx.ownerId, ctx.taskId, parsed.value),
    );
    return ownerJson({ unit }, 201, ctx.headers);
  });
}
