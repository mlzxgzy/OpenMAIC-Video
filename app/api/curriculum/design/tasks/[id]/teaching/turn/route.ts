/**
 * POST /api/curriculum/design/tasks/[id]/teaching/turn — one turn of the step-6
 * conversation, which writes each item's teaching script and storyboard.
 *
 * Step 6 is the step where "how it is taught" becomes data the generator reads
 * rather than prose it re-interprets. What makes that safe to write directly in
 * the turn is the deterministic half in `lib/curriculum/design-teaching.ts`:
 *
 * - **Only named items change, and within an item only named fields.** The model
 *   addresses items by `ref`; a change naming an item that does not exist is
 *   dropped and logged. Inside a plan, an absent field keeps its value and `[]`
 *   clears it — a model fixing one page must not erase the script beside it.
 * - **`nodes` and `objectives` are derived, not accepted.** They are the same fact
 *   as the four depth buckets, and the audit reads the derived one; two copies of
 *   one fact drift.
 * - **A storyboard that contradicts the script is refused, not written.** A page
 *   teaching something the script marked "out of scope", or a "teach in full"
 *   point no page carries, is the failure this step exists to catch — and it is
 *   invisible in the UI, where the script and the storyboard are two separate
 *   lists that each look complete.
 * - **Confirming is a rule, not the model's word** (`shouldConfirmTeaching`):
 *   not the first message, a turn that changed nothing cannot confirm, and any
 *   gap — including a lecture item with no storyboard — cannot confirm.
 *
 * Requires the task to have reached the `teaching` phase, so designing lessons
 * needs a confirmed outline. Same-origin JSON only, because the turn spends the
 * owner's model budget. 400 `MISSING_MODEL` when no model is configured; 502
 * `CURRICULUM_DESIGN_FAILED` when the answer is not a usable change — and then the
 * design is left exactly as it was.
 */
import { NextResponse, type NextRequest } from 'next/server';

import { createLogger } from '@/lib/logger';
import { isSameOriginJsonRequest } from '@/lib/persistence/owner-claim-http';
import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { curriculumJsonError } from '@/lib/server/curriculum/http';
import {
  designInvalid,
  runDesignRoute,
  type DesignContext,
} from '@/lib/server/curriculum/design-http';
import {
  confirmCurriculumDesignStep,
  getCurriculumDesignSnapshot,
  getCurriculumTask,
  updateCurriculumUnit,
} from '@/lib/server/curriculum/design-store';
import { parseConversationTurnRequest } from '@/lib/server/curriculum/design-validation';
import {
  teachingAuditFindings,
  teachingGapsOfSnapshot,
  teachingState,
} from '@/lib/server/curriculum/teaching-state';
import {
  TeachingAnswerError,
  draftCourseTeaching,
  formatDirectionLine,
  teachingBoardOf,
  type CourseTeachingTurn,
} from '@/lib/server/curriculum/teaching-step';
import {
  backgroundWorkspaceId,
  SlotDisabledError,
  SlotUnassignedError,
} from '@/lib/server/model-config/runtime';
import { resolveModel } from '@/lib/server/resolve-model';
import { shouldConfirmTeaching } from '@/lib/curriculum/design-teaching';
import {
  CURRICULUM_DESIGN_PHASES,
  type CurriculumDesignPhase,
} from '@/lib/curriculum/design-types';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

const log = createLogger('CourseTeaching');

/**
 * The stage this conversation generates with. Same choice as steps 1–5: this is
 * course design, and a new stage key is a cross-cutting configuration change
 * rather than a local decision.
 */
const TEACHING_STAGE = 'scene-outlines-stream';

/** The instruction is stored as the confirmation's note, so it is bounded. */
const MAX_NOTE_CHARS = 500;

