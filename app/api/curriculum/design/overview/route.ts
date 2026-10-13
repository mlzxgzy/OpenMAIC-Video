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
        // The code is the 目's own (`2-1-2`), not the task's title: the matrix
        // groups by chapter and labels by code, and a "code" that is a sentence
        // makes both unreadable. Falls back to empty so the UI can hide it
        // rather than print a title twice.
        const code =
          snapshot.units.find((unit) => unit.unitType === 'item' && unit.code)?.code ?? '';
        return {
          taskId: task.id,
          code,
          title: task.title,
          phase: task.designPhase,
          unitCount: snapshot.units.length,
          itemCount: snapshot.units.filter((unit) => unit.unitType === 'item').length,
          producedCount: snapshot.units.filter((unit) => unit.stageId !== null).length,
          objectiveCount: snapshot.objectives.length,
          blockingCount: evaluation.blocking.length,
          acceptedCount: evaluation.accepted.length,
          exportable: evaluation.exportable,
          updatedAt: task.updatedAt,
        };
      }),
    );

    return ownerJson({ rows }, 200, ctx.headers);
  });
}
