/**
 * POST /api/curriculum/design/tasks/[id]/assessment/draft — 起草，**一行都不写**。
 *
 * 骨架来自 {@link stepDraftRoute}。缺口来源与 `assessment/turn` 路由同一个：这一步自己的
 * 加上审核里"这条证据还没有题目或实操"的那些。
 */
import { createLogger } from '@/lib/logger';
import { assessmentDraftOf } from '@/lib/curriculum/assessment-draft';
import { assessmentBoardOf, type AssessmentBoard } from '@/lib/curriculum/design-assessment';
import {
  draftCourseAssessment,
  formatDirectionLine,
  AssessmentAnswerError,
  type CourseAssessmentResult,
  type CourseAssessmentTurn,
} from '@/lib/server/curriculum/assessment-step';
import { stepDraftRoute } from '@/lib/server/curriculum/step-draft-route';
import { getCurriculumDesignSnapshot } from '@/lib/server/curriculum/design-store';
import type { CurriculumDesignSnapshot } from '@/lib/curriculum/design-types';
import { assessmentBlockers } from '@/lib/server/curriculum/assessment-state';

export const runtime = 'nodejs';

const ASSESSMENT_STAGE = 'scene-outlines-stream';

const log = createLogger('CourseAssessmentDraft');

interface AssessmentBefore {
  board: AssessmentBoard;
  /** 缺口判定读的是**记录**，不是板——与 `assessment/turn` 路由同一个来源。 */
  design: CurriculumDesignSnapshot;
  gaps: { text: string }[];
}

export const POST = stepDraftRoute<AssessmentBefore, CourseAssessmentResult>({
  step: 'assessment',
  requiredPhase: 'assessment',
  subject: '题目与实操起草',
  modelStage: ASSESSMENT_STAGE,
  log,
  answerError: AssessmentAnswerError,
  readBefore: async (ctx, taskId) => {
    const snapshot = await getCurriculumDesignSnapshot(ctx.queryable, ctx.ownerId, taskId);
    return {
      board: assessmentBoardOf(snapshot),
      design: snapshot,
      gaps: assessmentBlockers(snapshot).map((text) => ({ text })),
    };
  },
  draft: async ({ ctx, before, model, log: stepLog, signal }) => {
    const turn = await draftCourseAssessment(
      {
        direction: formatDirectionLine(ctx.task),
        board: before.board,
        design: before.design,
        history: ctx.history as CourseAssessmentTurn[],
        instruction: ctx.instruction,
        gaps: before.gaps,
        model,
      },
      { log: stepLog, signal },
    );
    if (turn.writes.rejectedRefs.length > 0) {
      stepLog.warn(
        `Course assessment draft carried unusable entries: ${turn.writes.rejectedRefs.join('; ')}`,
      );
    }
    return turn;
  },
  shape: async ({ turn, before, taskId, instruction }) => ({
    draft: assessmentDraftOf({ turn, board: before.board, taskId, instruction }),
  }),
});
