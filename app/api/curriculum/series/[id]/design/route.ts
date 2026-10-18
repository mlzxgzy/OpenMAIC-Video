/**
 * GET   /api/curriculum/series/[id]/design — 系列级设计文档（方向 / 课程目标 / 知识体系）
 * PATCH /api/curriculum/series/[id]/design — 保存方向、课程目标或知识体系
 *
 * 这三样东西属于系列，不属于任何一目。让六十三目各写一遍受众与知识图，得到的
 * 不是六十三份答案，是六十三份互相矛盾的答案——这就是这个接口存在的理由。
 *
 * 读接口一次返回三样：文档、它走到第几步（由内容推出，不另存相位）、以及每一步
 * 还缺什么（`gaps`）。界面不需要自己判断「目标算不算完整」。
 *
 * PATCH 的合并语义由 `mergeSeriesDesign` 决定：`undefined` 是"这次不改"，
 * 空数组是"清空"。两者混同过一次就很难查——清空知识体系会让所有目标的引用悬空。
 */
import type { NextRequest } from 'next/server';

import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { runDesignRoute } from '@/lib/server/curriculum/design-http';
import { curriculumJsonError } from '@/lib/server/curriculum/http';
import {
  getSeriesDesign,
  readOutlineDesignDrift,
  SeriesDesignNotFoundError,
  SeriesDesignValidationError,
  updateSeriesDesign,
} from '@/lib/server/curriculum/series-design';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

function seriesNotFound(headers: Headers) {
  return curriculumJsonError(404, 'CURRICULUM_SERIES_NOT_FOUND', '课程系列不存在', headers);
}

export async function GET(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    const snapshot = await getSeriesDesign(ctx.queryable, ctx.ownerId, ctx.taskId);
    if (!snapshot) return seriesNotFound(ctx.headers);
    return ownerJson(
      {
        ...snapshot,
        // 设计页要回答"刚存完这一版，大纲跟上没有"，所以读设计时顺便给一份
        // 派生层的过期读数；不在这里算，页面就得再发一次请求。
        outlineDrift: await readOutlineDesignDrift(
          ctx.queryable,
          ctx.ownerId,
          ctx.taskId,
          snapshot,
        ),
      },
      200,
      ctx.headers,
    );
  });
}

export async function PATCH(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    const body = await ctx.body();
    try {
      const snapshot = await ctx.write((tx) =>
        updateSeriesDesign(tx, ctx.ownerId, ctx.taskId, body),
      );
      return ownerJson(
        {
          ...snapshot,
          outlineDrift: await readOutlineDesignDrift(
            ctx.queryable,
            ctx.ownerId,
            ctx.taskId,
            snapshot,
          ),
        },
        200,
        ctx.headers,
      );
    } catch (error) {
      if (error instanceof SeriesDesignNotFoundError) return seriesNotFound(ctx.headers);
      if (error instanceof SeriesDesignValidationError) {
        return curriculumJsonError(
          400,
          'CURRICULUM_SERIES_DESIGN_INVALID',
          error.message,
          ctx.headers,
        );
      }
      throw error;
    }
  });
}
