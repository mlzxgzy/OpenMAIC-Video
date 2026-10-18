/**
 * POST /api/curriculum/design/direction — one turn of the step-1 conversation.
 *
 * Body: `{ taskId?, instruction, history? }`. The answer is the model's message,
 * the slots it wrote, and the resulting card. Unlike outline revision, the write
 * happens **here**: the author asked for the AI to fill and change the course
 * direction directly, so there is no second confirmation screen between the model
 * and the row. Two things keep that safe:
 *
 * - **Only seven slots exist** (`CURRICULUM_DIRECTION_KEYS`), and the model's
 *   unknown keys are dropped rather than stored.
 * - **The step's confirmation is gated by a rule, not by the model's word**
 *   (`shouldConfirmDirection`: not on the first turn, never on an incomplete
 *   card). A confirmation granted here is recorded as `assistant`, so the card
 *   can still say who signed off.
 *
 * The task is created on the first turn that produces a title; before that there
 * is no row to write to, and the card exists only in the dialog. That is a
 * database constraint (`curriculum_task.title` is NOT NULL), not a policy: the
 * turn that names the course creates the row, and every later turn edits it.
 *
 * Same-origin JSON only — the call spends the owner's model budget. 400
 * `MISSING_MODEL` when no outline model is configured for this workspace; 502
 * `CURRICULUM_DESIGN_FAILED` when the model's answer is not a usable card change
 * (the card is left exactly as it was).
 */
import { NextResponse, type NextRequest } from 'next/server';

import { createLogger } from '@/lib/logger';
import { isSameOriginJsonRequest } from '@/lib/persistence/owner-claim-http';
import {
  directionGaps,
  directionValuesOf,
  effectiveDirectionValues,
  type CurriculumDirectionValues,
} from '@/lib/curriculum/design-direction';
import {
  nextCurriculumDesignPhase,
  type CurriculumTaskRecord,
} from '@/lib/curriculum/design-types';
import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { curriculumJsonError } from '@/lib/server/curriculum/http';
import {
  designInvalid,
  runDesignRoute,
  type DesignContext,
} from '@/lib/server/curriculum/design-http';
import {
  confirmCurriculumDesignStep,
  createCurriculumTask,
  getCurriculumDesignStepConfirmation,
  getCurriculumTask,
  getSeriesDirectionOfTask,
  listCurriculumDesignConfirmations,
  phaseCompletionGaps,
  updateCurriculumTask,
  type CurriculumTaskInput,
} from '@/lib/server/curriculum/design-store';
import { parseConversationTurnRequest } from '@/lib/server/curriculum/design-validation';
import { DirectionAnswerError, draftCourseDirection } from '@/lib/server/curriculum/direction-step';
import {
  backgroundWorkspaceId,
  SlotDisabledError,
  SlotUnassignedError,
} from '@/lib/server/model-config/runtime';
import { resolveModel } from '@/lib/server/resolve-model';

export const runtime = 'nodejs';

const log = createLogger('CourseDirection');

/**
 * The stage this conversation generates with.
 *
 * It borrows the course-outline stage rather than minting a new one. A new stage
 * key is not a local decision in this codebase: it has to be added to the model
 * slot map, the stage-to-slot route table and the station-key contract, and then
 * configured. Step 1 is course design, the outline slot is the course-design
 * model, and the author can override it per station if they want — so the
 * borrowing is the honest choice, and it is stated here rather than left for
 * someone to discover from a stack trace.
 */
const DIRECTION_STAGE = 'scene-outlines-stream';

/** An empty card, for the turns before the task exists. */
const EMPTY_DIRECTION: CurriculumDirectionValues = {
  title: null,
  audience: null,
  learnerLevel: null,
  trainingScenario: null,
  durationHours: null,
  applicationScene: null,
  problemStatement: null,
};

