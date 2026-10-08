/**
 * GET  /api/curriculum/design/tasks/[id]/review — evaluate the design, writing
 *      nothing.
 * POST /api/curriculum/design/tasks/[id]/review — evaluate and record the findings.
 *
 * The split matters. The GET returns derived findings that carry no ids,
 * because recording them is a mutation and a prefetch or a retry must not
 * perform one. The POST replaces the stored set, which is what the workspace
 * shows and what the finding-status route acts on.
 *
 * Both fold the coverage verdict in, so a caller learns whether the loop
 * closes from the same response that lists the defects.
 */
import type { NextRequest } from 'next/server';

import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { runDesignRoute } from '@/lib/server/curriculum/design-http';
import {
  evaluateCurriculumDesign,
  getCurriculumDesignSnapshot,
  reviewCurriculumTaskDesign,
} from '@/lib/server/curriculum/design-store';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    const snapshot = await getCurriculumDesignSnapshot(ctx.queryable, ctx.ownerId, ctx.taskId);
    const evaluation = evaluateCurriculumDesign(snapshot);
    return ownerJson({ ...evaluation, persisted: false }, 200, ctx.headers);
  });
}

export async function POST(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    const review = await ctx.write((tx) => reviewCurriculumTaskDesign(tx, ctx.ownerId, ctx.taskId));
    return ownerJson({ ...review, persisted: true }, 200, ctx.headers);
  });
}
