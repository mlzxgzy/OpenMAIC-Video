/**
 * POST /api/curriculum/series/[id]/design/objectives/ai — 让 AI 给出一批候选课程目标。
 *
 * 与另外两个起草入口（方向、目标+知识体系）的差别：这一步产出的**不是一份要落库
 * 的草稿，而是一批供挑选的候选**。用户勾选哪几条，才把哪几条追加进系列目标。
 *
 * 只生成、不落库：候选池不是设计文档的一部分，勾选前它什么也不是。采用走 PATCH，
 * 由用户在弹窗里确认过的集合写进去。
 */
import type { NextRequest } from 'next/server';

import { createLogger } from '@/lib/logger';
import { isSameOriginJsonRequest } from '@/lib/persistence/owner-claim-http';
import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { runDesignRoute } from '@/lib/server/curriculum/design-http';
import { curriculumJsonError } from '@/lib/server/curriculum/http';
import { getSeriesDesign } from '@/lib/server/curriculum/series-design';
import { resolveSeriesDesignModel } from '@/lib/server/curriculum/series-design-model';
import { draftSeriesObjectiveCandidates } from '@/lib/server/curriculum/series-objectives-step';
import { SeriesObjectiveCandidatesInvalidError } from '@/lib/curriculum/series-design';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

const log = createLogger('SeriesObjectivesAi');

export async function POST(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    if (!isSameOriginJsonRequest(req)) {
      return curriculumJsonError(
        403,
        'CURRICULUM_SERIES_DESIGN_INVALID',
        '课程目标候选生成必须是同源 JSON 请求',
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
      const candidates = await draftSeriesObjectiveCandidates(
        {
          seriesName: snapshot.series.name,
          seriesDescription: snapshot.series.description,
          direction: snapshot.design.direction,
          existing: snapshot.design,
          model: model.value,
        },
        { log, signal: req.signal },
      );
      return ownerJson({ candidates }, 200, ctx.headers);
    } catch (error) {
      if (req.signal.aborted) {
        return curriculumJsonError(
          499,
          'CURRICULUM_SERIES_DESIGN_FAILED',
          '生成被取消',
          ctx.headers,
        );
      }
      if (error instanceof SeriesObjectiveCandidatesInvalidError) {
        log.warn(`Series objective candidates unusable: ${error.message}`);
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
