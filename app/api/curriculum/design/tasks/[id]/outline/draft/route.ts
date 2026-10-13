/**
 * POST /api/curriculum/design/tasks/[id]/outline/draft — 起草，**一行都不写**。
 *
 * 骨架来自 {@link stepDraftRoute}；这里只给两样领域特有的东西：起草前读什么，以及这一轮
 * 的结果怎么算成行。读板与 `outline/turn` 路由**共用** `outlineBoardFromSnapshot`，所以两边
 * 看到的讲授顺序永远一致。
 */
import { createLogger } from '@/lib/logger';
import { outlineDraftOf } from '@/lib/curriculum/outline-draft';
import { outlineBoardFromSnapshot } from '@/lib/server/curriculum/outline-board';
import {
  draftCourseOutline,
  formatDirectionLine,
  OutlineAnswerError,
  type CourseOutlineResult,
  type CourseOutlineTurn,
  type OutlineBoard,
} from '@/lib/server/curriculum/outline-step';
import { stepDraftRoute } from '@/lib/server/curriculum/step-draft-route';
import { getCurriculumDesignSnapshot } from '@/lib/server/curriculum/design-store';
import { outlineAuditFindings, outlineGapsOfSnapshot } from '@/lib/server/curriculum/outline-state';

export const runtime = 'nodejs';

const OUTLINE_STAGE = 'scene-outlines-stream';

const log = createLogger('CourseOutlineDraft');

interface OutlineBefore {
  board: OutlineBoard;
  gaps: { text: string }[];
}

export const POST = stepDraftRoute<OutlineBefore, CourseOutlineResult>({
  step: 'outline',
  requiredPhase: 'outline',
  subject: '大纲起草',
  modelStage: OUTLINE_STAGE,
  log,
  answerError: OutlineAnswerError,
  readBefore: async (ctx, taskId) => {
    const snapshot = await getCurriculumDesignSnapshot(ctx.queryable, ctx.ownerId, taskId);
    // 提示词里的缺口与 `outline/turn` 路由同一个来源：它自己那些，加上审核里关于条目顺序
    // 的发现（那才是"声明的顺序对不上"真正出现的地方）。
    const gaps = [
      ...outlineGapsOfSnapshot(snapshot),
      ...outlineAuditFindings(snapshot).map((finding) => ({ text: finding.message })),
    ];
    const board = outlineBoardFromSnapshot({ ...snapshot, declaredHours: null });
    return { board, gaps };
  },
  draft: async ({ ctx, before, model, log: stepLog, signal }) => {
    const turn = await draftCourseOutline(
      {
        direction: formatDirectionLine(ctx.task),
        board: before.board,
        history: ctx.history as CourseOutlineTurn[],
        instruction: ctx.instruction,
        gaps: before.gaps,
        model,
      },
      { log: stepLog, signal },
    );
    if (turn.unmatchedRefs.length > 0) {
      stepLog.warn(`Course outline draft named unknown refs: ${turn.unmatchedRefs.join(', ')}`);
    }
    return turn;
  },
  shape: async ({ turn, before, taskId, instruction }) => ({
    draft: outlineDraftOf({ turn, board: before.board, taskId, instruction }),
  }),
});
