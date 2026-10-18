/**
 * POST /api/curriculum/series/[id]/outline/ai — 用 AI 生成一层大纲（章 / 节 / 目）。
 *
 * 两种动作，一次只花一次模型预算：
 *
 * - `preview`：读现状 → 调一次模型 → 解析 → 按规则层算出"会新增 / 会删除 /
 *   会跳过" → **不写库**，把计划和摘要一起还给界面。
 * - `commit`：把 preview 返回的 `plan` 原样带回 → 在**同一个事务**里重读现状、
 *   重算计划（`strict`：预览之后大纲变过就整批拒绝，绝不部分落库）→ 写入。
 *
 * 为什么不是"点一下生成即写"：大纲是几十个目的骨架，而这份骨架的删除入口还
 * 只有接口没有界面。让用户在写入前看到"将会新增 6 章 / 18 节 / 54 目；将会跳过
 * 2 章；将会删除 0 项"，比生成完再道歉重要。而 commit 不再调模型，所以用户看过的
 * 就是写进去的，两次点击不会生成两份不同的东西。
 *
 * 覆盖语义（由 `lib/curriculum/series-outline-ai.ts` 的规则层决定，这里只转述）：
 * 系列里一旦有目，章/节就不能覆盖重建（目会失去归属）；目这一层只覆盖还没开始
 * 设计的目。当前状态不允许时，preview 里 `replaceAllowed=false` 并给理由。
 */
import { NextResponse, type NextRequest } from 'next/server';

import {
  SeriesOutlineAiAnswerError,
  SeriesOutlineAiConflictError,
  parseSeriesOutlineAiPlan,
  planSeriesOutlineAiApply,
  seriesOutlineAiBlockedSummary,
  seriesOutlineAiDesignSummary,
  seriesOutlineAiPreflight,
} from '@/lib/curriculum/series-outline-ai';
import { createLogger } from '@/lib/logger';
import { isSameOriginJsonRequest } from '@/lib/persistence/owner-claim-http';
import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import {
  designInvalid,
  runDesignRoute,
  type DesignContext,
} from '@/lib/server/curriculum/design-http';
import { curriculumJsonError } from '@/lib/server/curriculum/http';
import { parseSeriesOutlineAiRequest } from '@/lib/server/curriculum/series-outline-ai-validation';
import {
  applySeriesOutlineAiPlan,
  readSeriesOutlineAiContext,
} from '@/lib/server/curriculum/series-outline-ai';
import { draftSeriesOutlinePlan } from '@/lib/server/curriculum/series-outline-step';
import {
  backgroundWorkspaceId,
  SlotDisabledError,
  SlotUnassignedError,
} from '@/lib/server/model-config/runtime';
import { resolveModel } from '@/lib/server/resolve-model';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

const log = createLogger('SeriesOutlineAi');

/**
 * 生成用的模型阶段。与课程设计的前几步共用课程设计模型：这三步生成的都是
 * "结构"，不是素材，单独开一个 stage 是跨模块的配置改动，不是这里的决定。
 */
const OUTLINE_STAGE = 'scene-outlines-stream';

export async function POST(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    if (!isSameOriginJsonRequest(req)) {
      return curriculumJsonError(
        403,
        'CURRICULUM_OUTLINE_INVALID',
        '大纲生成必须是同源 JSON 请求',
        ctx.headers,
      );
    }
    const parsed = parseSeriesOutlineAiRequest(await ctx.body());
    if (!parsed.ok) return designInvalid(parsed.message, ctx.headers);

    const seriesId = ctx.taskId;
    const { level, action } = parsed.value;
    const mode = parsed.value.replace ? 'replace' : 'fill';

    if (action === 'preview') {
      const context = await readSeriesOutlineAiContext(ctx.queryable, ctx.ownerId, seriesId);
      if (!context) return seriesNotFound(ctx);

      // 现状不允许生成时不调模型：既省一次模型预算，也避免用户对着一个
      // 必然失败的对话框等三十秒。
      const preflight = seriesOutlineAiPreflight({ level, mode, context });
      if (preflight.blockedReason) {
        return ownerJson(
          {
            preview: seriesOutlineAiBlockedSummary(level, mode, preflight),
            plan: null,
            design: seriesOutlineAiDesignSummary(context.design),
          },
          200,
          ctx.headers,
        );
      }

      const model = await resolveSeriesOutlineModel(ctx);
      if ('response' in model) return model.response;

      let plan;
      try {
        plan = await draftSeriesOutlinePlan(
          { level, mode, context, model: model.value },
          { log, signal: req.signal },
        );
      } catch (error) {
        if (req.signal.aborted) {
          return curriculumJsonError(
            499,
            'CURRICULUM_OUTLINE_FAILED',
            '大纲生成被取消',
            ctx.headers,
          );
        }
        if (error instanceof SeriesOutlineAiAnswerError) {
          log.warn(`Series outline answer unusable (${level}/${mode}): ${error.message}`);
          return curriculumJsonError(502, 'CURRICULUM_OUTLINE_FAILED', error.message, ctx.headers);
        }
        throw error;
      }

      const summary = planSeriesOutlineAiApply({ level, mode, plan, context });
      return ownerJson(
        { preview: summary, plan, design: seriesOutlineAiDesignSummary(context.design) },
        200,
        ctx.headers,
      );
    }

    // commit：先确认系列存在，再在一次事务里重读、重算、写入。
    const exists = await readSeriesOutlineAiContext(ctx.queryable, ctx.ownerId, seriesId);
    if (!exists) return seriesNotFound(ctx);

    let plan;
    try {
      plan = parseSeriesOutlineAiPlan(level, parsed.value.plan);
    } catch (error) {
      if (error instanceof SeriesOutlineAiAnswerError) {
        return curriculumJsonError(400, 'CURRICULUM_OUTLINE_INVALID', error.message, ctx.headers);
      }
      throw error;
    }

    try {
      const outcome = await ctx.write(async (tx) => {
        const fresh = await readSeriesOutlineAiContext(tx, ctx.ownerId, seriesId);
        if (!fresh) throw new SeriesOutlineAiConflictError('课程系列不存在');
        const summary = planSeriesOutlineAiApply({
          level,
          mode,
          plan,
          context: fresh,
          strict: true,
        });
        if (!summary.canCommit) {
          throw new SeriesOutlineAiConflictError(
            summary.blockedReason ?? '这次生成没有可写入的内容。',
          );
        }
        const committed = await applySeriesOutlineAiPlan(tx, ctx.ownerId, fresh, summary);
        return { committed, summary };
      });
      return ownerJson(
        { committed: outcome.committed, preview: outcome.summary },
        201,
        ctx.headers,
      );
    } catch (error) {
      if (error instanceof SeriesOutlineAiConflictError) {
        return curriculumJsonError(409, 'CURRICULUM_OUTLINE_CONFLICT', error.message, ctx.headers);
      }
      throw error;
    }
  });
}

function seriesNotFound(ctx: DesignContext) {
  return curriculumJsonError(404, 'CURRICULUM_SERIES_NOT_FOUND', '课程系列不存在', ctx.headers);
}

async function resolveSeriesOutlineModel(
  ctx: DesignContext,
): Promise<{ value: Awaited<ReturnType<typeof resolveModel>> } | { response: NextResponse }> {
  try {
    return {
      value: await resolveModel({
        stage: OUTLINE_STAGE,
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
