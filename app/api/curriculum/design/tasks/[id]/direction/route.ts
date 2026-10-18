/**
 * GET    /api/curriculum/design/tasks/[id]/direction — the card's sign-off state.
 * POST   /api/curriculum/design/tasks/[id]/direction — 用户确认课程方向.
 * DELETE /api/curriculum/design/tasks/[id]/direction — 撤回确认，重新打开这一步.
 *
 * The confirmation is what the phase machine reads before `task → outcomes`, and
 * this route is the half of it a person drives: the button on the card. The AI
 * conversation writes the card (`/design/direction`) and may record its own
 * confirmation as `assistant`; a confirmation recorded here is `user`, which is
 * the difference the card shows back ("你确认" vs "对话中确认").
 *
 * POST refuses an incomplete card on purpose. Confirming a card the store's own
 * gate would still reject produces a state where the user believes step 1 is
 * done and the advance button still says otherwise — the failure the whole
 * confirm-before-advance rule exists to prevent.
 */
import type { NextRequest } from 'next/server';

import {
  directionGaps,
  directionValuesOf,
  effectiveDirectionValues,
  type CurriculumDirectionValues,
} from '@/lib/curriculum/design-direction';
import { nextCurriculumDesignPhase } from '@/lib/curriculum/design-types';
import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import {
  designInvalid,
  runDesignRoute,
  type DesignContext,
} from '@/lib/server/curriculum/design-http';
import {
  confirmCurriculumDesignStep,
  getCurriculumDesignStepConfirmation,
  getCurriculumTask,
  getSeriesDirectionOfTask,
  phaseCompletionGaps,
  withdrawCurriculumDesignStep,
} from '@/lib/server/curriculum/design-store';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

/** The note is free text from the dialog; the column is not a log. */
const MAX_NOTE_CHARS = 500;

export async function GET(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    const task = await getCurriculumTask(ctx.queryable, ctx.ownerId, ctx.taskId);
    if (!task) {
      return ownerJson(
        { error: { code: 'CURRICULUM_DESIGN_NOT_FOUND', message: '课程设计任务不存在' } },
        404,
        ctx.headers,
      );
    }
    const seriesDirection = await getSeriesDirectionOfTask(ctx.queryable, ctx.ownerId, task);
    return ownerJson(
      await directionState(
        ctx,
        task.id,
        effectiveDirectionValues(directionValuesOf(task), seriesDirection),
      ),
      200,
      ctx.headers,
    );
  });
}

export async function POST(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    const task = await getCurriculumTask(ctx.queryable, ctx.ownerId, ctx.taskId);
    if (!task) {
      return ownerJson(
        { error: { code: 'CURRICULUM_DESIGN_NOT_FOUND', message: '课程设计任务不存在' } },
        404,
        ctx.headers,
      );
    }
    // 与门禁同一个有效值：目留空的受众 / 学时由系列方向回退。否则会出现
    // "系列填了受众、卡片不报缺、确认按钮却被这里拒掉"的分裂。
    const seriesDirection = await getSeriesDirectionOfTask(ctx.queryable, ctx.ownerId, task);
    const values = effectiveDirectionValues(directionValuesOf(task), seriesDirection);
    const gaps = directionGaps(values);
    if (gaps.length > 0) {
      return designInvalid(`课程方向还不完整，先补齐：${gaps.join('；')}`, ctx.headers);
    }

    const note = await readNote(ctx);
    await ctx.write((tx) =>
      confirmCurriculumDesignStep(tx, ctx.ownerId, ctx.taskId, 'task', 'user', note),
    );
    return ownerJson(await directionState(ctx, task.id, values), 200, ctx.headers);
  });
}

export async function DELETE(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    const task = await getCurriculumTask(ctx.queryable, ctx.ownerId, ctx.taskId);
    if (!task) {
      return ownerJson(
        { error: { code: 'CURRICULUM_DESIGN_NOT_FOUND', message: '课程设计任务不存在' } },
        404,
        ctx.headers,
      );
    }
    const removed = await ctx.write((tx) =>
      withdrawCurriculumDesignStep(tx, ctx.ownerId, ctx.taskId, 'task'),
    );
    if (!removed) {
      return ownerJson(
        {
          error: {
            code: 'CURRICULUM_DESIGN_NOT_FOUND',
            message: '课程方向还没有确认，没有可撤回的确认',
          },
        },
        404,
        ctx.headers,
      );
    }
    return ownerJson(await directionState(ctx, task.id, directionValuesOf(task)), 200, ctx.headers);
  });
}

/**
 * The step's state, in the shape both the card and the phase header read.
 *
 * `phaseGaps` is the authoritative blocker list — it merges the card's own gaps
 * with the missing confirmation — while `gaps` names only the empty slots, which
 * is what the card needs in order to mark them.
 */
async function directionState(
  ctx: DesignContext,
  taskId: string,
  values: CurriculumDirectionValues,
) {
  const confirmation = await getCurriculumDesignStepConfirmation(
    ctx.queryable,
    ctx.ownerId,
    taskId,
    'task',
  );
  const task = await getCurriculumTask(ctx.queryable, ctx.ownerId, taskId);
  const next = task ? nextCurriculumDesignPhase(task.designPhase) : null;
  const phaseGaps = next ? await phaseCompletionGaps(ctx.queryable, ctx.ownerId, taskId, next) : [];
  return {
    values,
    gaps: directionGaps(values),
    confirmation,
    confirmed: confirmation !== null,
    nextPhase: next,
    phaseGaps,
    readyToAdvance: next !== null && phaseGaps.length === 0,
  };
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
