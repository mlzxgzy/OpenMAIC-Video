/**
 * 第六步「教学内容生产」的 AI 步骤：一次对话轮次 → 一份逐条教学设计 + 分镜。
 *
 * 形状照抄 {@link file://./outline-step.ts}（同一条 prompt 管线、同一种 JSON 修理、
 * 同一份确定性逻辑与模型分离），差别在于产物是**两份文档**而不是一张表：
 *
 * 1. **脚本和分镜在同一个 plan 里进出。** 分镜是脚本的逐页化身，拆成两处写，模型就会
 *    改了一处忘了另一处，而两者的矛盾在界面上看不出来（见 `design-teaching.ts` 文件头）。
 * 2. **`nodes` 和 `objectives` 由规则层推导。** 模型只写四个档，不写这两个字段——
 *    让模型维护同一件事的两种说法，就是让它们漂移，而审核读的恰好是推导出来的那个。
 * 3. **分镜的名称在这一层解析。** 页面里的知识点写的是名称（生成器不认识 id），规则层
 *    把名称对回 id 才能检查"要求讲透的节点有没有落到某一页上"。
 *
 * 缺口用的是下一步审核、阶段门禁都会调用的同一个 {@link teachingGapsOfItems}，所以
 * 模型看到的"还差什么"、作者看到的缺口条、门禁拒绝的理由，三处不可能各说各话。
 */
import { callLLM } from '@/lib/ai/llm';
import { buildPrompt, PROMPT_IDS } from '@/lib/prompts';
import { formatDirectionLine } from '@/lib/server/curriculum/outcomes-step';
import {
  TeachingAnswerError,
  formatTeachingPlan,
  parseTeachingAnswer,
  resolveTeachingPlans,
  shouldConfirmTeaching,
  teachingGapsOfItems,
  type TeachingAnswer,
  type TeachingBoard,
  type TeachingGap,
  type TeachingItemBoard,
  type TeachingItemPatch,
} from '@/lib/curriculum/design-teaching';
import type {
  CurriculumUnitCoverageRecord,
  CurriculumLearningNodeRecord,
  CurriculumNodeObjectiveRecord,
  CurriculumUnitRecord,
} from '@/lib/curriculum/design-types';

import { nodesForObjectives, onlyItems } from '@/lib/curriculum/design-teaching';

import type { StepContext, StepLanguageModel } from '@/lib/server/generation/steps/context';

