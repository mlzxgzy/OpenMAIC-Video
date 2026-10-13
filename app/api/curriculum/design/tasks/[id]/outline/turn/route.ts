/**
 * POST /api/curriculum/design/tasks/[id]/outline/turn — one turn of the step-5
 * conversation.
 *
 * Step 5 is where the confirmed outcomes, the confirmed knowledge graph and the
 * ordering claims between them become a **document**: chapters, sections, items,
 * and for every item the outcomes it teaches, practises or assesses. This route
 * writes that document the way steps 1–3 were written — directly, in the turn,
 * with the safety in the deterministic rules rather than in a proposal table.
 *
 * The rules (`lib/curriculum/design-outline.ts`) are the place to read about the
 * decisions; two of them matter for reading this file:
 *
 * - **Units are independent rows, coverage is a whole-set replace.** The store's
 *   `setCurriculumUnitCoverage` deletes a task's entire ledger and rebuilds it, so
 *   this route passes **every** coverage row after the turn — the items the model
 *   named, replaced, plus every item it did not, carried over
 *   (`resolveOutlineTurn` computes that set). A route that sent only the mentioned
 *   items would strip the rest of the outline of everything it taught, and the
 *   payload would look perfectly normal.
 * - **Confirming is a rule, not the model's word, and it is decided against what
 *   was written.** The write and the sign-off happen in one transaction: the
 *   blockers are recomputed from the stored snapshot (the rules' gaps plus the
 *   audit's own unit-ordering findings), so the recorded confirmation always
 *   covers the document that is actually there. Steps 2 and 3 recorded their
 *   sign-off in a second transaction; this step does not need that window.
 *
 * Requires the task to have reached the `outline` phase, so building the outline
 * needs a confirmed graph. Same-origin JSON only, because the turn spends the
 * owner's model budget. 400 `MISSING_MODEL` when no model is configured; 502
 * `CURRICULUM_DESIGN_FAILED` when the answer is not a usable outline change — and
 * then the outline is left exactly as it was.
 */
import { NextResponse, type NextRequest } from 'next/server';

import {
  CURRICULUM_DESIGN_PHASES,
  type CurriculumDesignPhase,
} from '@/lib/curriculum/design-types';
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
  createCurriculumUnit,
  deleteCurriculumUnit,
  getCurriculumDesignSnapshot,
  getCurriculumTask,
  setCurriculumUnitCoverage,
  updateCurriculumUnit,
  type CurriculumUnitCoverageInput,
  type CurriculumUnitPatch,
} from '@/lib/server/curriculum/design-store';
import { parseConversationTurnRequest } from '@/lib/server/curriculum/design-validation';
import {
  OutlineAnswerError,
  draftCourseOutline,
  draftCoverageOf,
  formatDirectionLine,
  type CourseOutlineTurn,
} from '@/lib/server/curriculum/outline-step';
import { outlineBoardFromSnapshot } from '@/lib/server/curriculum/outline-board';
import {
  outlineAuditFindings,
  outlineGapsOfSnapshot,
  outlineState,
} from '@/lib/server/curriculum/outline-state';
import { shouldConfirmOutline } from '@/lib/curriculum/design-outline';
import {
  backgroundWorkspaceId,
  SlotDisabledError,
  SlotUnassignedError,
} from '@/lib/server/model-config/runtime';
import { resolveModel } from '@/lib/server/resolve-model';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

const log = createLogger('CourseOutline');

/**
 * The stage this conversation generates with. Same choice as steps 1–3: the
 * outline is course design, and a new stage key is a cross-cutting configuration
 * change rather than a local decision.
 */
const OUTLINE_STAGE = 'scene-outlines-stream';

/** The instruction is stored as the confirmation's note, so it is bounded. */
const MAX_NOTE_CHARS = 500;

