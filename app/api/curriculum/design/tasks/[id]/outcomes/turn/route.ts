/**
 * POST /api/curriculum/design/tasks/[id]/outcomes/turn — one turn of the step-2
 * conversation.
 *
 * Step 1 writes the brief; this writes the outcome list, and it writes it the way
 * the author asked for step 1: **directly, in the turn**. The list is built by the
 * model and lands in `curriculum_objective` / `curriculum_evidence` before the author
 * sees it, because the alternative — a proposal table the author has to promote — is
 * a second thing to keep in sync, and step 1 already showed the guard belongs
 * somewhere other than a proposal.
 *
 * What makes a list safe to write in the turn is not a proposal table but three
 * deterministic rules, all in `lib/curriculum/design-outcomes.ts`:
 *
 * - **Only named rows change.** The model addresses rows by `ref`; a change whose
 *   `ref` matches nothing is dropped and logged, never applied to a row the author
 *   did not mean. A list has no "field-wise patch" safety valve — the `ref` *is* the
 *   safety valve.
 * - **Confirming the step is a rule, not the model's word** (`shouldConfirmOutcomes`).
 *   The same two floors as step 1, plus one that only makes sense here: a turn that
 *   changed nothing cannot confirm. Agreement with nothing on the table is not a
 *   sign-off of that turn.
 * - **A draft without a behavior lands unverifiable; a piece of evidence without a
 *   check and a success condition is refused outright.** The asymmetry is
 *   deliberate — an outcome with no minimum bar is a visible "unverifiable" the
 *   author is meant to fill in, but an evidence row with nothing in it would satisfy
 *   the store's "every outcome has evidence" gate while proving nothing.
 *
 * A sign-off recorded here is `assistant` (the conversation concluded it); the
 * workbench's button records `user`, and the card says which.
 *
 * Requires the task to have reached the `outcomes` phase, so creating an outcome
 * needs a confirmed brief. Same-origin JSON only, because the turn spends the owner's
 * model budget. 400 `MISSING_MODEL` when no model is configured for this workspace;
 * 502 `CURRICULUM_DESIGN_FAILED` when the answer is not a usable list change — and
 * then the list is left exactly as it was.
 */
import { NextResponse, type NextRequest } from 'next/server';

import { createLogger } from '@/lib/logger';
import { isSameOriginJsonRequest } from '@/lib/persistence/owner-claim-http';
import type { EvidenceBinding, EvidenceDraft } from '@/lib/curriculum/design-outcomes';
import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { curriculumJsonError } from '@/lib/server/curriculum/http';
import {
  designInvalid,
  runDesignRoute,
  type DesignContext,
} from '@/lib/server/curriculum/design-http';
import {
  confirmCurriculumDesignStep,
  createCurriculumEvidence,
  createCurriculumObjective,
  deleteCurriculumObjective,
  getCurriculumTask,
  listCurriculumOutcomes,
  updateCurriculumObjective,
  type CurriculumEvidenceInput,
} from '@/lib/server/curriculum/design-store';
import { parseConversationTurnRequest } from '@/lib/server/curriculum/design-validation';
import { outcomesState } from '@/lib/server/curriculum/outcomes-state';
import {
  OutcomeAnswerError,
  boardOf,
  draftCourseOutcomes,
  formatDirectionLine,
  type CourseOutcomesTurn,
} from '@/lib/server/curriculum/outcomes-step';
import {
  backgroundWorkspaceId,
  SlotDisabledError,
  SlotUnassignedError,
} from '@/lib/server/model-config/runtime';
import { resolveModel } from '@/lib/server/resolve-model';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

const log = createLogger('CourseOutcomes');

/**
 * The stage this conversation generates with. It borrows the course-outline stage
 * for the same reason step 1 does (see that route): step 2 is course design, the
 * outline slot is the course-design model, and a new stage key is a cross-cutting
 * configuration change — model slot map, stage-to-slot route table, station-key
 * contract — rather than a local decision.
 */
const OUTCOMES_STAGE = 'scene-outlines-stream';

/** The instruction is stored as the confirmation's note, so it is bounded. */
const MAX_NOTE_CHARS = 500;

