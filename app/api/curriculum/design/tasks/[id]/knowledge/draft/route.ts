/**
 * POST /api/curriculum/design/tasks/[id]/knowledge/draft — 起草，**一行都不写**。
 *
 * B2 试点时这条路由是手写的完整 handler，配一条"源码里没有 `ctx.write`"的测试来钉住那个
 * 承诺。现在它和其他四步一样走 {@link stepDraftRoute}，那条承诺由**类型**保证：骨架给的
 * 上下文里没有 `write`，加一次写库连编译都过不了。那条读源码的测试仍然在
 * （`tests/curriculum/knowledge-route.test.ts`），但它从"唯一的防线"降级成回归。
 */
import { createLogger } from '@/lib/logger';
import { knowledgeDraftOf } from '@/lib/curriculum/knowledge-draft-lines';
import {
  draftCourseKnowledge,
  formatDirectionLine,
  knowledgeBoardOf,
  KnowledgeAnswerError,
  type CourseKnowledgeResult,
} from '@/lib/server/curriculum/knowledge-step';
import { stepDraftRoute } from '@/lib/server/curriculum/step-draft-route';
import { getCurriculumDesignSnapshot } from '@/lib/server/curriculum/design-store';

export const runtime = 'nodejs';

const KNOWLEDGE_STAGE = 'scene-outlines-stream';

const log = createLogger('CourseKnowledgeDraft');

interface KnowledgeBefore {
  board: Parameters<typeof knowledgeDraftOf>[0]['board'];
  /**
   * 起草前那一刻的库。**不进回包**——回包只有 `draft`，因为右栏不自己读库这件事已经由
   * 「行的 body 由服务端算好」保证了：整表替换要在采纳那一刻重算的那部分，由引擎按
   * `StepCopilot` 拿到的 `live` 现算。这一份在这里只是"把图读一次、给起草和算行用同一份"。
   */
  snapshot: Awaited<ReturnType<typeof getCurriculumDesignSnapshot>>;
}

export const POST = stepDraftRoute<KnowledgeBefore, CourseKnowledgeResult>({
  step: 'knowledge',
  requiredPhase: 'graph',
  subject: '知识技能图起草',
  modelStage: KNOWLEDGE_STAGE,
  log,
  answerError: KnowledgeAnswerError,
  readBefore: async (ctx, taskId) => {
    const snapshot = await getCurriculumDesignSnapshot(ctx.queryable, ctx.ownerId, taskId);
    return {
      snapshot,
      board: {
        nodes: snapshot.nodes,
        objectives: snapshot.objectives,
        nodeObjectives: snapshot.nodeObjectives,
      },
    };
  },
  draft: async ({ ctx, before, model, log: stepLog, signal }) => {
    const turn = await draftCourseKnowledge(
      {
        direction: formatDirectionLine(ctx.task),
        board: knowledgeBoardOf(
          before.snapshot.nodes,
          before.snapshot.objectives,
          before.snapshot.nodeObjectives,
          before.snapshot.dependencies,
        ),
        history: ctx.history,
        instruction: ctx.instruction,
        model,
      },
      { log: stepLog, signal },
    );
    return turn;
  },
  shape: async ({ turn, before, taskId, instruction }) => ({
    draft: knowledgeDraftOf({
      turn,
      board: before.board,
      taskId,
      instruction,
    }),
  }),
});
