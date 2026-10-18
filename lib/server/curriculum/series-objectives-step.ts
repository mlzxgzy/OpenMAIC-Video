/**
 * 系列课程目标的「候选清单」生成：一次给出**一批**（18–28 条）、每条带类型的目标，
 * 由用户在清单里挑选。它不写库，采用多少条由用户勾选后走 PATCH。
 *
 * 为什么不是"让 AI 直接写出该有的几条"：课程目标是整门系列的承诺，写几条、偏重
 * 哪一类，是课程负责人的判断，不是模型的。把生成与选择拆开，按钮的作用从"替我
 * 决定"变成"给我一批可挑的"——这正是用户对这个入口的要求。
 *
 * 和另外两个起草入口的差别：方向是填六个槽位、目标+知识体系是写一份完整设计；
 * 这里是**生成可挑的池子**，所以解析层只要求每条候选自身完整（类型、可观察行为、
 * 达标线、证明方式），候选之间互不依赖。已有目标会进提示词：模型不必重复它们，
 * 解析后再筛一遍——模型没照做时也不让重复项淹掉清单。
 */
import { callLLM } from '@/lib/ai/llm';
import { buildPrompt, PROMPT_IDS } from '@/lib/prompts';
import {
  formatSeriesDirection,
  parseSeriesObjectiveCandidatesAnswer,
  screenObjectiveCandidates,
  seriesObjectiveTypeLabel,
  SeriesObjectiveCandidatesInvalidError,
  SERIES_OBJECTIVE_CANDIDATES_MIN,
  type SeriesDesignDirection,
  type SeriesDesignDoc,
  type SeriesObjectiveCandidate,
} from '@/lib/curriculum/series-design';

import type { StepContext, StepLanguageModel } from '@/lib/server/generation/steps/context';

export interface SeriesObjectivesDraftInput {
  /** 系列名称与说明，原样进提示词。 */
  seriesName: string;
  seriesDescription: string | null;
  /** 方向：目标是"这门系列要兑现什么"，方向和它一一对应。 */
  direction: SeriesDesignDirection;
  /** 已有设计：目标避免重复，知识体系可以作为候选目标支撑点的参考。 */
  existing: SeriesDesignDoc;
  model: StepLanguageModel;
}

export async function draftSeriesObjectiveCandidates(
  input: SeriesObjectivesDraftInput,
  ctx: StepContext,
): Promise<SeriesObjectiveCandidate[]> {
  const variables = {
    seriesInfo: [
      `名称：${input.seriesName}`,
      input.seriesDescription ? `说明：${input.seriesDescription}` : '说明：（未填写）',
    ].join('\n'),
    // 空方向不要留成一片空白：模型会以为"没写"和"没这个字段"是一回事。
    directionText: formatSeriesDirection(input.direction),
    existingObjectives: existingObjectivesText(input.existing),
  };
  const prompts = buildPrompt(PROMPT_IDS.COURSE_SERIES_OBJECTIVES, variables);
  if (!prompts) throw new Error('找不到系列课程目标候选提示词模板：course-series-objectives');

  ctx.log.info(
    `Series objective candidates: ${input.seriesName} ` +
      `[existing=${input.existing.objectives.length} 目标 / ${input.existing.nodes.length} 节点]`,
  );

  // 提示词里已经要求"不要重复已有目标"，但模型不照做时不能让重复项占满清单：
  // 筛选放在校验里，可用候选太少会触发一次重试，而不是把 20 条重复项交给用户。
  const usable = (text: string): SeriesObjectiveCandidate[] => {
    const parsed = parseSeriesObjectiveCandidatesAnswer(text);
    const screened = screenObjectiveCandidates(parsed, input.existing.objectives);
    if (screened.length < SERIES_OBJECTIVE_CANDIDATES_MIN) {
      throw new SeriesObjectiveCandidatesInvalidError(
        `筛掉与已有目标重复的条目后只剩 ${screened.length} 条候选（至少 ${SERIES_OBJECTIVE_CANDIDATES_MIN} 条）`,
      );
    }
    return screened;
  };

  const result = await callLLM(
    {
      model: input.model.model,
      system: prompts.system,
      prompt: prompts.user,
      maxOutputTokens: input.model.modelInfo?.outputWindow,
      abortSignal: ctx.signal,
    },
    'course-series-objectives',
    {
      // 坏 JSON / 候选太少几乎都是模型抖动；重试一次比让用户重新点一次便宜。
      retries: 1,
      validate: (text: string) => {
        try {
          usable(text);
          return true;
        } catch {
          return false;
        }
      },
    },
    input.model.thinkingConfig,
    { serverManaged: input.model.serverManaged },
  );

  try {
    return usable(result.text);
  } catch (error) {
    if (error instanceof SeriesObjectiveCandidatesInvalidError) {
      throw new SeriesObjectiveCandidatesInvalidError(`模型回答不可用：${error.message}`);
    }
    throw error;
  }
}

/** 已有目标的紧凑写法：标题 + 类型 + 可观察行为，够模型判断"别重复"了。 */
function existingObjectivesText(doc: SeriesDesignDoc): string {
  if (doc.objectives.length === 0) return '（还没有课程目标）';
  return doc.objectives
    .map(
      (objective) =>
        `- [${seriesObjectiveTypeLabel(objective.type)}] ${objective.title}：${
          objective.expectedBehavior || '（没写可观察行为）'
        }`,
    )
    .join('\n');
}