export async function POST(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    if (!isSameOriginJsonRequest(req)) {
      return curriculumJsonError(
        403,
        'CURRICULUM_DESIGN_INVALID',
        '教学内容对话必须是同源 JSON 请求',
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
    // teaching phase must not spend the owner's budget and then fail on a write.
    // The store refuses these writes anyway (409); this is the same refusal, paid
    // for before the tokens.
    if (phaseRank(task.designPhase) < phaseRank('teaching')) {
      return curriculumJsonError(
        409,
        'CURRICULUM_DESIGN_PHASE_LOCKED',
        `课程任务当前处于「${task.designPhase}」阶段；先确认大纲并推进到「教学设计」阶段，再来写授课脚本与分镜`,
        ctx.headers,
      );
    }
    const parsed = parseConversationTurnRequest(await ctx.body());
    if (!parsed.ok) return designInvalid(parsed.message, ctx.headers);

    const model = await resolveTeachingModel(ctx);
    if ('response' in model) return model.response;

    const before = await getCurriculumDesignSnapshot(ctx.queryable, ctx.ownerId, task.id);
    const board = teachingBoardOf({
      units: before.units,
      coverage: before.unitCoverage,
      objectives: before.objectives
        .filter((row) => row.status !== 'archived')
        .map((row) => ({ id: row.id, title: row.title })),
      nodes: before.nodes,
      nodeObjectives: before.nodeObjectives,
    });

    // The gaps the model is asked to close: the step's own, plus the audit's
    // teaching findings, which is where "a lecture item has no storyboard" shows
    // up from the other side.
    const promptGaps = [
      ...teachingGapsOfSnapshot(before),
      ...teachingAuditFindings(before).map((finding) => ({ text: finding.message })),
    ];

    let turn;
    try {
      turn = await draftCourseTeaching(
        {
          direction: formatDirectionLine(task),
          board,
          history: parsed.value.history as CourseTeachingTurn[],
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
          '教学内容对话被取消',
          ctx.headers,
        );
      }
      if (error instanceof TeachingAnswerError) {
        log.warn(`Course teaching answer unusable: ${error.message}`);
        return curriculumJsonError(502, 'CURRICULUM_DESIGN_FAILED', error.message, ctx.headers);
      }
      throw error;
    }
    if (turn.unmatchedRefs.length > 0) {
      log.warn(`Course teaching answer named unknown refs: ${turn.unmatchedRefs.join(', ')}`);
    }
    if (turn.rejectedRefs.length > 0) {
      log.warn(`Course teaching answer carried unusable entries: ${turn.rejectedRefs.join('; ')}`);
    }

    const written = await ctx.write(async (tx) => {
      // Only the items the turn named are written. An item it did not mention
      // keeps its script and its storyboard — which is the whole reason the rules
      // layer computes a per-item patch rather than a whole-design replacement.
      for (const [unitId, patch] of turn.patches) {
        await updateCurriculumUnit(tx, ctx.ownerId, unitId, {
          teachingDesign: patch.teachingDesign,
          deckDesign: patch.deckDesign,
        });
      }

      // The sign-off is decided against what was written, in the same
      // transaction, so the confirmation can never cover a different document
      // than the one on disk.
      const after = await getCurriculumDesignSnapshot(tx, ctx.ownerId, task.id);
      const blockers = [
        ...teachingGapsOfSnapshot(after).map((gap) => gap.text),
        ...teachingAuditFindings(after).map((finding) => finding.message),
      ];
      const itemCount = after.units.filter((unit) => unit.unitType === 'item').length;
      // The verdict is re-decided against the document that was actually written,
      // in the same transaction — same rule as step 5. A confirmation recorded
      // outside the write could cover a different document than the one on disk.
      const confirmed = shouldConfirmTeaching({
        confirmRequested: turn.modelRequestedConfirm,
        userTurns: turn.userTurns,
        itemCount,
        gaps: blockers.map((text) => ({ text })),
        changedAnything: turn.changedAnything,
      });
      if (confirmed) {
        await confirmCurriculumDesignStep(
          tx,
          ctx.ownerId,
          task.id,
          'teaching',
          'assistant',
          parsed.value.instruction.slice(0, MAX_NOTE_CHARS),
        );
      }
      return { snapshot: after, confirmed, blockers };
    });

    // Only what could **not** be honoured goes here: the card renders these in a
    // warning color, and a success message in an amber box reads as a problem.
    // A recorded confirmation travels as `confirmedThisTurn` instead.
    const warnings = [...turn.unmatchedRefs, ...turn.rejectedRefs];
    if (turn.modelRequestedConfirm && !written.confirmed) {
      warnings.push(
        written.blockers.length > 0
          ? `这次没有记录确认：教学内容还有缺口（${written.blockers.join('；')}）`
          : '这次没有记录确认：这一轮没有改动，或还没有轮到可以确认的时候',
      );
    }

    const payload = await teachingState(ctx, task.id, written.snapshot);
    return ownerJson(
      { ...payload, message: turn.message, confirmedThisTurn: written.confirmed, warnings },
      200,
      ctx.headers,
    );
  });
}

/** The phase order, so "has this task reached teaching yet" reads as one line. */
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
async function resolveTeachingModel(
  ctx: DesignContext,
): Promise<{ value: Awaited<ReturnType<typeof resolveModel>> } | { response: NextResponse }> {
  try {
    return {
      value: await resolveModel({
        stage: TEACHING_STAGE,
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
