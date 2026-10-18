/**
 * GET /api/curriculum/design/overview — 一个系列（或全部）的目级聚合。
 *
 * 驾驶舱要回答的是"现在做哪一目、还有哪些卡住、整体到什么程度"，这三件事都跨
 * 任务：单位是目（一行 `curriculum_task`），而取数只能从库按任务逐个读设计快照。
 * 沿用已有的 `/design/tasks/[id]`（整份设计）会让驾驶舱发出 N+1 次请求，并且
 * 每次拿回几十 KB 只需要其中六个数字。
 *
 * 这个接口只做**聚合并逐字返回**，不做推荐。推荐是 `chooseNextItem` 的事，放在
 * 纯函数里。混进服务端就会得到一个无法单测、且前端的"继续上次"入口和驾驶舱
 * 各算一遍的排序——设计稿 §7.2 的原话，这里照做。
 *
 * 阻塞数在**派生层**算而不是数库里的行：`curriculum_audit_finding` 只在显式审核
 * 时同步（见 `syncCurriculumAuditFindings`），一份改过但没点过审核的设计，库里的
 * finding 表是旧的。直接数行会让"我有 3 处阻塞"的判断取决于用户上一次什么时候
 * 点了审核，而界面不会说这件事。所以这里读快照重新派生，代价是每目一次审计，
 * 换来的是这个数字和导出闸门口径一致。
 */
import type { NextRequest } from 'next/server';

import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { countBlockingFindings } from '@/lib/curriculum/blocking-scope';
import { runDesignRoute } from '@/lib/server/curriculum/design-http';
import {
  evaluateCurriculumDesign,
  getCurriculumDesignSnapshot,
  listCurriculumTasks,
} from '@/lib/server/curriculum/design-store';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  return runDesignRoute(req, undefined, async (ctx) => {
    const seriesId = req.nextUrl.searchParams.get('seriesId');
    const tasks = await listCurriculumTasks(ctx.queryable, ctx.ownerId, seriesId?.trim() || null);

    const rows = await Promise.all(
      tasks.map(async (task) => {
        const snapshot = await getCurriculumDesignSnapshot(ctx.queryable, ctx.ownerId, task.id);
        // The evaluation is what the export gate reads, so the count the cockpit
        // shows is the count that would actually refuse the export. Reading the
        // stored findings here instead would let the two disagree silently.
        const evaluation = evaluateCurriculumDesign(snapshot);
        // 只数**已经走到的那几层**上的 error：`evaluation.blocking` 包含
        // "还没有任何条目""还没有题目"这类"后面某一步还没做"的报告，直接计数
        // 会让刚建的一目显示"4 处审核问题挡住了导出"。见 `blocking-scope.ts`。
        const blockingCount = countBlockingFindings(evaluation.blocking, task.designPhase);
        // 编号先读目自己的（`curriculum_task.code`），老数据才回落到内部条目的
        // code。这个顺序是有意的：编号在创建时就该知道，而不是等走到第 4 步
        // 填了第一个条目才出现——驾驶舱在"先出章、再出节"的阶段就要显示它。
        const code =
          task.code ??
          snapshot.units.find((unit) => unit.unitType === 'item' && unit.code)?.code ??
          '';
        return {
          taskId: task.id,
          code,
          title: task.title,
          phase: task.designPhase,
          // 章/节的下标由驾驶舱用大纲树算，这里只给节 id 与同节内顺序：
          // 路由不该替界面决定目录怎么叠。
          sectionId: task.sectionId,
          kind: task.kind,
          orderIndex: task.orderIndex,
          unitCount: snapshot.units.length,
          itemCount: snapshot.units.filter((unit) => unit.unitType === 'item').length,
          producedCount: snapshot.units.filter((unit) => unit.stageId !== null).length,
          objectiveCount: snapshot.objectives.length,
          blockingCount,
          acceptedCount: evaluation.accepted.length,
          // 出片与否仍以闸门口径为准（`preconditions` + 全部 `blocking`），
          // 不跟着 `blockingCount` 一起收窄：那一位要回答的是"点生成会不会
          // 被拒绝"，而收缩后的计数会让早期阶段显示"能出片"。
          exportable: evaluation.exportable,
          updatedAt: task.updatedAt,
        };
      }),
    );

    return ownerJson({ rows }, 200, ctx.headers);
  });
}
