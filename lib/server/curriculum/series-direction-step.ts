/**
 * 系列方向的模型调用：一次填好「谁学、什么基础、什么场景」。
 *
 * 形状照抄 `series-design-step.ts`：`(input, ctx) => output`、同一条 prompt 管线、
 * 同一种「坏 JSON 当瞬态错误重试一次」。它**没有写库权限**：草稿由路由回给界面，
 * 用户看过、改过再走 PATCH。理由和另外两个起草入口一致——让用户先看到会写进去
 * 什么，比写完再道歉便宜。
 *
 * 为什么单独一次调用而不是并进目标 / 知识体系那次：方向是第 1 步，用户在它上面
 * 停住时目标与知识体系还没有依据可写；把三样塞进一次调用，会让「先定方向」这个
 * 顺序在界面上变成一句空话。方向与另外两层之间用 PATCH 分两次保存，是同一页上
 * 两个按钮各自的作用域。
 */
import { callLLM } from '@/lib/ai/llm';
import { buildPrompt, PROMPT_IDS } from '@/lib/prompts';
import {
  formatSeriesDirection,
  parseSeriesDirectionAnswer,
  SeriesDirectionInvalidError,
  type SeriesDesignDirection,
} from '@/lib/curriculum/series-design';

import type { StepContext, StepLanguageModel } from '@/lib/server/generation/steps/context';

export interface SeriesDirectionDraftInput {
  /** 系列名称与说明，原样进提示词。 */
  seriesName: string;
  seriesDescription: string | null;
  /** 已经填过的方向：模型保留并补全，而不是把用户写的换成自己的。 */
  currentDirection: SeriesDesignDirection;
  model: StepLanguageModel;
}

export async function draftSeriesDirection(
  input: SeriesDirectionDraftInput,
  ctx: StepContext,
): Promise<SeriesDesignDirection> {
  const variables = {
    seriesInfo: [
      `名称：${input.seriesName}`,
      input.seriesDescription ? `说明：${input.seriesDescription}` : '说明：（未填写）',
    ].join('\n'),
    // 空方向不要留一片空白：模型会以为"没写"和"没这个字段"是一回事。
    currentDirection: formatSeriesDirection(input.currentDirection),
  };
  const prompts = buildPrompt(PROMPT_IDS.COURSE_SERIES_DIRECTION, variables);
  if (!prompts) throw new Error('找不到系列方向提示词模板：course-series-direction');

  ctx.log.info(
    `Series direction draft: ${input.seriesName} ` +
      `[filled=${Object.values(input.currentDirection).filter((value) => value !== null).length}/6]`,
  );

  const result = await callLLM(
    {
      model: input.model.model,
      system: prompts.system,
      prompt: prompts.user,
      maxOutputTokens: input.model.modelInfo?.outputWindow,
      abortSignal: ctx.signal,
    },
    'course-series-direction',
    {
      // 坏 JSON 是模型抖动；重试一次比让用户重新点一次便宜。
      retries: 1,
      validate: (text: string) => {
        try {
          parseSeriesDirectionAnswer(text);
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
    return parseSeriesDirectionAnswer(result.text);
  } catch (error) {
    if (error instanceof SeriesDirectionInvalidError) {
      throw new SeriesDirectionInvalidError(`模型回答不可用：${error.message}`);
    }
    throw error;
  }
}
