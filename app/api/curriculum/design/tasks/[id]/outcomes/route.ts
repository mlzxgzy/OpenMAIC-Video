/**
 * GET    /api/curriculum/design/tasks/[id]/outcomes — the list's sign-off state.
 * POST   /api/curriculum/design/tasks/[id]/outcomes — 用户确认学习目标与考核标准.
 * DELETE /api/curriculum/design/tasks/[id]/outcomes — 撤回确认，重新打开这一步.
 *
 * The confirmation is what the phase machine reads before `outcomes → graph`, and
 * this route is the half a person drives: the button on the workbench card. The AI
 * conversation writes the list (`.../outcomes/turn`) and may record its own
 * confirmation as `assistant`; one recorded here is `user` — the difference the card
 * shows back ("你已确认" vs "对话中确认").
 *
 * POST refuses an incomplete list on purpose, for the same reason step 1 does:
 * confirming a list the store's own gate would still reject produces a state where
 * the author believes step 2 is done while the advance button still says otherwise.
 *
 * `DELETE` answers 404 when there was nothing to withdraw rather than pretending it
 * succeeded, so a double-click cannot look like a sign-off.
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
  getCurriculumTask,
  listCurriculumOutcomes,
  withdrawCurriculumDesignStep,
} from '@/lib/server/curriculum/design-store';
import { outcomeGapsOfRecords } from '@/lib/curriculum/design-outcomes';
import { outcomesState } from '@/lib/server/curriculum/outcomes-state';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

/** The note is free text from the dialog; the column is not a log. */
const MAX_NOTE_CHARS = 500;

export async function GET(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    const task = await getCurriculumTask(ctx.queryable, ctx.ownerId, ctx.taskId);
    if (!task) return notFound(ctx);
    const { objectives, evidence } = await listCurriculumOutcomes(
      ctx.queryable,
      ctx.ownerId,
      task.id,
    );
    return ownerJson(await outcomesState(ctx, task.id, objectives, evidence), 200, ctx.headers);
  });
}

export async function POST(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    const task = await getCurriculumTask(ctx.queryable, ctx.ownerId, ctx.taskId);
    if (!task) return notFound(ctx);
    const { objectives, evidence } = await listCurriculumOutcomes(
      ctx.queryable,
      ctx.ownerId,
      task.id,
    );
    const gaps = outcomeGapsOfRecords(objectives, evidence);
    if (gaps.length > 0) {
      return designInvalid(
        `学习目标还不完整，先补齐：${gaps.map((gap) => gap.text).join('；')}`,
        ctx.headers,
      );
    }
    const note = await readNote(ctx);
    await ctx.write((tx) =>
      confirmCurriculumDesignStep(tx, ctx.ownerId, ctx.taskId, 'outcomes', 'user', note),
    );
    return ownerJson(await outcomesState(ctx, task.id, objectives, evidence), 200, ctx.headers);
  });
}

export async function DELETE(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    const task = await getCurriculumTask(ctx.queryable, ctx.ownerId, ctx.taskId);
    if (!task) return notFound(ctx);
    const removed = await ctx.write((tx) =>
      withdrawCurriculumDesignStep(tx, ctx.ownerId, ctx.taskId, 'outcomes'),
    );
    if (!removed) {
      return ownerJson(
        {
          error: {
            code: 'CURRICULUM_DESIGN_NOT_FOUND',
            message: '学习目标与考核标准还没有确认，没有可撤回的确认',
          },
        },
        404,
        ctx.headers,
      );
    }
    const { objectives, evidence } = await listCurriculumOutcomes(
      ctx.queryable,
      ctx.ownerId,
      task.id,
    );
    return ownerJson(await outcomesState(ctx, task.id, objectives, evidence), 200, ctx.headers);
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
 * The button sends no body at all, so an absent or unparseable body is not an error
 * here — it means "the user clicked". Being strict about it would turn the simplest
 * path (a click) into a 400 the caller has to work around.
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
