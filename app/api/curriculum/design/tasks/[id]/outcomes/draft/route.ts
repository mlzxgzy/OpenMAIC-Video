/**
 * POST /api/curriculum/design/tasks/[id]/outcomes/draft — 起草，**一行都不写**。
 *
 * 骨架全部来自 {@link stepDraftRoute}；这个文件只提供两样领域特有的东西：**起草前读什么**
 * （`readBefore`）与**这一轮的结果怎么算成行**（`shape`）。
 *
 * 骨架的上下文里没有 `write`，所以"草稿不落库"不靠这个文件自觉——加一次 `ctx.write`
 * 连编译都过不了。
 */
import { createLogger } from '@/lib/logger';
import { listCurriculumOutcomes } from '@/lib/server/curriculum/design-store';
import {
  boardOf,
  draftCourseOutcomes,
  formatDirectionLine,
  OutcomeAnswerError,
  type CourseOutcomesResult,
  type CourseOutcomesTurn,
  type OutcomesBoard,
} from '@/lib/server/curriculum/outcomes-step';
import { stepDraftRoute } from '@/lib/server/curriculum/step-draft-route';
import { outcomesDraftOf } from '@/lib/curriculum/outcomes-draft';

export const runtime = 'nodejs';

/** 借用大纲阶段的模型，与 `outcomes/turn` 路由同一个 slot，理由也相同。 */
const OUTCOMES_STAGE = 'scene-outlines-stream';

const log = createLogger('CourseOutcomesDraft');

interface Before {
  board: OutcomesBoard;
  objectives: readonly { id: string; title: string }[];
}

export const POST = stepDraftRoute<Before, CourseOutcomesResult>({
  step: 'outcomes',
  requiredPhase: 'outcomes',
  subject: '学习目标起草',
  modelStage: OUTCOMES_STAGE,
  log,
  answerError: OutcomeAnswerError,
  readBefore: async (ctx, taskId) => {
    const listed = await listCurriculumOutcomes(ctx.queryable, ctx.ownerId, taskId);
    return {
      board: boardOf(listed.objectives, listed.evidence),
      objectives: listed.objectives.map((row) => ({ id: row.id, title: row.title })),
    };
  },
  draft: async ({ ctx, before, model, log: stepLog, signal }) => {
    const turn = await draftCourseOutcomes(
      {
        direction: formatDirectionLine(ctx.task),
        board: before.board,
        history: ctx.history as CourseOutcomesTurn[],
        instruction: ctx.instruction,
        model,
      },
      { log: stepLog, signal },
    );
    if (turn.unmatchedRefs.length > 0) {
      stepLog.warn(`Course outcomes draft named unknown refs: ${turn.unmatchedRefs.join(', ')}`);
    }
    if (turn.rejectedRefs.length > 0) {
      stepLog.warn(
        `Course outcomes draft carried unusable entries: ${turn.rejectedRefs.join('; ')}`,
      );
    }
    return turn;
  },
  shape: async ({ turn, before, taskId, instruction }) => ({
    draft: outcomesDraftOf({
      turn,
      before: { objectives: before.objectives },
      taskId,
      instruction,
    }),
  }),
});