export async function POST(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    if (!isSameOriginJsonRequest(req)) {
      return curriculumJsonError(
        403,
        'CURRICULUM_DESIGN_INVALID',
        '学习目标对话必须是同源 JSON 请求',
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
    const parsed = parseConversationTurnRequest(await ctx.body());
    if (!parsed.ok) return designInvalid(parsed.message, ctx.headers);

    const model = await resolveOutcomesModel(ctx);
    if ('response' in model) return model.response;

    const before = await listCurriculumOutcomes(ctx.queryable, ctx.ownerId, task.id);
    const board = boardOf(before.objectives, before.evidence);

    let turn;
    try {
      turn = await draftCourseOutcomes(
        {
          direction: formatDirectionLine(task),
          board,
          history: parsed.value.history as CourseOutcomesTurn[],
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
          '学习目标对话被取消',
          ctx.headers,
        );
      }
      if (error instanceof OutcomeAnswerError) {
        log.warn(`Course outcomes answer unusable: ${error.message}`);
        return curriculumJsonError(502, 'CURRICULUM_DESIGN_FAILED', error.message, ctx.headers);
      }
      throw error;
    }
    if (turn.unmatchedRefs.length > 0) {
      log.warn(`Course outcomes answer named unknown refs: ${turn.unmatchedRefs.join(', ')}`);
    }
    if (turn.rejectedRefs.length > 0) {
      log.warn(`Course outcomes answer carried unusable entries: ${turn.rejectedRefs.join('; ')}`);
    }

    const written = await ctx.write(async (tx) => {
      // Deletions first: a patch or an evidence row aimed at an outcome this turn
      // deletes would otherwise be written and then swept away by the cascade,
      // which leaves a different outcome from the one the author asked for.
      for (const objectiveId of turn.removed) {
        await deleteCurriculumObjective(tx, ctx.ownerId, objectiveId);
      }
      let order = before.objectives.length;
      for (const draft of turn.added) {
        const objective = await createCurriculumObjective(tx, ctx.ownerId, task.id, {
          title: draft.title,
          objectiveType: draft.objectiveType,
          description: draft.description ?? null,
          expectedBehavior: draft.expectedBehavior,
          // Empty criteria are allowed on purpose: an outcome with no minimum bar
          // is a visible "unverifiable" the author is meant to fill in, and the
          // turn's own `gaps` say so. Rejecting the write would hide it instead.
          minCriteria: draft.minCriteria,
          sortOrder: order++,
        });
        for (const one of draft.evidence) {
          await createCurriculumEvidence(
            tx,
            ctx.ownerId,
            task.id,
            evidenceInput(objective.id, one),
          );
        }
      }
      for (const [objectiveId, patch] of turn.patches) {
        await updateCurriculumObjective(tx, ctx.ownerId, objectiveId, patch);
      }
      for (const { objectiveId, binding } of turn.evidence) {
        await createCurriculumEvidence(
          tx,
          ctx.ownerId,
          task.id,
          evidenceInput(objectiveId, binding),
        );
      }
      return listCurriculumOutcomes(tx, ctx.ownerId, task.id);
    });

    if (turn.confirmRequested) {
      await ctx.write((tx) =>
        confirmCurriculumDesignStep(
          tx,
          ctx.ownerId,
          task.id,
          'outcomes',
          'assistant',
          parsed.value.instruction.slice(0, MAX_NOTE_CHARS),
        ),
      );
    }

    const payload = await outcomesState(ctx, task.id, written.objectives, written.evidence);
    return ownerJson(
      { ...payload, message: turn.message, confirmedThisTurn: turn.confirmRequested },
      200,
      ctx.headers,
    );
  });
}

/**
 * One evidence draft as the store's input.
 *
 * Only the fields the step's rules decided. The thresholds are left to the store's
 * defaults: the parser has no evidence for inventing a number, and the author
 * revises them in the workbench where they can see what they mean.
 *
 * The parameter is a union because the two callers carry different shapes — a
 * draft on a new outcome has already-resolved fields, a binding on an existing one
 * has optionals — and both were already made concrete by the same parser. This
 * function is the one place that has to accept both, so it normalises once here
 * rather than at the two call sites.
 */
function evidenceInput(
  objectiveId: string,
  binding: EvidenceDraft | EvidenceBinding,
): CurriculumEvidenceInput {
  return {
    objectiveId,
    evidenceType: binding.evidenceType,
    verificationMethod: binding.verificationMethod,
    successCondition: binding.successCondition,
    assessmentMode: binding.assessmentMode ?? 'practice',
    hintPolicy: binding.hintPolicy ?? 'unlimited',
    independent: binding.independent ?? true,
  };
}

/**
 * The stage's model for this owner.
 *
 * A missing or disabled slot is a 400 the author can act on ("no model is
 * configured"), not a 500: the conversation is unavailable because of configuration,
 * and saying so is more useful than a stack trace.
 */
async function resolveOutcomesModel(
  ctx: DesignContext,
): Promise<{ value: Awaited<ReturnType<typeof resolveModel>> } | { response: NextResponse }> {
  try {
    return {
      value: await resolveModel({
        stage: OUTCOMES_STAGE,
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
