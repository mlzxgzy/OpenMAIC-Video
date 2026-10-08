/**
 * POST /api/curriculum/design/tasks/[id]/questions — one theory question.
 *
 * Every question carries both the outcome it verifies and the evidence it
 * belongs to, so no item can be authored that nothing accounts for. The
 * `distractors` field is what makes a wrong answer informative: each one names
 * the misconception behind a particular option, which is the difference
 * between a red mark and a diagnosis.
 */
import type { NextRequest } from 'next/server';

import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { designInvalid, runDesignRoute } from '@/lib/server/curriculum/design-http';
import { createCurriculumQuestion } from '@/lib/server/curriculum/design-store';
import { parseQuestionInput } from '@/lib/server/curriculum/design-validation';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    const parsed = parseQuestionInput(await ctx.body());
    if (!parsed.ok) return designInvalid(parsed.message, ctx.headers);
    const question = await ctx.write((tx) =>
      createCurriculumQuestion(tx, ctx.ownerId, ctx.taskId, parsed.value),
    );
    return ownerJson({ question }, 201, ctx.headers);
  });
}
