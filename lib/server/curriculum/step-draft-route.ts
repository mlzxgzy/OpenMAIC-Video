/**
 * 起草路由的骨架：`POST .../<step>/draft` —— 起草，**一行都不写**。
 *
 * 为什么不给 turn 路由加一个 `dryRun` 字段：那个路由里有一整段写库代码，加了标志就得
 * 让每个写点都记得看标志，漏一处就是一次"预览"直接改了库——而且是那种界面上完全看不
 * 出来的改。
 *
 * 所以这里不靠标志，靠**类型**：{@link StepDraftRouteContext} 是 `DesignContext` 去掉
 * `write` 之后的那部分（再加上一个它需要的方法），步骤定义拿到它就**调不到**任何写库
 * 函数，连编译都过不了。知识技能图那条路由（`knowledge/draft`）当初是靠"handler 里没有
 * `ctx.write`"这件事由一条读源码的测试钉住的；现在这条不变量由类型系统保证，测试降级成
 * 回归——它仍然在，但不再是唯一的防线。
 *
 * 骨架负责五件事，每件都是四个步骤真正相同的那部分：
 *
 * 1. **同源校验 + 任务存在 + 请求体解析**，失败按 step 的说法回答。
 * 2. **阶段校验**。起草是"让模型说"，但它仍然要花钱、仍然只有在前一步签过字之后才说得出
 *    话；而且比 turn 路由多一层理由——草稿会被采纳，采纳是真的写入，所以它必须和写入
 *    受同一道阶段门。
 * 3. **起草前先读一次库**，把 `before` 交给步骤。这是"采纳那一刻重算整表"的对照物。
 * 4. **错误映射**：被取消 499、回答不可用 502、没配模型 400。三者与 turn 路由相同。
 * 5. **回包**是 `{ ...payload, draft }`，其中 `draft` 由步骤自己算——它算的是"这一轮的行"，
 *    而 `payload` 是"现在库里是什么样"。两个都由服务端给，右栏因此不必自己读库。
 */

import { NextResponse, type NextRequest } from 'next/server';

import {
  CURRICULUM_DESIGN_PHASES,
  type CurriculumDesignPhase,
} from '@/lib/curriculum/design-types';
import { isSameOriginJsonRequest } from '@/lib/persistence/owner-claim-http';
import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { curriculumJsonError } from '@/lib/server/curriculum/http';
import {
  designInvalid,
  runDesignRoute,
  type DesignContext,
} from '@/lib/server/curriculum/design-http';
import { getCurriculumTask } from '@/lib/server/curriculum/design-store';
import { stepLockMessage } from '@/lib/curriculum/ui-labels';
import { parseConversationTurnRequest } from '@/lib/server/curriculum/design-validation';
import {
  backgroundWorkspaceId,
  SlotDisabledError,
  SlotUnassignedError,
} from '@/lib/server/model-config/runtime';
import { resolveModel } from '@/lib/server/resolve-model';
import type { StepLanguageModel } from '@/lib/server/generation/steps/context';
import type { LlmStage } from '@/lib/server/model-routes';
import type { createLogger } from '@/lib/logger';

/** `createLogger` 的返回值类型——它没有单独导出一个名字。 */
type StepLog = ReturnType<typeof createLogger>;

/**
 * 步骤定义拿到的上下文。**刻意没有 `write`。**
 *
 * 这是整个骨架的核心不变量，见文件头。也不给 `req` 与 `queryable` 之外的东西：起草只
 * 需要"任务、请求体、模型"，而少给一样东西就少一种"顺手里读了一下别的表"的写法。
 */
export interface StepDraftRouteContext {
  task: Awaited<ReturnType<typeof getCurriculumTask>> & object;
  headers: Headers;
  instruction: string;
  /** 起草之前的设计快照，由骨架读好。 */
  before: unknown;
  /**
   * 对话历史，**截断到最后一条用户消息**。
   *
   * 右栏是草稿面板而不是聊天记录，它只需要让模型知道前面已经确认过什么；其后的助手回答
   * 都是上一轮草稿的结果本身，传进去只会让 prompt 越来越长。采纳与否不进历史——采纳走
   * 的是已经存在的写入路由。
   */
  history: readonly DraftTurn[];
}

export interface DraftTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface StepDraftRouteConfig<TBefore, TTurn> {
  /** 这一步的稳定名，用于日志与错误文案。 */
  step: string;
  /** 起草至少要走到的阶段。与 turn 路由同一个门槛。 */
  requiredPhase: CurriculumDesignPhase;
  /** 「没有为课程设计配置语言模型」之外的前缀，例如「学习目标对话」。 */
  subject: string;
  log: StepLog;
  /** 借用的模型 slot。与各 turn 路由保持一致。 */
  modelStage: LlmStage;
  /** 读起草前的设计。 */
  readBefore: (ctx: DesignContext, taskId: string) => Promise<TBefore>;
  /** 跑一次模型对话。**必须一行都不写。** */
  draft: (input: {
    ctx: StepDraftRouteContext;
    before: TBefore;
    model: StepLanguageModel;
    log: StepLog;
    signal: AbortSignal;
  }) => Promise<TTurn>;
  /**
   * 把这一轮的结果算成草稿行 + 回包其余部分。
   *
   * `taskId` 在这里而不是让 `draftOf` 自己猜：草稿的行会被原样发成 HTTP 请求，所以路径
   * 必须在**起草那一刻**就是完整的，而它只能由服务端知道。
   */
  shape: (input: {
    turn: TTurn;
    before: TBefore;
    taskId: string;
    instruction: string;
  }) => Promise<{ draft: unknown; extra?: Record<string, unknown> }>;
}

