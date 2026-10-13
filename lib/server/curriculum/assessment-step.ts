/**
 * 第七步「题目与实操」的 AI 步骤：一次对话轮次 → 一批题目与实操任务。
 *
 * 形状照抄 {@link file://./teaching-step.ts}（同一条 prompt 管线、同一种 JSON 修理、
 * 同一份确定性逻辑与模型分离），差别在于这一步的产物**不是一份文档而是一组记录**：
 *
 * 1. **产物是独立的行，不是"整份集合"。** 题目与实操各有自己的 id，模型改一道、删一道
 *    都得指名；没提到的保持原样。所以解析出的是**六个动作**（新建/修改/删除 × 题目/实操），
 *    不是一份替换——这是第三步依赖边的那条约定，不是第五步覆盖表那条。
 * 2. **落点在规则层解析。** 模型可以只给 `objectiveRef`，由承担它的条目推导；落点不合法
 *    （挂在章上、挂在没承诺该目标的条目上、实操挂在只讲课的条目上）时**不写**，并且
 *    说出来。store 这两件事都不检查，而写下去之后覆盖闭环里看不到它。
 * 3. **`evidenceId` 与 `sortOrder` 由规则层推导**，模型写不了：证据是第二步签过的文件，
 *    题号是同一份文档里的顺序。见 `design-assessment.ts` 文件头。
 *
 * 缺口用的是下一步审核、阶段门禁都会调用的同一个 {@link assessmentGaps}，所以模型看到的
 * "还差什么"、作者看到的缺口条、门禁拒绝的理由，三处不可能各说各话。
 */
import { callLLM } from '@/lib/ai/llm';
import { buildPrompt, PROMPT_IDS } from '@/lib/prompts';
import {
  applyAssessmentAnswer,
  assessmentGaps,
  AssessmentAnswerError,
  formatAssessmentPlan,
  parseAssessmentAnswer,
  shouldConfirmAssessment,
  type AssessmentAnswer,
  type AssessmentBoard,
  type AssessmentGap,
  type AssessmentGapInput,
  type AssessmentUpdates,
} from '@/lib/curriculum/design-assessment';
import { formatDirectionLine } from '@/lib/server/curriculum/outcomes-step';

import type { StepContext, StepLanguageModel } from '@/lib/server/generation/steps/context';

export interface CourseAssessmentTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface CourseAssessmentInput {
  /** The confirmed direction, as one context line. */
  direction: string;
  /**
   * The panel: the prompt renders from it, and "which existing row does this change"
   * answers from it. Both are the same object the route read the design into, so
   * there is no second copy.
   */
  board: AssessmentBoard;
  /** 缺口判定的记录（写之前的状态）。快照本身就是这个形状的超集。 */
  design: AssessmentGapInput;
  history: readonly CourseAssessmentTurn[];
  instruction: string;
  /**
   * What the model is told is still missing. Passed in rather than recomputed so
   * the prompt, the card and the gate all read one list (the route merges the
   * step's gaps with the audit's findings before calling).
   */
  gaps?: readonly { text: string }[];
  model: StepLanguageModel;
}

/** What the route has to write, already resolved against real ids. */
export interface CourseAssessmentResult {
  message: string;
  writes: AssessmentUpdates;
  /** 模型说了确认（原始声明）；真正是否记录由路由对着写完之后的设计再判一次。 */
  modelRequestedConfirm: boolean;
  /** 这一步自己判的结论，供卡片与测试使用。 */
  confirmRequested: boolean;
  /** 写进去之后仍然存在的缺口：模型提了但没法采纳的东西，作者要看得见。 */
  gaps: AssessmentGap[];
  changedAnything: boolean;
  userTurns: number;
  artifactCount: number;
}

export function formatAssessmentHistory(history: readonly CourseAssessmentTurn[]): string {
  if (history.length === 0) return '(这是这一步的第一句话)';
  return history
    .map((turn) => `${turn.role === 'user' ? '用户' : '助手'}: ${turn.content}`)
    .join('\n\n');
}

/** The gaps the model is asked to close, in the same words the card shows. */
export function assessmentGapsText(gaps: readonly { text: string }[]): string {
  if (gaps.length === 0) {
    return '(每个承诺考核的条目都有题目或实操，考试证据由考试的实操交付，可以请用户确认)';
  }
  return gaps.map((gap) => `- ${gap.text}`).join('\n');
}

/**
 * The design as it will be after this turn, in the narrow shape the gap rules read.
 *
 * Built explicitly rather than by spreading the draft over the record: the draft
 * carries fields the gap rules do not read (options, difficulty…), and a silent
 * spread is how a rule ends up reading a field nobody thought was part of the
 * judgement. New rows get placeholder ids — nothing downstream looks them up, they
 * only have to exist for "is there an artifact here".
 */
