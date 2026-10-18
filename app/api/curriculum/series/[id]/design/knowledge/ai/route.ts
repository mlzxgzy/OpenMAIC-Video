/**
 * POST /api/curriculum/series/[id]/design/knowledge/ai — 让 AI 依据课程目标给出一批
 * 候选知识 / 技能点。
 *
 * 与第 2 步的候选接口同一套约定：只生成、不落库，勾选后由 PATCH 追加。差别在
 * 前置条件——知识体系要支撑课程目标，没有目标时生成出来的是一张泛泛的目录，所以
 * 这里回 409 而不是让模型硬写，界面上那个按钮也是灰的。
 */
import type { NextRequest } from 'next/server';

import { createLogger } from '@/lib/logger';
import { isSameOriginJsonRequest } from '@/lib/persistence/owner-claim-http';
import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { runDesignRoute } from '@/lib/server/curriculum/design-http';
import { curriculumJsonError } from '@/lib/server/curriculum/http';
import { getSeriesDesign } from '@/lib/server/curriculum/series-design';
import { resolveSeriesDesignModel } from '@/lib/server/curriculum/series-design-model';
import { draftSeriesKnowledgeCandidates } from '@/lib/server/curriculum/series-knowledge-step';
import { SeriesKnowledgeCandidatesInvalidError } from '@/lib/curriculum/series-design';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

const log = createLogger('SeriesKnowledgeAi');

export async function POST(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    if (!isSameOriginJsonRequest(req)) {
      return curriculumJsonError(
        403,
        'CURRICULUM_SERIES_DESIGN_INVALID',
        '知识体系候选生成必须是同源 JSON 请求',
        ctx.headers,
      );
    }

    const snapshot = await getSeriesDesign(ctx.queryable, ctx.ownerId, ctx.taskId);
    if (!snapshot) {
      return curriculumJsonError(404, 'CURRICULUM_SERIES_NOT_FOUND', '课程系列不存在', ctx.headers);
    }

    // 前置条件不是"模型质量问题"，是顺序问题：先有目标，知识体系才有依据。
    if (snapshot.design.objectives.length === 0) {
      return curriculumJsonError(
        409,
        'CURRICULUM_SERIES_DESIGN_INVALID',
        '还没有课程目标：知识体系要支撑第 2 步的目标，先把它定下来',
        ctx.headers,
      );
    }

    const model = await resolveSeriesDesignModel(ctx);
    if ('response' in model) return model.response;

    try {
      const candidates = await draftSeriesKnowledgeCandidates(
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
      if (error instanceof SeriesKnowledgeCandidatesInvalidError) {
        log.warn(`Series knowledge candidates unusable: ${error.message}`);
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
