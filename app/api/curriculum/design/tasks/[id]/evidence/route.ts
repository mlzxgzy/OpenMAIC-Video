/**
 * POST /api/curriculum/design/tasks/[id]/evidence — bind an outcome to the
 * evidence that would prove it was met.
 *
 * Evidence is what makes "define the outcome" different from "name a topic":
 * a row here says what will be observed, under what condition, and how
 * independent the learner has to be while producing it. The store will not let
 * the design reach the `graph` phase while any outcome lacks one.
 */
import type { NextRequest } from 'next/server';

import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { designInvalid, runDesignRoute } from '@/lib/server/curriculum/design-http';
import { createCurriculumEvidence } from '@/lib/server/curriculum/design-store';
import { parseEvidenceInput } from '@/lib/server/curriculum/design-validation';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    const parsed = parseEvidenceInput(await ctx.body());
    if (!parsed.ok) return designInvalid(parsed.message, ctx.headers);
    const evidence = await ctx.write((tx) =>
      createCurriculumEvidence(tx, ctx.ownerId, ctx.taskId, parsed.value),
    );
    return ownerJson({ evidence }, 201, ctx.headers);
  });
}
