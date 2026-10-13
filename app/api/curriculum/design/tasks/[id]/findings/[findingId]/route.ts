/**
 * PATCH /api/curriculum/design/tasks/[id]/findings/[findingId] — accept one
 * recorded finding, or take the acceptance back.
 *
 * Findings are derived, so the only decision a caller can make about one is to
 * accept it: `waived` stops it blocking production (and the export says it is
 * shipping with an accepted defect rather than staying silent about it), and
 * `open` undoes that. `resolved` is a value the column can hold and a caller
 * cannot write — the store refuses it, because a defect the audit still derives
 * is not fixed no matter who says so.
 *
 * The value reaches a CHECK constraint, so the parse happens before the write:
 * a typo here would otherwise surface as a 500.
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
