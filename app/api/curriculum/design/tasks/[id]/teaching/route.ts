/**
 * GET    /api/curriculum/design/tasks/[id]/teaching — 教学设计的签收状态.
 * POST   /api/curriculum/design/tasks/[id]/teaching — 作者确认授课脚本与分镜.
 * DELETE /api/curriculum/design/tasks/[id]/teaching — 撤回确认，重新打开这一步.
 *
 * The same three verbs as the four state routes before it, and the same reasoning:
 * the confirmation is what the phase machine reads before `teaching → assessment`,
 * this route is the half a person drives, and the AI conversation writes the
 * scripts and storyboards (`.../teaching/turn`) and may record its own
 * confirmation as `assistant`.
 *
 * POST refuses an incomplete design on purpose, and what "incomplete" means here
 * is the point of the step: every item has to say what it teaches and how deep,
 * every `lecture` item has to have a storyboard, and the storyboard may not
 * contradict the script — a page carrying something the script marked "out of
 * scope", or a "teach in full" point no page carries. Confirming with any of
 * those open produces a state where the author believes the lesson is designed
 * while the generator is handed a plan that answers a different lesson.
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
import { teachingBlockers, teachingState } from '@/lib/server/curriculum/teaching-state';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

/** The note is free text from the dialog; the column is not a log. */
const MAX_NOTE_CHARS = 500;

export async function GET(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    const task = await getCurriculumTask(ctx.queryable, ctx.ownerId, ctx.taskId);
    if (!task) return notFound(ctx);
    const snapshot = await getCurriculumDesignSnapshot(ctx.queryable, ctx.ownerId, task.id);
    return ownerJson(await teachingState(ctx, task.id, snapshot), 200, ctx.headers);
  });
}

export async function POST(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    const task = await getCurriculumTask(ctx.queryable, ctx.ownerId, ctx.taskId);
    if (!task) return notFound(ctx);
    const snapshot = await getCurriculumDesignSnapshot(ctx.queryable, ctx.ownerId, task.id);
    const blockers = teachingBlockers(snapshot);
    if (blockers.length > 0) {
      return designInvalid(`教学内容还不完整，先补齐：${blockers.join('；')}`, ctx.headers);
    }
    const note = await readNote(ctx);
    await ctx.write((tx) =>
      confirmCurriculumDesignStep(tx, ctx.ownerId, ctx.taskId, 'teaching', 'user', note),
    );
    return ownerJson(await teachingState(ctx, task.id, snapshot), 200, ctx.headers);
  });
}

export async function DELETE(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    const task = await getCurriculumTask(ctx.queryable, ctx.ownerId, ctx.taskId);
    if (!task) return notFound(ctx);
    const removed = await ctx.write((tx) =>
      withdrawCurriculumDesignStep(tx, ctx.ownerId, ctx.taskId, 'teaching'),
    );
    if (!removed) {
      return ownerJson(
        {
          error: {
            code: 'CURRICULUM_DESIGN_NOT_FOUND',
            message: '教学内容还没有确认，没有可撤回的确认',
          },
        },
        404,
        ctx.headers,
      );
    }
    const snapshot = await getCurriculumDesignSnapshot(ctx.queryable, ctx.ownerId, task.id);
    return ownerJson(await teachingState(ctx, task.id, snapshot), 200, ctx.headers);
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
