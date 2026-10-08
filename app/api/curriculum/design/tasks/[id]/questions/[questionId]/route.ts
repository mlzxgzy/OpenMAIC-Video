/**
 * PATCH  /api/curriculum/design/tasks/[id]/questions/[questionId]
 * DELETE /api/curriculum/design/tasks/[id]/questions/[questionId]
 */
import type { NextRequest } from 'next/server';

import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { designInvalid, requiredParam, runDesignRoute } from '@/lib/server/curriculum/design-http';
import {
  deleteCurriculumQuestion,
  updateCurriculumQuestion,
} from '@/lib/server/curriculum/design-store';
import { parseQuestionPatch } from '@/lib/server/curriculum/design-validation';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string; questionId: string }> };

export async function PATCH(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    const parsed = parseQuestionPatch(await ctx.body());
    if (!parsed.ok) return designInvalid(parsed.message, ctx.headers);
    const questionId = requiredParam(ctx, 'questionId');
    const question = await ctx.write((tx) =>
      updateCurriculumQuestion(tx, ctx.ownerId, questionId, parsed.value),
    );
    return ownerJson({ question }, 200, ctx.headers);
  });
}

export async function DELETE(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    const questionId = requiredParam(ctx, 'questionId');
    await ctx.write((tx) => deleteCurriculumQuestion(tx, ctx.ownerId, questionId));
    return ownerJson({ deleted: true }, 200, ctx.headers);
  });
}
