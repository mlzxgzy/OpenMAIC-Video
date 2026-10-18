/**
 * POST /api/curriculum/series/[id]/design/direction/ai — 用 AI 填写系列方向。
 *
 * 方向是系列设计的第 1 步（谁学、什么基础、什么场景），也是唯一一步**不依赖任何
 * 已有设计**的：用户建完系列往往只写了名称和一句说明。在这里给一个「AI 填写」
 * 按钮，比让用户对着六个空格自己编要实际。
 *
 * 只生成、不落库，和 `/design/ai`（目标与知识体系）同一套约定：草稿回给界面，
 * 用户看过、改过，再走 PATCH。已有方向会随请求送进提示词，让模型保留用户手写的
 * 内容、只补空白，而不是覆盖成一份"更标准"的答案。
 */
import type { NextRequest } from 'next/server';

import { createLogger } from '@/lib/logger';
import { isSameOriginJsonRequest } from '@/lib/persistence/owner-claim-http';
import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { runDesignRoute } from '@/lib/server/curriculum/design-http';
import { curriculumJsonError } from '@/lib/server/curriculum/http';
import { getSeriesDesign } from '@/lib/server/curriculum/series-design';
import { resolveSeriesDesignModel } from '@/lib/server/curriculum/series-design-model';
import { draftSeriesDirection } from '@/lib/server/curriculum/series-direction-step';
import { SeriesDirectionInvalidError } from '@/lib/curriculum/series-design';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

const log = createLogger('SeriesDirectionAi');

export async function POST(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    if (!isSameOriginJsonRequest(req)) {
      return curriculumJsonError(
        403,
        'CURRICULUM_SERIES_DESIGN_INVALID',
        '系列方向生成必须是同源 JSON 请求',
        ctx.headers,
      );
    }

    const snapshot = await getSeriesDesign(ctx.queryable, ctx.ownerId, ctx.taskId);
    if (!snapshot) {
      return curriculumJsonError(404, 'CURRICULUM_SERIES_NOT_FOUND', '课程系列不存在', ctx.headers);
    }

    const model = await resolveSeriesDesignModel(ctx);
    if ('response' in model) return model.response;

    try {
      const direction = await draftSeriesDirection(
        {
          seriesName: snapshot.series.name,
          seriesDescription: snapshot.series.description,
          currentDirection: snapshot.design.direction,
          model: model.value,
        },
        { log, signal: req.signal },
      );
      return ownerJson({ direction }, 200, ctx.headers);
    } catch (error) {
      if (req.signal.aborted) {
        return curriculumJsonError(
          499,
          'CURRICULUM_SERIES_DESIGN_FAILED',
          '生成被取消',
          ctx.headers,
        );
      }
      if (error instanceof SeriesDirectionInvalidError) {
        log.warn(`Series direction answer unusable: ${error.message}`);
        return curriculumJsonError(
          502,
          'CURRICULUM_SERIES_DESIGN_FAILED',
          error.message,
          ctx.headers,
        );
      }
      throw error;
    }
  });
}
