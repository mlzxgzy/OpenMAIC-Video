/**
 * POST /api/curriculum/design/tasks/[id]/knowledge/draft — 起草，**一行都不写**。
 *
 * 为什么不是给 turn 路由加个 `dryRun` 字段：那个路由里有一整段写库代码，加了标志就得
 * 让每个写点都记得看标志，漏一处就是一次"预览"直接改了库——而且是那种界面上完全看不
 * 出来的改。这里**整个 handler 里没有一次 `ctx.write`**，不写库不是靠一个条件，是靠
 * 源码里根本没有那个调用；测试也按这个前提钉住。
 *
 * 复用的是 turn 路由的**确定性那一半**：模型照常回答，`resolveKnowledgeTurn` 照常把
 * ref 解析成真实 id、照常做环检测、照常算出这一轮之后的整份连线集合。所以草稿里看到的
 * 端点就是真端点，作者按下采纳时写的就是它自己。
 *
 * 三个刻意的决定：
 *
 * 1. **草稿里没有"确认"。** `resolveKnowledgeTurn` 会在作者说"确认"时给
 *    `confirmRequested`，这里**故意不落**——签收是作者的动作，AI 说"可以签了"不算。
 *    把这个字段丢掉而不是透传给界面，是为了界面里不存在"AI 已经替你确认"的分支。
 * 2. **`patches` 从 Map 变成数组。** 序列化 Map 会得到 `{}`，前端只能看到"有改动"
 *    却不知道改了什么。这里换成 `[{ nodeId, patch }]`，顺序按节点 id 排定，免得同一个
 *    草稿两次渲染的行序不同。
 * 3. **回包里带着这轮所依据的图。** 作者看到的每一条都要能对上"现在库里是什么样"，
 *    而右栏是一个只画草稿、不读库的独立面板。多回一份 `board` 比让它再发一次请求更
 *    少一次可以过期的时间差。
 */
import { NextResponse, type NextRequest } from 'next/server';

import { createLogger } from '@/lib/logger';
import { isSameOriginJsonRequest } from '@/lib/persistence/owner-claim-http';
import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { curriculumJsonError } from '@/lib/server/curriculum/http';
import {
  designInvalid,
  runDesignRoute,
  type DesignContext,
} from '@/lib/server/curriculum/design-http';
import {
  getCurriculumDesignSnapshot,
  getCurriculumTask,
} from '@/lib/server/curriculum/design-store';
import { parseConversationTurnRequest } from '@/lib/server/curriculum/design-validation';
import {
  KnowledgeAnswerError,
  draftCourseKnowledge,
  formatDirectionLine,
  knowledgeBoardOf,
  type CourseKnowledgeTurn,
} from '@/lib/server/curriculum/knowledge-step';
import {
  backgroundWorkspaceId,
  SlotDisabledError,
  SlotUnassignedError,
} from '@/lib/server/model-config/runtime';
import { resolveModel } from '@/lib/server/resolve-model';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

const log = createLogger('CourseKnowledgeDraft');

/** 借用大纲阶段的模型，与 turn 路由同一个 slot，理由也相同。 */
const KNOWLEDGE_STAGE = 'scene-outlines-stream';

export async function POST(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    if (!isSameOriginJsonRequest(req)) {
      return curriculumJsonError(
        403,
        'CURRICULUM_DESIGN_INVALID',
        '知识技能图起草必须是同源 JSON 请求',
        ctx.headers,
      );
    }
    const task = await getCurriculumTask(ctx.queryable, ctx.ownerId, ctx.taskId);
    if (!task) {
      return curriculumJsonError(
        404,
        'CURRICULUM_DESIGN_NOT_FOUND',
        '课程设计任务不存在',
        ctx.headers,
      );
    }
    const parsed = parseConversationTurnRequest(await ctx.body());
    if (!parsed.ok) return designInvalid(parsed.message, ctx.headers);

    const model = await resolveKnowledgeModel(ctx);
    if ('response' in model) return model.response;

    const before = await getCurriculumDesignSnapshot(ctx.queryable, ctx.ownerId, task.id);
    const board = knowledgeBoardOf(
      before.nodes,
      before.objectives,
      before.nodeObjectives,
      before.dependencies,
    );

    let turn;
    try {
      turn = await draftCourseKnowledge(
        {
          direction: formatDirectionLine(task),
          board,
          // 历史**截断到最后一条用户消息**：右栏是草稿面板而不是聊天记录，它只需要让模型
          // 知道前面已经确认过什么。把整段对话传进来只会让 prompt 越来越长，而采纳与否
          // 本来就不进历史——采纳走的是已经存在的写入路由。
          history: lastUserTurns(parsed.value.history as CourseKnowledgeTurn[]),
          instruction: parsed.value.instruction,
          model: model.value,
        },
        { log, signal: req.signal },
      );
    } catch (error) {
      if (req.signal.aborted) {
        return curriculumJsonError(
          499,
          'CURRICULUM_DESIGN_FAILED',
          '知识技能图起草被取消',
          ctx.headers,
        );
      }
      if (error instanceof KnowledgeAnswerError) {
        log.warn(`Course knowledge draft unusable: ${error.message}`);
        return curriculumJsonError(502, 'CURRICULUM_DESIGN_FAILED', error.message, ctx.headers);
      }
      throw error;
    }

    return ownerJson(
      {
        message: turn.message,
        warnings: turn.warnings,
        instruction: parsed.value.instruction,
        added: turn.added,
        patches: [...turn.patches.entries()]
          .map(([nodeId, patch]) => ({ nodeId, patch }))
          .sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
        removed: [...turn.removed].sort(),
        links: turn.links,
        dependencies: turn.dependencies,
        removedDependencies: turn.removedDependencies,
        unmatchedRefs: turn.unmatchedRefs,
        rejectedRefs: turn.rejectedRefs,
        // 作者要能对上"现在库里是什么样"，所以右栏不自己读库，改由这一个包给出。
        currentLinks: before.nodeObjectives.map((link) => ({
          nodeId: link.nodeId,
          objectiveId: link.objectiveId,
          supportLevel: link.supportLevel,
        })),
        nodeNameById: Object.fromEntries(before.nodes.map((row) => [row.id, row.name])),
        objectiveTitleById: Object.fromEntries(before.objectives.map((row) => [row.id, row.title])),
      },
      200,
      ctx.headers,
    );
  });
}

/** 历史只留到最后一条用户消息，其后的助手回答都是这一轮草稿的结果本身。 */
function lastUserTurns(history: readonly CourseKnowledgeTurn[]): CourseKnowledgeTurn[] {
  let cut = -1;
  history.forEach((turn, index) => {
    if (turn.role === 'user') cut = index;
  });
  return cut < 0 ? [] : history.slice(0, cut + 1);
}

/**
 * 没有模型时的 400，和 turn 路由一样：这是配置问题，作者能照着做，不是 500。
 */
async function resolveKnowledgeModel(
  ctx: DesignContext,
): Promise<{ value: Awaited<ReturnType<typeof resolveModel>> } | { response: NextResponse }> {
  try {
    return {
      value: await resolveModel({
        stage: KNOWLEDGE_STAGE,
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
