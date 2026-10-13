/**
 * POST /api/curriculum/design/tasks/[id]/assessment/turn — one turn of the step-7
 * conversation, which writes the questions and the lab tasks.
 *
 * Step 7 is where "how it is checked" becomes data the lab runner and the exam
 * paper read rather than prose a teacher re-interprets. What makes that safe to
 * write directly in the turn is the deterministic half in
 * `lib/curriculum/design-assessment.ts`:
 *
 * - **Artifacts are rows, not a document.** A question named by `ref` is updated in
 *   the fields it sends; a question without one is created; deletion is by id. A
 *   turn that fixes one stem does not touch the other nineteen.
 * - **The home is a claim, and it is checked.** Hanging a question on a chapter, on
 *   an item that never promised the outcome, or a lab on an item that only lectures
 *   is refused and reported — the row would otherwise look perfect in every list
 *   while the coverage loop never sees it.
 * - **`evidenceId` and `sortOrder` are derived, not accepted.** Evidence was signed
 *   in step 2 and this step does not move it; the question number is a property of
 *   the document, not of the model's answer.
 * - **Anything the store would refuse is refused here first.** The store rolls back
 *   the whole turn, and one question whose answer names a missing option must not
 *   take the other nine with it.
 * - **Confirming is a rule, not the model's word** (`shouldConfirmAssessment`):
 *   not the first message, a turn that changed nothing cannot confirm, and any gap
 *   cannot confirm.
 *
 * Requires the task to have reached the `assessment` phase, so authoring questions
 * needs a confirmed lesson design to check against. Same-origin JSON only, because
 * the turn spends the owner's model budget. 400 `MISSING_MODEL` when no model is
 * configured; 502 `CURRICULUM_DESIGN_FAILED` when the answer is not usable at all —
 * and then the design is left exactly as it was.
 */
import { NextResponse, type NextRequest } from 'next/server';

import { createLogger } from '@/lib/logger';
import { isSameOriginJsonRequest } from '@/lib/persistence/owner-claim-http';
import { assessmentBoardOf } from '@/lib/curriculum/design-assessment';
import {
  CURRICULUM_DESIGN_PHASES,
  type CurriculumDesignPhase,
} from '@/lib/curriculum/design-types';
import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import {
  assessmentBlockers,
  assessmentState,
} from '@/lib/server/curriculum/assessment-state';
import {
  AssessmentAnswerError,
  draftCourseAssessment,
  formatDirectionLine,
  type CourseAssessmentTurn,
} from '@/lib/server/curriculum/assessment-step';
import { curriculumJsonError } from '@/lib/server/curriculum/http';
import {
  designInvalid,
  runDesignRoute,
  type DesignContext,
} from '@/lib/server/curriculum/design-http';
import {
  confirmCurriculumDesignStep,
  createCurriculumLabTask,
  createCurriculumQuestion,
  deleteCurriculumLabTask,
  deleteCurriculumQuestion,
  getCurriculumDesignSnapshot,
  getCurriculumTask,
  updateCurriculumLabTask,
  updateCurriculumQuestion,
} from '@/lib/server/curriculum/design-store';
import { parseConversationTurnRequest } from '@/lib/server/curriculum/design-validation';
import { shouldConfirmAssessment } from '@/lib/curriculum/design-assessment';
import {
  backgroundWorkspaceId,
  SlotDisabledError,
  SlotUnassignedError,
} from '@/lib/server/model-config/runtime';
import { resolveModel } from '@/lib/server/resolve-model';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

const log = createLogger('CourseAssessment');

/**
 * The stage this conversation generates with. Same choice as steps 1–6: this is
 * course design, and a new stage key is a cross-cutting configuration change
 * rather than a local decision.
 */
const ASSESSMENT_STAGE = 'scene-outlines-stream';

/** The instruction is stored as the confirmation's note, so it is bounded. */
const MAX_NOTE_CHARS = 500;