function gapInputAfter(input: AssessmentGapInput, writes: AssessmentUpdates): AssessmentGapInput {
  const removedQuestions = new Set(writes.removeQuestionIds);
  const removedLabs = new Set(writes.removeLabTaskIds);
  const questionPatch = new Map(writes.updateQuestions.map((entry) => [entry.id, entry.patch]));
  const labPatch = new Map(writes.updateLabTasks.map((entry) => [entry.id, entry.patch]));

  return {
    units: input.units,
    unitCoverage: input.unitCoverage,
    objectives: input.objectives,
    evidence: input.evidence,
    questions: [
      ...input.questions
        .filter((row) => !removedQuestions.has(row.id))
        .map((row) => {
          const patch = questionPatch.get(row.id);
          if (!patch) return row;
          return {
            id: row.id,
            unitId: patch.unitId ?? row.unitId,
            objectiveId: patch.objectiveId ?? row.objectiveId,
          };
        }),
      ...writes.createQuestions.map((row, index) => ({
        id: `pending-q${index}`,
        unitId: row.unitId,
        objectiveId: row.objectiveId,
      })),
    ],
    labTasks: [
      ...input.labTasks
        .filter((row) => !removedLabs.has(row.id))
        .map((row) => {
          const patch = labPatch.get(row.id);
          const merged = patch ? { ...row, ...patch } : row;
          return {
            id: row.id,
            unitId: merged.unitId,
            objectiveId: merged.objectiveId,
            assessmentMode: merged.assessmentMode,
            taskGoal: merged.taskGoal,
            verifyRules: merged.verifyRules,
          };
        }),
      ...writes.createLabTasks.map((row, index) => ({
        id: `pending-lab${index}`,
        unitId: row.unitId,
        objectiveId: row.objectiveId,
        assessmentMode: row.assessmentMode,
        taskGoal: row.taskGoal,
        verifyRules: row.verifyRules,
      })),
    ],
  };
}

/**
 * The deterministic half, given the model's answer and the design it answered
 * about. Kept separate from {@link draftCourseAssessment} so it can be tested
 * against a hundred answers without a model.
 *
 * 缺口算在**写完之后的**设计上：模型这一轮补上的题目不该继续被报成缺口，否则它会
 * 一直被告知"还差题"，而它刚刚写完。
 */
export function resolveAssessmentTurn(input: {
  answer: AssessmentAnswer;
  board: AssessmentBoard;
  design: AssessmentGapInput;
  history: readonly CourseAssessmentTurn[];
}): CourseAssessmentResult {
  const userTurns = input.history.filter((turn) => turn.role === 'user').length + 1;
  const writes = applyAssessmentAnswer({ board: input.board, answer: input.answer });
  const after = gapInputAfter(input.design, writes);
  const gaps = assessmentGaps(after);

  return {
    message: input.answer.message,
    writes,
    modelRequestedConfirm: input.answer.confirmRequested,
    confirmRequested: shouldConfirmAssessment({
      confirmRequested: input.answer.confirmRequested,
      userTurns,
      gaps,
      changedAnything: writes.changed,
      artifactCount: after.questions.length + after.labTasks.length,
      itemCount: input.board.items.length,
    }),
    gaps,
    changedAnything: writes.changed,
    userTurns,
    artifactCount: after.questions.length + after.labTasks.length,
  };
}

/**
 * Run one assessment turn. Throws {@link AssessmentAnswerError} when the answer is
 * not usable at all; the caller maps that to a 502 and the design is left exactly
 * as it was.
 */
export async function draftCourseAssessment(
  input: CourseAssessmentInput,
  ctx: StepContext,
): Promise<CourseAssessmentResult> {
  const prompts = buildPrompt(PROMPT_IDS.COURSE_ASSESSMENT, {
    direction: input.direction,
    plan: formatAssessmentPlan(input.board),
    gaps: assessmentGapsText(input.gaps ?? assessmentGaps(input.design)),
    history: formatAssessmentHistory(input.history),
    instruction: input.instruction,
  });
  if (!prompts) {
    throw new Error(`找不到题目与实操提示词模板：${PROMPT_IDS.COURSE_ASSESSMENT}`);
  }

  ctx.log.info(
    `Course assessment turn ${input.history.length + 1}: "${input.instruction.slice(0, 80)}"`,
  );

  const result = await callLLM(
    {
      model: input.model.model,
      system: prompts.system,
      prompt: prompts.user,
      maxOutputTokens: input.model.modelInfo?.outputWindow,
      abortSignal: ctx.signal,
    },
    'course-assessment',
    {
      retries: 1,
      validate: (text: string) => {
        try {
          parseAssessmentAnswer(text);
          return true;
        } catch {
          return false;
        }
      },
    },
    input.model.thinkingConfig,
    { serverManaged: input.model.serverManaged },
  );

  return resolveAssessmentTurn({
    answer: parseAssessmentAnswer(result.text),
    board: input.board,
    design: input.design,
    history: input.history,
  });
}

export { AssessmentAnswerError, formatDirectionLine };
