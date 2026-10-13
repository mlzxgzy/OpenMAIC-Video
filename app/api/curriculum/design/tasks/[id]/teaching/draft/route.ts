/**
 * POST /api/curriculum/design/tasks/[id]/teaching/draft — 起草，**一行都不写**。
 *
 * 骨架来自 {@link stepDraftRoute}。缺口来源与 `teaching/turn` 路由同一个：这一步自己的
 * 加上审核里"讲课条目没有分镜"的那些发现。
 */
import { createLogger } from '@/lib/logger';
import { teachingDraftOf } from '@/lib/curriculum/teaching-draft';
import {
  draftCourseTeaching,
  formatDirectionLine,
  teachingBoardOf,
  TeachingAnswerError,
  type CourseTeachingResult,
  type CourseTeachingTurn,
} from '@/lib/server/curriculum/teaching-step';
import type { TeachingBoard } from '@/lib/curriculum/design-teaching';
import { stepDraftRoute } from '@/lib/server/curriculum/step-draft-route';
import { getCurriculumDesignSnapshot } from '@/lib/server/curriculum/design-store';
import { teachingBlockers } from '@/lib/server/curriculum/teaching-state';

export const runtime = 'nodejs';

const TEACHING_STAGE = 'scene-outlines-stream';

const log = createLogger('CourseTeachingDraft');

interface TeachingBefore {
  board: TeachingBoard;
  gaps: { text: string }[];
}

export const POST = stepDraftRoute<TeachingBefore, CourseTeachingResult>({
  step: 'teaching',
  requiredPhase: 'teaching',
  subject: '教学内容起草',
  modelStage: TEACHING_STAGE,
  log,
  answerError: TeachingAnswerError,
  readBefore: async (ctx, taskId) => {
    const snapshot = await getCurriculumDesignSnapshot(ctx.queryable, ctx.ownerId, taskId);
    return {
      board: teachingBoardOf({
        units: snapshot.units,
        coverage: snapshot.unitCoverage,
        objectives: snapshot.objectives
          .filter((row) => row.status !== 'archived')
          .map((row) => ({ id: row.id, title: row.title })),
        nodes: snapshot.nodes,
        nodeObjectives: snapshot.nodeObjectives,
      }),
      gaps: teachingBlockers(snapshot).map((text) => ({ text })),
    };
  },
  draft: async ({ ctx, before, model, log: stepLog, signal }) => {
    const turn = await draftCourseTeaching(
      {
        direction: formatDirectionLine(ctx.task),
        board: before.board,
        history: ctx.history as CourseTeachingTurn[],
        instruction: ctx.instruction,
        gaps: before.gaps,
        model,
      },
      { log: stepLog, signal },
    );
    if (turn.unmatchedRefs.length > 0) {
      stepLog.warn(`Course teaching draft named unknown refs: ${turn.unmatchedRefs.join(', ')}`);
    }
    return turn;
  },
  shape: async ({ turn, before, taskId, instruction }) => ({
    draft: teachingDraftOf({ turn, board: before.board, taskId, instruction }),
  }),
});
