/**
 * DELETE /api/curriculum/design/tasks/[id]/evidence/[evidenceId]
 *
 * Removing evidence can strand an outcome: the design then can no longer reach
 * the `graph` phase, and the audit reports the outcome as unevidenced. That is
 * intended — the evidence is the commitment, so withdrawing it has to be
 * visible rather than free.
 */
import type { NextRequest } from 'next/server';

import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { requiredParam, runDesignRoute } from '@/lib/server/curriculum/design-http';
import { deleteCurriculumEvidence } from '@/lib/server/curriculum/design-store';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string; evidenceId: string }> };

export async function DELETE(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    const evidenceId = requiredParam(ctx, 'evidenceId');
    await ctx.write((tx) => deleteCurriculumEvidence(tx, ctx.ownerId, evidenceId));
    return ownerJson({ deleted: true }, 200, ctx.headers);
  });
}
