/**
 * GET    /api/curriculum/design/tasks/[id]/assessment — 题目与实操的签收状态.
 * POST   /api/curriculum/design/tasks/[id]/assessment — 作者确认题目与实操.
 * DELETE /api/curriculum/design/tasks/[id]/assessment — 撤回确认，重新打开这一步.
 *
 * The same three verbs as the six state routes before it, and the same reasoning:
 * the confirmation is what the phase machine reads before `assessment → review`,
 * this route is the half a person drives, and the AI conversation writes the
 * questions and lab tasks (`.../assessment/turn`) and may record its own
 * confirmation as `assistant`.
 *
 * POST refuses an incomplete assessment on purpose, and what "incomplete" means
 * here is the point of the step: every item that promised to grade an outcome has
 * something that grades it, every evidence row has its artifact, an exam evidence
 * is not delivered by a practice lab, and nothing hangs where nothing promised it.
 * Confirming with any of those open produces a state where the author believes the
 * course is assessed while the coverage loop has never seen the questions — and
 * export then signs off on a course nobody was ever checked against.
 *
 * `DELETE` answers 404 when there was nothing to withdraw rather than pretending
 * it succeeded, so a double-click cannot look like a sign-off.
 */
import type { NextRequest } from 'next/server';

import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import {
  designInvalid,
  runDesignRoute,
  type DesignContext,
} from '@/lib/server/curriculum/design-http';
import {
  confirmCurriculumDesignStep,
  getCurriculumDesignSnapshot,
  getCurriculumTask,
  withdrawCurriculumDesignStep,
} from '@/lib/server/curriculum/design-store';
import { assessmentBlockers, assessmentState } from '@/lib/server/curriculum/assessment-state';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

/** The note is free text from the dialog; the column is not a log. */
const MAX_NOTE_CHARS = 500;

export async function GET(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    const task = await getCurriculumTask(ctx.queryable, ctx.ownerId, ctx.taskId);
    if (!task) return notFound(ctx);
    const snapshot = await getCurriculumDesignSnapshot(ctx.queryable, ctx.ownerId, task.id);
    return ownerJson(await assessmentState(ctx, task.id, snapshot), 200, ctx.headers);
  });
}

export async function POST(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    const task = await getCurriculumTask(ctx.queryable, ctx.ownerId, ctx.taskId);
    if (!task) return notFound(ctx);
    const snapshot = await getCurriculumDesignSnapshot(ctx.queryable, ctx.ownerId, task.id);
    const blockers = assessmentBlockers(snapshot);
    if (blockers.length > 0) {
      return designInvalid(`题目与实操还不完整，先补齐：${blockers.join('；')}`, ctx.headers);
    }
    const note = await readNote(ctx);
    await ctx.write((tx) =>
      confirmCurriculumDesignStep(tx, ctx.ownerId, ctx.taskId, 'assessment', 'user', note),
    );
    return ownerJson(await assessmentState(ctx, task.id, snapshot), 200, ctx.headers);
  });
}

export async function DELETE(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    const task = await getCurriculumTask(ctx.queryable, ctx.ownerId, ctx.taskId);
    if (!task) return notFound(ctx);
    const removed = await ctx.write((tx) =>
      withdrawCurriculumDesignStep(tx, ctx.ownerId, ctx.taskId, 'assessment'),
    );
    if (!removed) {
      return ownerJson(
        {
          error: {
            code: 'CURRICULUM_DESIGN_NOT_FOUND',
            message: '题目与实操还没有确认，没有可撤回的确认',
          },
        },
        404,
        ctx.headers,
      );
    }
    const snapshot = await getCurriculumDesignSnapshot(ctx.queryable, ctx.ownerId, task.id);
    return ownerJson(await assessmentState(ctx, task.id, snapshot), 200, ctx.headers);
  });
}

function notFound(ctx: DesignContext) {
  return ownerJson(
    { error: { code: 'CURRICULUM_DESIGN_NOT_FOUND', message: '课程设计任务不存在' } },
    404,
    ctx.headers,
  );
}

/**
 * The optional `{ note }` on a confirm.
 *
 * The button sends no body at all, so an absent or unparseable body is not an
 * error here — it means "the user clicked". Being strict about it would turn the
 * simplest path (a click) into a 400 the caller has to work around.
 */
async function readNote(ctx: DesignContext) {
  try {
    const body = await ctx.body();
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const note = (body as { note?: unknown }).note;
      if (typeof note === 'string' && note.trim() !== '') {
        return note.trim().slice(0, MAX_NOTE_CHARS);
      }
    }
  } catch {
    // No body: the confirmation is still a confirmation.
  }
  return null;
}
