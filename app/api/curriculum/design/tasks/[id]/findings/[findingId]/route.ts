/**
 * PATCH /api/curriculum/design/tasks/[id]/findings/[findingId] — resolve or
 * waive one recorded finding.
 *
 * The next review replaces open findings, so this is the route that makes a
 * decision stick: a waived gap is a deliberate acceptance, and it survives a
 * re-run rather than being reported as new. Only `open`, `resolved` and
 * `waived` are accepted; the value reaches a CHECK constraint, so a typo here
 * would otherwise surface as a 500.
 */
import type { NextRequest } from 'next/server';

import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { designInvalid, requiredParam, runDesignRoute } from '@/lib/server/curriculum/design-http';
import { setCurriculumAuditFindingStatus } from '@/lib/server/curriculum/design-store';
import { parseFindingStatus } from '@/lib/server/curriculum/design-validation';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string; findingId: string }> };

export async function PATCH(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    const parsed = parseFindingStatus(await ctx.body());
    if (!parsed.ok) return designInvalid(parsed.message, ctx.headers);
    const findingId = requiredParam(ctx, 'findingId');
    const finding = await ctx.write((tx) =>
      setCurriculumAuditFindingStatus(tx, ctx.ownerId, findingId, parsed.value),
    );
    return ownerJson({ finding }, 200, ctx.headers);
  });
}
