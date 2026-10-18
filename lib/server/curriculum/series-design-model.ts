/**
 * 系列设计的模型解析：起草方向（第 1 步）与起草目标 / 知识体系（第 2–3 步）共用。
 *
 * 抽出来不是为了少写几行，是为了**两条入口挂在同一个模型槽上**：如果方向走一个
 * 槽、目标走另一个槽，用户配好一个之后点另一个按钮会得到「没有配置模型」，而
 * 两个按钮在同一页上。
 */
import type { NextResponse } from 'next/server';

import { curriculumJsonError } from '@/lib/server/curriculum/http';
import type { DesignContext } from '@/lib/server/curriculum/design-http';
import {
  backgroundWorkspaceId,
  SlotDisabledError,
  SlotUnassignedError,
} from '@/lib/server/model-config/runtime';
import { resolveModel } from '@/lib/server/resolve-model';

/** 与系列大纲生成共用课程设计模型：这一步生成的是结构，不是素材。 */
export const SERIES_DESIGN_MODEL_STAGE = 'scene-outlines-stream';

export async function resolveSeriesDesignModel(
  ctx: DesignContext,
): Promise<{ value: Awaited<ReturnType<typeof resolveModel>> } | { response: NextResponse }> {
  try {
    return {
      value: await resolveModel({
        stage: SERIES_DESIGN_MODEL_STAGE,
        workspaceId: await backgroundWorkspaceId(ctx.ownerId),
      }),
    };
  } catch (error) {
    if (error instanceof SlotUnassignedError || error instanceof SlotDisabledError) {
      return {
        response: curriculumJsonError(
          400,
          'MISSING_MODEL',
          '没有为课程设计配置语言模型',
          ctx.headers,
        ),
      };
    }
    throw error;
  }
}
