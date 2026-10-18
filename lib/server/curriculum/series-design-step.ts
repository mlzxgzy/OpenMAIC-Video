/**
 * 系列级设计的模型调用：一次生成课程目标与知识体系。
 *
 * 形状照抄 `series-outline-step.ts`：`(input, ctx) => output`、同一条 prompt
 * 管线、同一种「坏 JSON 当瞬态错误重试一次」。它**没有写库权限**：草稿由路由
 * 原样回给界面，用户看过再保存，所以「模型说了什么」与「库里存了什么」是两个
 * 可分别测试的事实。
 *
 * 一次调用生成两层而不是两次：目标与知识体系是一份文档的两半（目标引用节点、
 * 节点支撑目标），拆开生成时第二层看不到第一层的答案，结果是目标点名了一个
 * 第一层没有的节点。大纲那三层可以分开，是因为章→节→目是严格的上下级；这里是
 * 同一份文档内部的双向引用。
 */
import { callLLM } from '@/lib/ai/llm';
import { buildPrompt, PROMPT_IDS } from '@/lib/prompts';
import {
  formatSeriesDesignForPrompt,
  parseSeriesDesignAnswer,
  SeriesDesignInvalidError,
  type SeriesDesignDoc,
} from '@/lib/curriculum/series-design';

import type { StepContext, StepLanguageModel } from '@/lib/server/generation/steps/context';

export interface SeriesDesignDraftInput {
  /** 系列名称与说明，原样进提示词。 */
  seriesName: string;
  seriesDescription: string | null;
  /** 已填的方向（可能为空）。 */
  directionText: string;
  /** 大纲的文本形态（章 / 节 / 目 + 每层备注）。 */
  outlineSummary: string;
  /** 已有设计：模型保留并补全，而不是推倒重来。 */
  existing: SeriesDesignDoc;
  model: StepLanguageModel;
}

export async function draftSeriesDesign(
  input: SeriesDesignDraftInput,
  ctx: StepContext,
): Promise<SeriesDesignDoc> {
  const variables = {
    seriesInfo: [
      `名称：${input.seriesName}`,
      input.seriesDescription ? `说明：${input.seriesDescription}` : '说明：（未填写）',
      input.directionText,
    ].join('\n'),
    outlineSummary: input.outlineSummary,
    existingDesign:
      input.existing.objectives.length === 0 && input.existing.nodes.length === 0
        ? '（还没有任何设计，这是第一版）'
        : formatSeriesDesignForPrompt(input.existing),
  };
  const prompts = buildPrompt(PROMPT_IDS.COURSE_SERIES_DESIGN, variables);
  if (!prompts) throw new Error('找不到系列级设计提示词模板：course-series-design');

  ctx.log.info(
    `Series design draft: ${input.seriesName} ` +
      `[outline=${input.outlineSummary.length} chars, existing=${input.existing.objectives.length} 目标 / ${input.existing.nodes.length} 节点]`,
  );

  const result = await callLLM(
    {
      model: input.model.model,
      system: prompts.system,
      prompt: prompts.user,
      maxOutputTokens: input.model.modelInfo?.outputWindow,
      abortSignal: ctx.signal,
    },
    'course-series-design',
    {
      // 坏 JSON / 少数组几乎都是瞬态的模型抖动；重试一次比让用户重新点一次便宜。
      retries: 1,
      validate: (text: string) => {
        try {
          parseSeriesDesignAnswer(text);
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
    return parseSeriesDesignAnswer(result.text);
  } catch (error) {
    if (error instanceof SeriesDesignInvalidError) {
      throw new SeriesDesignInvalidError(`模型回答不可用：${error.message}`);
    }
    throw error;
  }
}