export interface CourseTeachingTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface CourseTeachingInput {
  /** The confirmed direction, as one context line. */
  direction: string;
  board: TeachingBoard;
  history: readonly CourseTeachingTurn[];
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
export interface CourseTeachingResult {
  message: string;
  /** 以条目 id 为键：`updateCurriculumUnit` 只写被点名的条目。 */
  patches: Map<string, TeachingItemPatch>;
  /** 模型说了确认（原始声明）；真正是否记录由路由对着写完之后的设计再判一次。 */
  modelRequestedConfirm: boolean;
  /** 这一步自己判的结论，供卡片与测试使用。 */
  confirmRequested: boolean;
  unmatchedRefs: string[];
  rejectedRefs: string[];
  /** 写进去之后仍然存在的缺口：模型提了但没法采纳的东西，作者要看得见。 */
  gaps: TeachingGap[];
  /** 只提示不拦签收的观察（页数、模型自报页数与实际不符）。 */
  advisories: string[];
  changedAnything: boolean;
  userTurns: number;
}

export function formatTeachingHistory(history: readonly CourseTeachingTurn[]): string {
  if (history.length === 0) return '(这是这一步的第一句话)';
  return history
    .map((turn) => `${turn.role === 'user' ? '用户' : '助手'}: ${turn.content}`)
    .join('\n\n');
}

/** The gaps the model is asked to close, in the same words the card shows. */
export function gapsText(gaps: readonly { text: string }[]): string {
  if (gaps.length === 0) return '(每一条都有教学设计，讲课条目都有分镜，可以请用户确认)';
  return gaps.map((gap) => `- ${gap.text}`).join('\n');
}

/** 模型这一轮改动之后的条目，用来算"写完之后还差什么"。 */
function itemAfter(
  item: TeachingItemBoard,
  patch: TeachingItemPatch | undefined,
): TeachingItemBoard {
  if (!patch) return item;
  return { ...item, teachingDesign: patch.teachingDesign, deckDesign: patch.deckDesign };
}

/**
 * The deterministic half, given the model's answer and the design it answered
 * about. Kept separate from {@link draftCourseTeaching} so it can be tested
 * against a hundred answers without a model.
 *
 * 缺口算在**写完之后的**设计上：模型这一轮补上的分镜不该继续被报成缺口，否则
 * 它会一直被告知"还差分镜"，而它刚刚写完。
 */
export function resolveTeachingTurn(input: {
  answer: TeachingAnswer;
  board: TeachingBoard;
  history: readonly CourseTeachingTurn[];
}): CourseTeachingResult {
  const userTurns = input.history.filter((turn) => turn.role === 'user').length + 1;
  const { patches, unmatchedRefs, rejectedRefs, advisories } = resolveTeachingPlans({
    board: input.board,
    answer: input.answer,
  });

  const after = input.board.items.map((item) => itemAfter(item, patches.get(item.id)));
  const gaps = teachingGapsOfItems(after);

  return {
    message: input.answer.message,
    patches,
    modelRequestedConfirm: input.answer.confirmRequested,
    confirmRequested: shouldConfirmTeaching({
      confirmRequested: input.answer.confirmRequested,
      userTurns,
      itemCount: input.board.items.length,
      gaps,
      changedAnything: patches.size > 0,
    }),
    unmatchedRefs,
    rejectedRefs: [...input.answer.rejectedRefs, ...rejectedRefs],
    gaps,
    advisories,
    changedAnything: patches.size > 0,
    userTurns,
  };
}

/**
 * The board the rules take, read off the records the route already has.
 *
 * 条目能点的节点由**覆盖关系当中间人**算出来（条目 → 目标 → 节点），因为条目与目标的
 * 绑定才是大纲签过字的那份关系（见 `nodesForObjectives`）。
 */
export function teachingBoardOf(input: {
  units: readonly CurriculumUnitRecord[];
  coverage: readonly CurriculumUnitCoverageRecord[];
  objectives: readonly { id: string; title: string }[];
  nodes: readonly CurriculumLearningNodeRecord[];
  nodeObjectives: readonly CurriculumNodeObjectiveRecord[];
}): TeachingBoard {
  const allNodeNames = new Map(input.nodes.map((node) => [node.id, node.name]));
  const items: TeachingItemBoard[] = onlyItems(input.units).map((unit) => {
    const objectiveIds = input.coverage
      .filter((row) => row.unitId === unit.id)
      .map((row) => row.objectiveId);
    return {
      id: unit.id,
      title: unit.title,
      role: unit.unitRole ?? 'lecture',
      hours: unit.hours,
      objectiveIds,
      nodes: nodesForObjectives(objectiveIds, input.nodeObjectives, input.nodes),
      allNodeNames,
      teachingDesign: unit.teachingDesign ?? {},
      deckDesign: unit.deckDesign ?? {},
    };
  });
  return {
    items,
    objectives: input.objectives,
    chapters: input.units
      .filter((unit) => unit.unitType === 'chapter')
      .map((unit) => ({ id: unit.id, title: unit.title, parentId: unit.parentId })),
  };
}

/**
 * Run one teaching turn. Throws {@link TeachingAnswerError} when the answer is not
 * usable as a teaching-design change; the caller maps that to a 502 and the design
 * is left exactly as it was.
 */
export async function draftCourseTeaching(
  input: CourseTeachingInput,
  ctx: StepContext,
): Promise<CourseTeachingResult> {
  const prompts = buildPrompt(PROMPT_IDS.COURSE_TEACHING, {
    direction: input.direction,
    plan: formatTeachingPlan(input.board),
    gaps: gapsText(input.gaps ?? teachingGapsOfItems(input.board.items)),
    history: formatTeachingHistory(input.history),
    instruction: input.instruction,
  });
  if (!prompts) {
    throw new Error(`找不到教学内容提示词模板：${PROMPT_IDS.COURSE_TEACHING}`);
  }

  ctx.log.info(
    `Course teaching turn ${input.history.length + 1}: "${input.instruction.slice(0, 80)}"`,
  );

  const result = await callLLM(
    {
      model: input.model.model,
      system: prompts.system,
      prompt: prompts.user,
      maxOutputTokens: input.model.modelInfo?.outputWindow,
      abortSignal: ctx.signal,
    },
    'course-teaching',
    {
      retries: 1,
      validate: (text: string) => {
        try {
          parseTeachingAnswer(text);
          return true;
        } catch {
          return false;
        }
      },
    },
    input.model.thinkingConfig,
    { serverManaged: input.model.serverManaged },
  );

  return resolveTeachingTurn({
    answer: parseTeachingAnswer(result.text),
    board: input.board,
    history: input.history,
  });
}

export { TeachingAnswerError, formatDirectionLine };