export async function POST(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    if (!isSameOriginJsonRequest(req)) {
      return curriculumJsonError(
        403,
        'CURRICULUM_DESIGN_INVALID',
        '大纲对话必须是同源 JSON 请求',
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
    // outline phase must not spend the owner's budget and then fail on a write.
    // The store refuses these writes anyway (409); this is the same refusal, paid
    // for before the tokens.
    if (phaseRank(task.designPhase) < phaseRank('outline')) {
      return curriculumJsonError(
        409,
        'CURRICULUM_DESIGN_PHASE_LOCKED',
        `课程任务当前处于「${task.designPhase}」阶段；先确认知识技能图并推进到「大纲」阶段，再来排大纲`,
        ctx.headers,
      );
    }
    const parsed = parseConversationTurnRequest(await ctx.body());
    if (!parsed.ok) return designInvalid(parsed.message, ctx.headers);

    const model = await resolveOutlineModel(ctx);
    if ('response' in model) return model.response;

    const before = await getCurriculumDesignSnapshot(ctx.queryable, ctx.ownerId, task.id);
    // 读板搬到了 `outlineBoardFromSnapshot`：起草路由读的是同一份板，两边共用一份是因为
    // 抄一份的第一个后果就是两份"讲授顺序"在某次改动后不再一致，而那不会报错。
    const board = outlineBoardFromSnapshot({
      ...before,
      declaredHours: task.durationHours,
    });

    // The gaps the model is asked to close: the outline's own, plus the audit's
    // unit-ordering findings, which is where a declared item order shows up.
    const promptGaps = [
      ...outlineGapsOfSnapshot(before),
      ...outlineAuditFindings(before).map((finding) => ({ text: finding.message })),
    ];

    let turn;
    try {
      turn = await draftCourseOutline(
        {
          direction: formatDirectionLine(task),
          board,
          history: parsed.value.history as CourseOutlineTurn[],
          instruction: parsed.value.instruction,
          gaps: promptGaps,
          model: model.value,
        },
        { log, signal: req.signal },
      );
    } catch (error) {
      if (req.signal.aborted) {
        return curriculumJsonError(499, 'CURRICULUM_DESIGN_FAILED', '大纲对话被取消', ctx.headers);
      }
      if (error instanceof OutlineAnswerError) {
        log.warn(`Course outline answer unusable: ${error.message}`);
        return curriculumJsonError(502, 'CURRICULUM_DESIGN_FAILED', error.message, ctx.headers);
      }
      throw error;
    }

    const knownObjectiveIds = new Set(
      before.objectives.filter((row) => row.status !== 'archived').map((row) => row.id),
    );

    const written = await ctx.write(async (tx) => {
      // Deletions first: a patch or a coverage row aimed at a unit this turn
      // deletes would otherwise be written and then swept away by the cascade.
      for (const unitId of turn.removed) {
        await deleteCurriculumUnit(tx, ctx.ownerId, unitId);
      }

      // Creations, parents before children: `planUnitWrites` has already ordered
      // them so that a draft naming another draft as its parent is written after
      // it, which is what makes a forward reference safe.
      const createdIds = new Map<string, string>();
      const coverageRows: CurriculumUnitCoverageInput[] = [...turn.coverage];
      for (const create of turn.creates) {
        const unit = await createCurriculumUnit(tx, ctx.ownerId, task.id, {
          parentId:
            create.parentId ??
            (create.parentDraftRef === null
              ? null
              : (createdIds.get(create.parentDraftRef) ?? null)),
          unitType: create.draft.unitType,
          title: create.draft.title,
          unitRole: create.draft.unitRole,
          hours: create.draft.hours,
          orderIndex: create.orderIndex,
        });
        if (create.draft.ref !== null) createdIds.set(create.draft.ref, unit.id);
        for (const row of draftCoverageOf(create.draft, knownObjectiveIds)) {
          coverageRows.push({
            unitId: unit.id,
            objectiveId: row.objectiveId,
            coverageKind: row.coverageKind,
            depth: row.depth,
          });
        }
      }

      for (const update of turn.updates) {
        const patch: CurriculumUnitPatch = {};
        if (update.patch.title !== undefined) patch.title = update.patch.title;
        if (update.patch.unitRole !== undefined) patch.unitRole = update.patch.unitRole;
        if (update.patch.hours !== undefined) patch.hours = update.patch.hours;
        if (update.parentDraftRef !== null) {
          patch.parentId = createdIds.get(update.parentDraftRef) ?? null;
        } else if (update.parentId !== undefined) {
          patch.parentId = update.parentId;
        }
        if (update.orderIndex !== undefined) patch.orderIndex = update.orderIndex;
        await updateCurriculumUnit(tx, ctx.ownerId, update.unitId, patch);
      }

      // The coverage ledger: every item the turn touched (new ones included) plus
      // every item it did not, carried over. `turn.coverage` is already that set
      // for the units that existed; the new ones contributed just above.
      if (turn.changedCoverage || turn.creates.length > 0) {
        await setCurriculumUnitCoverage(tx, ctx.ownerId, task.id, coverageRows);
      }

      // The sign-off is decided against what was written, in the same
      // transaction, so the confirmation can never cover a different document
      // than the one on disk.
      const after = await getCurriculumDesignSnapshot(tx, ctx.ownerId, task.id);
      const blockers = [
        ...outlineGapsOfSnapshot(after).map((gap) => gap.text),
        ...outlineAuditFindings(after).map((finding) => finding.message),
      ];
      const itemCount = after.units.filter((unit) => unit.unitType === 'item').length;
      const confirmed = shouldConfirmOutline({
        confirmRequested: turn.modelRequestedConfirm,
        userTurns: turn.userTurns,
        itemCount,
        gaps: blockers,
        changedAnything: turn.changedAnything,
      });
      if (confirmed) {
        await confirmCurriculumDesignStep(
          tx,
          ctx.ownerId,
          task.id,
          'outline',
          'assistant',
          parsed.value.instruction.slice(0, MAX_NOTE_CHARS),
        );
      }
      return { snapshot: after, confirmed, blockers };
    });

    if (turn.unmatchedRefs.length > 0) {
      log.warn(`Course outline answer named unknown refs: ${turn.unmatchedRefs.join(', ')}`);
    }
    if (turn.rejectedRefs.length > 0) {
      log.warn(`Course outline answer carried unusable entries: ${turn.rejectedRefs.join('; ')}`);
    }

    // Only what could **not** be honoured goes here: the card renders these in a
    // warning color, and a success message in an amber box reads as a problem.
    // A recorded confirmation travels as `confirmedThisTurn` instead.
    const warnings = [...turn.unmatchedRefs, ...turn.rejectedRefs];
    if (turn.modelRequestedConfirm && !written.confirmed) {
      // The model claimed agreement on an outline the gate refuses. Saying so is
      // the difference between "the AI confirmed it" and "the AI thought it could
      // not be confirmed, and here is what is missing".
      warnings.push(
        written.blockers.length > 0
          ? `这次没有记录确认：大纲还有缺口（${written.blockers.join('；')}）`
          : '这次没有记录确认：这一轮没有改动，或还没有轮到可以确认的时候',
      );
    }

    const payload = await outlineState(ctx, task.id, written.snapshot);
    return ownerJson(
      { ...payload, message: turn.message, confirmedThisTurn: written.confirmed, warnings },
      200,
      ctx.headers,
    );
  });
}

/**
 * The teaching sequence of the confirmed graph, derived rather than stored.
 *
 * Only node → node edges describe the order knowledge is taught in; an edge with
 * an outcome endpoint is a plan-level claim that the outline itself reads.
 */
/** The phase order, so "has this task reached the outline yet" reads as one line. */
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
async function resolveOutlineModel(
  ctx: DesignContext,
): Promise<{ value: Awaited<ReturnType<typeof resolveModel>> } | { response: NextResponse }> {
  try {
    return {
      value: await resolveModel({
        stage: OUTLINE_STAGE,
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