/** 阶段顺序，所以"这一步走到了没有"读起来是一行。 */
function phaseRank(phase: CurriculumDesignPhase): number {
  return CURRICULUM_DESIGN_PHASES.indexOf(phase);
}

/**
 * 历史只留到最后一条用户消息，其后的助手回答都是这一轮草稿的结果本身。
 *
 * 右栏是草稿面板而不是聊天记录，它只需要让模型知道前面已经确认过什么；把整段对话传进去
 * 只会让 prompt 越来越长，而采纳与否本来就不进历史——采纳走的是已经存在的写入路由。
 */
function lastUserTurns(
  history: readonly { role: 'user' | 'assistant'; content: string }[],
): { role: 'user' | 'assistant'; content: string }[] {
  let cut = -1;
  history.forEach((turn, index) => {
    if (turn.role === 'user') cut = index;
  });
  return cut < 0 ? [] : history.slice(0, cut + 1);
}

/** 没有模型时的 400：这是配置问题，作者能照着做，不是 500。 */
async function resolveStepModel(
  ownerId: string,
  stage: LlmStage,
  headers: Headers,
): Promise<{ value: StepLanguageModel } | { response: NextResponse }> {
  try {
    return {
      value: await resolveModel({ stage, workspaceId: await backgroundWorkspaceId(ownerId) }),
    };
  } catch (error) {
    if (error instanceof SlotUnassignedError || error instanceof SlotDisabledError) {
      return {
        response: curriculumJsonError(400, 'MISSING_MODEL', '没有为课程设计配置语言模型', headers),
      };
    }
    throw error;
  }
}

/**
 * 造一个 `POST` handler。
 *
 * `config.shape` 抛出来的**领域错误**（模型回答不可用）由 `config.answerError` 判定并
 * 映射成 502——与 turn 路由同一条规则：不可用的回答不能落库，而这里连库都碰不到，
 * 所以失败只表现为"什么都没发生，而且作者看到了原因"。
 */
export function stepDraftRoute<TBefore, TTurn>(
  config: StepDraftRouteConfig<TBefore, TTurn> & {
    /** 模型回答不可用时的错误类型。 */
    answerError: new (...args: never[]) => Error;
  },
): (req: NextRequest, context: { params: Promise<{ id: string }> }) => Promise<Response> {
  return async (req, { params }) =>
    runDesignRoute(req, params, async (ctx): Promise<NextResponse> => {
      if (!isSameOriginJsonRequest(req)) {
        return curriculumJsonError(
          403,
          'CURRICULUM_DESIGN_INVALID',
          `${config.subject}必须是同源 JSON 请求`,
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
      if (phaseRank(task.designPhase) < phaseRank(config.requiredPhase)) {
        return curriculumJsonError(
          409,
          'CURRICULUM_DESIGN_PHASE_LOCKED',
          // 这句话原来直接插了 `task.designPhase` 与 `config.requiredPhase` 两个字面量，
          // 用户在界面上读到的是"当前处于「outcomes」阶段；推进到「graph」阶段"。
          // 现在与门禁按钮、卡片角标共用 `stepLockMessage`，说的是"第几步、哪一步"。
          stepLockMessage(task.designPhase, config.requiredPhase, config.subject),
          ctx.headers,
        );
      }
      const parsed = parseConversationTurnRequest(await ctx.body());
      if (!parsed.ok) return designInvalid(parsed.message, ctx.headers);

      const model = await resolveStepModel(ctx.ownerId, config.modelStage, ctx.headers);
      if ('response' in model) return model.response;

      const before = await config.readBefore(ctx, task.id);

      let turn: TTurn;
      try {
        turn = await config.draft({
          // 注意这里没有 `write`：`StepDraftRouteContext` 就没有这个字段。
          ctx: {
            task,
            headers: ctx.headers,
            instruction: parsed.value.instruction,
            before,
            history: lastUserTurns(parsed.value.history as DraftTurn[]),
          },
          before,
          model: model.value,
          log: config.log,
          signal: req.signal,
        });
      } catch (error) {
        if (req.signal.aborted) {
          return curriculumJsonError(
            499,
            'CURRICULUM_DESIGN_FAILED',
            `${config.subject}被取消`,
            ctx.headers,
          );
        }
        if (error instanceof config.answerError) {
          config.log.warn(`Course ${config.step} draft unusable: ${error.message}`);
          return curriculumJsonError(502, 'CURRICULUM_DESIGN_FAILED', error.message, ctx.headers);
        }
        throw error;
      }

      const { draft, extra } = await config.shape({
        turn,
        before,
        taskId: task.id,
        instruction: parsed.value.instruction,
      });

      return ownerJson({ ...(extra ?? {}), draft }, 200, ctx.headers);
    });
}
