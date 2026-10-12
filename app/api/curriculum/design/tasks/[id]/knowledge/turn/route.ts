/**
 * POST /api/curriculum/design/tasks/[id]/knowledge/turn — one turn of the step-3
 * conversation.
 *
 * Step 1 writes the brief and step 2 writes the outcome list; this writes the
 * **graph**, and it writes it the way the author asked for both: directly, in the
 * turn. What makes a graph safe to write in the turn is not a proposal table but
 * the deterministic rules in `lib/curriculum/design-knowledge.ts`:
 *
 * - **Only named rows change, and links merge per node.** The model addresses
 *   nodes by `ref` and goals by id; a change naming something that does not exist
 *   is dropped and logged. Links are the delicate part: the store's
 *   `setCurriculumNodeObjectives` replaces a task's whole link set, so this route
 *   passes **every** link after the turn — the nodes the model named replaced, the
 *   rest carried over (`resolveKnowledgeTurn` computes that set, and it is the
 *   only place the difference is decided). A route that sent only the mentioned
 *   nodes would silently empty the rest of the graph.
 * - **Confirming the step is a rule, not the model's word** (`shouldConfirmKnowledge`):
 *   not the first user message, a turn that changed nothing cannot confirm, and a
 *   graph with any gap — at either end — cannot be confirmed.
 * - **A node with no link is accepted** (it is the visible "graph not finished"
 *   state the store's orphan check reports), while a link to an outcome that does
 *   not exist is refused and logged, because it is a mistyped reference the author
 *   should see rather than a silent gap.
 *
 * Requires the task to have reached the `graph` phase, so building nodes needs
 * confirmed outcomes. Same-origin JSON only, because the turn spends the owner's
 * model budget. 400 `MISSING_MODEL` when no model is configured; 502
 * `CURRICULUM_DESIGN_FAILED` when the answer is not a usable graph change — and
 * then the graph is left exactly as it was.
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
  createCurriculumLearningNode,
  deleteCurriculumLearningNode,
  getCurriculumDesignSnapshot,
  getCurriculumTask,
  setCurriculumNodeObjectives,
  updateCurriculumLearningNode,
  type CurriculumNodeObjectiveInput,
} from '@/lib/server/curriculum/design-store';
import { parseConversationTurnRequest } from '@/lib/server/curriculum/design-validation';
import { knowledgeState } from '@/lib/server/curriculum/knowledge-state';
import {
  KnowledgeAnswerError,
  draftCourseKnowledge,
  draftLinksOf,
  formatDirectionLine,
  knowledgeBoardOf,
  type CourseKnowledgeTurn,
} from '@/lib/server/curriculum/knowledge-step';
import {
  backgroundWorkspaceId,
  SlotDisabledError,
  SlotUnassignedError,
} from '@/lib/server/model-config/runtime';
import { resolveModel } from '@/lib/server/resolve-model';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

const log = createLogger('CourseKnowledge');

/**
 * The stage this conversation generates with. It borrows the course-outline stage
 * for the same reason steps 1 and 2 do: step 3 is course design, the outline slot
 * is the course-design model, and a new stage key is a cross-cutting configuration
 * change rather than a local decision.
 */
const KNOWLEDGE_STAGE = 'scene-outlines-stream';

/** The instruction is stored as the confirmation's note, so it is bounded. */
const MAX_NOTE_CHARS = 500;

export async function POST(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    if (!isSameOriginJsonRequest(req)) {
      return curriculumJsonError(
        403,
        'CURRICULUM_DESIGN_INVALID',
        '知识技能图对话必须是同源 JSON 请求',
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

    const model = await resolveKnowledgeModel(ctx);
    if ('response' in model) return model.response;

    const before = await getCurriculumDesignSnapshot(ctx.queryable, ctx.ownerId, task.id);
    const board = knowledgeBoardOf(before.nodes, before.objectives, before.nodeObjectives);

    let turn;
    try {
      turn = await draftCourseKnowledge(
        {
          direction: formatDirectionLine(task),
          board,
          history: parsed.value.history as CourseKnowledgeTurn[],
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
          '知识技能图对话被取消',
          ctx.headers,
        );
      }
      if (error instanceof KnowledgeAnswerError) {
        log.warn(`Course knowledge answer unusable: ${error.message}`);
        return curriculumJsonError(502, 'CURRICULUM_DESIGN_FAILED', error.message, ctx.headers);
      }
      throw error;
    }
    if (turn.unmatchedRefs.length > 0) {
      log.warn(`Course knowledge answer named unknown refs: ${turn.unmatchedRefs.join(', ')}`);
    }
    if (turn.rejectedRefs.length > 0) {
      log.warn(`Course knowledge answer carried unusable entries: ${turn.rejectedRefs.join('; ')}`);
    }

    const written = await ctx.write(async (tx) => {
      // Deletions first: a link or patch aimed at a node this turn deletes would
      // otherwise be written and then swept away by the cascade.
      for (const nodeId of turn.removed) {
        await deleteCurriculumLearningNode(tx, ctx.ownerId, nodeId);
      }
      let order = before.nodes.length;
      const nodeIdOf: string[] = [];
      for (const draft of turn.added) {
        const node = await createCurriculumLearningNode(tx, ctx.ownerId, task.id, {
          name: draft.name,
          nodeType: draft.nodeType,
          summary: draft.summary,
          difficulty: draft.difficulty,
          sortOrder: order++,
        });
        nodeIdOf.push(node.id);
      }
      for (const [nodeId, patch] of turn.patches) {
        await updateCurriculumLearningNode(tx, ctx.ownerId, nodeId, patch);
      }
      // The link set: every node the turn touched (new ones included) plus every
      // node it did not, carried over. `turn.links` is already that set.
      const links: CurriculumNodeObjectiveInput[] = [
        ...turn.links,
        ...turn.added.flatMap((draft, index) => {
          const nodeId = nodeIdOf[index];
          if (nodeId === undefined) return [];
          return draftLinksOf(draft, new Set(before.objectives.map((row) => row.id))).map(
            (link) => ({
              nodeId,
              objectiveId: link.objectiveRef,
              supportLevel: link.supportLevel,
              note: link.note ?? null,
            }),
          );
        }),
      ];
      if (turn.changedLinks) {
        await setCurriculumNodeObjectives(tx, ctx.ownerId, task.id, links);
      }
      const snapshot = await getCurriculumDesignSnapshot(tx, ctx.ownerId, task.id);
      return snapshot;
    });

    if (turn.confirmRequested) {
      await ctx.write((tx) =>
        confirmCurriculumDesignStep(
          tx,
          ctx.ownerId,
          task.id,
          'graph',
          'assistant',
          parsed.value.instruction.slice(0, MAX_NOTE_CHARS),
        ),
      );
    }

    const payload = await knowledgeState(
      ctx,
      task.id,
      written.nodes,
      written.nodeObjectives,
      written.objectives,
    );
    return ownerJson(
      { ...payload, message: turn.message, confirmedThisTurn: turn.confirmRequested },
      200,
      ctx.headers,
    );
  });
}

/**
 * The stage's model for this owner.
 *
 * A missing or disabled slot is a 400 the author can act on ("no model is
 * configured"), not a 500: the conversation is unavailable because of
 * configuration, and saying so is more useful than a stack trace.
 */
async function resolveKnowledgeModel(
  ctx: DesignContext,
): Promise<{ value: Awaited<ReturnType<typeof resolveModel>> } | { response: NextResponse }> {
  try {
    return {
      value: await resolveModel({
        stage: KNOWLEDGE_STAGE,
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
