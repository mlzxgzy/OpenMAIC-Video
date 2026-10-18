/**
 * 系列大纲 AI 生成的模型调用：一次请求只问一层（章 / 节 / 目）。
 *
 * 形状照抄 `direction-step.ts` / `outline-step.ts`：`(input, ctx) => output`、
 * 同一条 prompt 管线、同一种"坏 JSON 当瞬态错误重试一次"。与它们不同的是，
 * 这一步**没有任何写库权限**：它只把模型的回答解析成计划，落库由路由在
 * 一个事务里完成，所以"模型说了什么"与"库里变成了什么"是两个可分别测试的事实。
 *
 * 三个 prompt 模板而不是一个带条件分支的模板：三层的规则（章是方向、节是案例、
 * 目是一节课）差异大到合写时模型会互相串味，而条件块又不支持嵌套。
 */
import { callLLM } from '@/lib/ai/llm';
import { buildPrompt, type PromptId } from '@/lib/prompts';
import {
  formatSeriesOutlineAiContext,
  parseSeriesOutlineAiPlan,
  type SeriesOutlineAiContext,
  type SeriesOutlineAiLevel,
  type SeriesOutlineAiMode,
  type SeriesOutlineAiPlan,
} from '@/lib/curriculum/series-outline-ai';

import type { StepContext, StepLanguageModel } from '@/lib/server/generation/steps/context';

/**
 * 三份模板都用字面量而不是 `PROMPT_IDS` 常量：常量表被几十个模块共享，这次
 * 只新增了三个 id；直接写 id 让这一个步骤只依赖模板文件本身，模板还没被
 * `PROMPT_IDS` 收录时也仍然能跑（`PromptId` 类型在编译期保证拼写正确）。
 */
const PROMPT_BY_LEVEL: Record<SeriesOutlineAiLevel, PromptId> = {
  chapter: 'course-series-chapters',
  section: 'course-series-sections',
  item: 'course-series-items',
};

/** One level's plan, drafted from the series' own words and the outline as it is. */
export interface SeriesOutlineAiDraftInput {
  level: SeriesOutlineAiLevel;
  mode: SeriesOutlineAiMode;
  context: SeriesOutlineAiContext;
  model: StepLanguageModel;
}

export async function draftSeriesOutlinePlan(
  input: SeriesOutlineAiDraftInput,
  ctx: StepContext,
): Promise<SeriesOutlineAiPlan> {
  const promptId = PROMPT_BY_LEVEL[input.level];
  const variables = formatSeriesOutlineAiContext({
    level: input.level,
    mode: input.mode,
    context: input.context,
  });
  const prompts = buildPrompt(promptId, variables);
  if (!prompts) {
    throw new Error(`找不到系列大纲提示词模板：${promptId}`);
  }

  ctx.log.info(
    `Series outline draft (${input.level}/${input.mode}): ${input.context.series.name} ` +
      `[${input.context.chapters.length} 章 / ${input.context.sections.length} 节 / ${input.context.items.length} 目]`,
  );

  const result = await callLLM(
    {
      model: input.model.model,
      system: prompts.system,
      prompt: prompts.user,
      maxOutputTokens: input.model.modelInfo?.outputWindow,
      abortSignal: ctx.signal,
    },
    'course-series-outline',
    {
      // 解析失败重试一次：坏 JSON / 少数组几乎都是瞬态的模型抖动，而不是
      // 用户的要求本身不成立。
      retries: 1,
      validate: (text: string) => {
        try {
          parseSeriesOutlineAiPlan(input.level, text);
          return true;
        } catch {
          return false;
        }
      },
    },
    input.model.thinkingConfig,
    { serverManaged: input.model.serverManaged },
  );

  return parseSeriesOutlineAiPlan(input.level, result.text);
}