export async function POST(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    if (!isSameOriginJsonRequest(req)) {
      return curriculumJsonError(
        403,
        'CURRICULUM_DESIGN_INVALID',
        '题目与实操对话必须是同源 JSON 请求',
        ctx.headers,
      );
    }
    const task = await getCurriculumTask(ctx.queryable, ctx.ownerId, ctx.taskId);
    if (!task) {
      return curriculumJsonError(
        404,
        'CURRICULUM_DESIGN_NOT_FOUND',
        '课程设计任务不存在',
        ctx.headers,
      );
    }
    // Checked before the model call, not after: a task that has not reached the
    // assessment phase must not spend the owner's budget and then fail on a write.
    // The store refuses these writes anyway (409); this is the same refusal, paid
    // for before the tokens.
    if (phaseRank(task.designPhase) < phaseRank('assessment')) {
      return curriculumJsonError(
        409,
        'CURRICULUM_DESIGN_PHASE_LOCKED',
        `课程任务当前处于「${task.designPhase}」阶段；先确认授课脚本与分镜并推进到「评价设计」阶段，再来写题目与实操`,
        ctx.headers,
      );
    }
    const parsed = parseConversationTurnRequest(await ctx.body());
    if (!parsed.ok) return designInvalid(parsed.message, ctx.headers);

    const model = await resolveAssessmentModel(ctx);
    if ('response' in model) return model.response;

    const before = await getCurriculumDesignSnapshot(ctx.queryable, ctx.ownerId, task.id);
    const board = assessmentBoardOf(before);

    // The gaps the model is asked to close: the step's own, plus the audit's
    // assessment findings, which is where "this evidence has no artifact" shows up
    // from the other side.
    const promptGaps = assessmentBlockers(before).map((text) => ({ text }));

    let turn;
    try {
      turn = await draftCourseAssessment(
        {
          direction: formatDirectionLine(task),
          board,
          design: before,
          history: parsed.value.history as CourseAssessmentTurn[],
          instruction: parsed.value.instruction,
          gaps: promptGaps,
          model: model.value,
        },
        { log, signal: req.signal },
      );
    } catch (error) {
      if (req.signal.aborted) {
        return curriculumJsonError(
          499,
          'CURRICULUM_DESIGN_FAILED',
          '题目与实操对话被取消',
          ctx.headers,
        );
      }
      if (error instanceof AssessmentAnswerError) {
        log.warn(`Course assessment answer unusable: ${error.message}`);
        return curriculumJsonError(502, 'CURRICULUM_DESIGN_FAILED', error.message, ctx.headers);
      }
      throw error;
    }
    if (turn.writes.rejectedRefs.length > 0) {
      log.warn(
        `Course assessment answer carried unusable entries: ${turn.writes.rejectedRefs.join('; ')}`,
      );
    }

    const written = await ctx.write(async (tx) => {
      // Six actions, all of them named. An artifact the turn did not mention keeps
      // its row — which is the whole reason the rules layer computes creations,
      // updates and removals separately rather than a whole-set replacement.
      for (const input of turn.writes.createQuestions) {
        await createCurriculumQuestion(tx, ctx.ownerId, task.id, input);
      }
      for (const update of turn.writes.updateQuestions) {
        await updateCurriculumQuestion(tx, ctx.ownerId, update.id, update.patch);
      }
      for (const id of turn.writes.removeQuestionIds) {
        await deleteCurriculumQuestion(tx, ctx.ownerId, id);
      }
      for (const input of turn.writes.createLabTasks) {
        await createCurriculumLabTask(tx, ctx.ownerId, task.id, input);
      }
      for (const update of turn.writes.updateLabTasks) {
        await updateCurriculumLabTask(tx, ctx.ownerId, update.id, update.patch);
      }
      for (const id of turn.writes.removeLabTaskIds) {
        await deleteCurriculumLabTask(tx, ctx.ownerId, id);
      }

      // The sign-off is decided against what was written, in the same transaction,
      // so the confirmation can never cover a different set of artifacts than the
      // one on disk.
      const after = await getCurriculumDesignSnapshot(tx, ctx.ownerId, task.id);
      const blockers = assessmentBlockers(after);
      const confirmed = shouldConfirmAssessment({
        confirmRequested: turn.modelRequestedConfirm,
        userTurns: turn.userTurns,
        gaps: blockers.map((text) => ({ text })),
        changedAnything: turn.changedAnything,
        artifactCount: after.questions.length + after.labTasks.length,
        itemCount: after.units.filter((unit) => unit.unitType === 'item').length,
      });
      if (confirmed) {
        await confirmCurriculumDesignStep(
          tx,
          ctx.ownerId,
          task.id,
          'assessment',
          'assistant',
          parsed.value.instruction.slice(0, MAX_NOTE_CHARS),
        );
      }
      return { snapshot: after, confirmed, blockers };
    });

    // Only what could **not** be honoured goes here: the card renders these in a
    // warning color, and a success message in an amber box reads as a problem.
    // A recorded confirmation travels as `confirmedThisTurn` instead.
    const warnings = [...turn.writes.rejectedRefs, ...turn.writes.advisories];
    if (turn.modelRequestedConfirm && !written.confirmed) {
      warnings.push(
        written.blockers.length > 0
          ? `这次没有记录确认：题目与实操还有缺口（${written.blockers.join('；')}）`
          : '这次没有记录确认：这一轮没有改动，或还没有轮到可以确认的时候',
      );
    }

    const payload = await assessmentState(ctx, task.id, written.snapshot);
    return ownerJson(
      { ...payload, message: turn.message, confirmedThisTurn: written.confirmed, warnings },
      200,
      ctx.headers,
    );
  });
}

/** The phase order, so "has this task reached assessment yet" reads as one line. */
function phaseRank(phase: CurriculumDesignPhase): number {
  return CURRICULUM_DESIGN_PHASES.indexOf(phase);
}

/**
 * The stage's model for this owner.
 *
 * A missing or disabled slot is a 400 the author can act on ("no model is
 * configured"), not a 500: the conversation is unavailable because of
 * configuration, and saying so is more useful than a stack trace.
 */
async function resolveAssessmentModel(
  ctx: DesignContext,
): Promise<{ value: Awaited<ReturnType<typeof resolveModel>> } | { response: NextResponse }> {
  try {
    return {
      value: await resolveModel({
        stage: ASSESSMENT_STAGE,
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