export async function POST(req: NextRequest) {
  return runDesignRoute(req, undefined, async (ctx) => {
    if (!isSameOriginJsonRequest(req)) {
      return curriculumJsonError(
        403,
        'CURRICULUM_DESIGN_INVALID',
        '课程方向对话必须是同源 JSON 请求',
        ctx.headers,
      );
    }
    const parsed = parseConversationTurnRequest(await ctx.body());
    if (!parsed.ok) return designInvalid(parsed.message, ctx.headers);

    const model = await resolveDirectionModel(ctx);
    if ('response' in model) return model.response;

    const existing = parsed.value.taskId
      ? await getCurriculumTask(ctx.queryable, ctx.ownerId, parsed.value.taskId)
      : null;
    if (parsed.value.taskId && !existing) {
      return curriculumJsonError(
        404,
        'CURRICULUM_DESIGN_NOT_FOUND',
        '课程设计任务不存在',
        ctx.headers,
      );
    }
    // 模型看到的是**有效值**：目留空的受众 / 学时由系列方向回退。这样它不会把
    // "系列已经定好的受众"当成空白再问一遍，也不会在用户说"确认"时判定卡片不全。
    const seriesDirection = existing
      ? await getSeriesDirectionOfTask(ctx.queryable, ctx.ownerId, existing)
      : null;
    const before = existing
      ? effectiveDirectionValues(directionValuesOf(existing), seriesDirection)
      : EMPTY_DIRECTION;
    const beforeConfirmation = existing
      ? await getCurriculumDesignStepConfirmation(ctx.queryable, ctx.ownerId, existing.id, 'task')
      : null;

    let turn;
    try {
      turn = await draftCourseDirection(
        {
          values: before,
          confirmedBy: beforeConfirmation?.confirmedBy ?? null,
          history: parsed.value.history,
          instruction: parsed.value.instruction,
          model: model.value,
        },
        { log, signal: req.signal },
      );
    } catch (error) {
      if (req.signal.aborted) {
        return curriculumJsonError(
          499,
          'CURRICULUM_DESIGN_FAILED',
          '课程方向对话被取消',
          ctx.headers,
        );
      }
      if (error instanceof DirectionAnswerError) {
        log.warn(`Course direction answer unusable: ${error.message}`);
        return curriculumJsonError(502, 'CURRICULUM_DESIGN_FAILED', error.message, ctx.headers);
      }
      throw error;
    }
    if (turn.rejectedKeys.length > 0) {
      log.warn(`Course direction answer carried unknown keys: ${turn.rejectedKeys.join(', ')}`);
    }

    const written = await ctx.write(async (tx) => {
      const patch = directionPatch(turn.fields);
      if (!existing) {
        // No title, no row. The model is told to propose one; when it has not,
        // the dialog shows the partial card and asks for it instead of creating
        // a course called "未命名".
        if (!patch.title) return null;
        // The series a new task joins comes from the request, not from the
        // model: the cockpit's 「新建目」 link carries it, and the model has no
        // way to know it. An existing task is never moved here — this route
        // also revises tasks, and a revision must not relocate one.
        const seed = parsed.value.seriesId ? { seriesId: parsed.value.seriesId } : {};
        return createCurriculumTask(tx, ctx.ownerId, { ...seed, ...patch } as CurriculumTaskInput);
      }
      if (Object.keys(patch).length > 0) {
        await updateCurriculumTask(tx, ctx.ownerId, existing.id, patch);
      }
      return getCurriculumTask(tx, ctx.ownerId, existing.id);
    });

    // A confirmation is only ever recorded against a row that exists — which,
    // for a complete card, always does: a title is one of the required slots.
    if (turn.confirmRequested && written) {
      await ctx.write((tx) =>
        confirmCurriculumDesignStep(
          tx,
          ctx.ownerId,
          written.id,
          'task',
          'assistant',
          truncate(parsed.value.instruction),
        ),
      );
    }

    const values = written
      ? effectiveDirectionValues(directionValuesOf(written), seriesDirection)
      : { ...before, ...turn.fields };
    return ownerJson(
      await directionPayload(
        ctx,
        written,
        values,
        turn.message,
        turn.confirmRequested && Boolean(written),
      ),
      200,
      ctx.headers,
    );
  });
}

/** The model's answer as a store patch. */
function directionPatch(fields: Partial<CurriculumDirectionValues>): Partial<CurriculumTaskInput> {
  const patch: Partial<CurriculumTaskInput> = {};
  for (const [key, value] of Object.entries(fields)) {
    // `title` is NOT NULL in the table: a null title is not a clearable slot, and
    // passing it on would turn "the model did not name the course" into a 400.
    if (key === 'title' && value === null) continue;
    (patch as Record<string, unknown>)[key] = value;
  }
  return patch;
}

/**
 * The card, its gaps, its confirmation state and where the design could go next.
 *
 * `readyToAdvance` comes from the store's own `phaseCompletionGaps`, not from
 * `directionGaps`: the card being complete is necessary but not sufficient — the
 * confirmation is the other half — and a dialog that computed readiness itself
 * would drift from the gate the moment either changed.
 */
async function directionPayload(
  ctx: DesignContext,
  task: CurriculumTaskRecord | null,
  values: CurriculumDirectionValues,
  message: string,
  confirmedThisTurn: boolean,
) {
  const gaps = directionGaps(values);
  const confirmation = task
    ? ((await listCurriculumDesignConfirmations(ctx.queryable, ctx.ownerId, task.id)).find(
        (entry) => entry.step === 'task',
      ) ?? null)
    : null;
  const next = task ? nextCurriculumDesignPhase(task.designPhase) : null;
  const phaseGaps =
    task && next ? await phaseCompletionGaps(ctx.queryable, ctx.ownerId, task.id, next) : gaps;
  return {
    task,
    message,
    values,
    gaps,
    confirmation,
    confirmed: confirmation !== null,
    confirmedThisTurn,
    nextPhase: next,
    phaseGaps,
    readyToAdvance: next !== null && phaseGaps.length === 0,
  };
}

/** The instruction is stored as the confirmation's note, so it is bounded. */
function truncate(text: string): string {
  return text.length > 500 ? `${text.slice(0, 497)}...` : text;
}

/**
 * The stage's model for this owner.
 *
 * A missing or disabled slot is a 400 the author can act on ("no model is
 * configured"), not a 500: the conversation is unavailable because of
 * configuration, and saying so is more useful than a stack trace.
 */
async function resolveDirectionModel(
  ctx: DesignContext,
): Promise<{ value: Awaited<ReturnType<typeof resolveModel>> } | { response: NextResponse }> {
  try {
    return {
      value: await resolveModel({
        stage: DIRECTION_STAGE,
        workspaceId: await backgroundWorkspaceId(ctx.ownerId),
      }),
    };
  } catch (error) {
    if (error instanceof SlotUnassignedError || error instanceof SlotDisabledError) {
      return {
        response: curriculumJsonError(
          400,
          'MISSING_MODEL',
          '没有为课程设计配置语言模型',
          ctx.headers,
        ),
      };
    }
    throw error;
  }
}
