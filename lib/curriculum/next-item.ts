/**
 * "现在该做哪一目" —— 驾驶舱唯一的主角。
 *
 * 这个模块回答的是设计稿 §4.1 里那块大卡片的问题。选它而不是让前端自己排，是
 * 因为排序规则本身就是一件有争议的事：把"有阻塞缺陷的目"排在最前，理由是它
 * 出不了片；把阶段靠前的目排在最前，理由是它离产出最近；两者在某些数据下会
 * 打架。规则写在界面里就会各处不一（待办区一套、看板一套、"继续上次"一套），
 * 写成纯函数才能配测试、才能被后续所有入口复用。
 *
 * 纯函数，不读库：输入是调用方已经读到的聚合行。理由与 `chooseProductionPath`
 * 相同——驾驶舱需要在一次渲染里同时知道"现在做哪个"和"还有哪些卡住"，那要求
 * 两次查询就等于两次渲染之间可能各自给出不同的答案。
 */

import {
  CURRICULUM_DESIGN_PHASES,
  type CurriculumDesignPhase,
} from '@/lib/curriculum/design-types';
import { PHASE_STATE_LABEL, STEP_LABEL } from '@/lib/curriculum/ui-labels';

/**
 * 一目的聚合行。
 *
 * 只取判断需要的六件事，其余一律不传进来。这里**刻意不含 title 之外的任何文案
 * 字段**：理由由本模块生成，因为理由必须和排序规则一致——一旦允许调用方自带
 * "reason"，就会出现"排在第一的理由是别人编的"这种无法调试的状态。
 */
export interface NextItemRow {
  taskId: string;
  code: string | null;
  title: string;
  phase: CurriculumDesignPhase;
  /** 条目数（章 + 目），用来判断这还是不是一副骨架。 */
  unitCount: number;
  /** 已产出课堂（`stageId` 非空）的目数，0 即未出片。 */
  producedCount: number;
  /** 学习目标数，为 0 表示第 2 步还什么都没定。 */
  objectiveCount: number;
  /** 未被接受的 `error` 级审核发现数 —— 这些目现在出不了片。 */
  blockingCount: number;
  updatedAt: string;
}

export interface NextItemDecision {
  taskId: string;
  code: string | null;
  title: string;
  phase: CurriculumDesignPhase;
  /** 一句话说明为什么是它，用户语言。 */
  reason: string;
  /** 阻塞时的具体缺口，逐条可读，例如"3 处审核未处理"。 */
  blockers: string[];
  /** 下一步动作的中文动词短语，例如"定它的学习目标"。 */
  actionLabel: string;
  /** 排序键里最靠前的那一条理由分类，供界面配色与"待办"分组共用。 */
  cause: 'blocked' | 'in-progress' | 'not-started';
}

/** 每一步对应的下一步动作。用户看到的是这个动词短语，不是阶段名。 */
const PHASE_ACTION: Record<CurriculumDesignPhase, string> = {
  task: '写下这门课是什么',
  outcomes: '定它的学习目标',
  graph: '定它需要哪些前置知识',
  outline: '定它讲几段、怎么排',
  teaching: '写每一段的讲稿与分镜',
  assessment: '配它的题目与实操',
  review: '读它的审核结论',
};

/**
 * 未出片的目才会被选中。
 *
 * 已出片的目仍然可以在驾驶舱里点进去改，但"现在该做什么"不该指向一个已经有
 * 课堂的目——那是在建议用户重做已完成的事。要改，出片看板里点。
 */
function isProduced(row: NextItemRow): boolean {
  return row.producedCount > 0;
}

/**
 * 一目的优先级排序。
 *
 * 三条规则按顺序判，先命中先返回：
 *
 * 1. **有阻塞缺陷**（`blockingCount > 0`）。压过一切。它是唯一"不做就白做"的
 *    情况：设计已经走到能出片了，一处 error 却拦着导出，此刻任何新内容都排在
 *    它后面都是错的。
 * 2. **正在设计中**（`updatedAt` 最新的未出片目）。这是"继续上次"，用户刚放下
 *    的那一目。放在"还没开始"之前，因为重新打开一件事的成本远高于开始一件新的。
 * 3. **还没开始**。按 `updatedAt` 升序 —— 数据库里没有"第几目"的权威顺序
 *    （`orderIndex` 是目内部的，大纲之外的目没有），所以最早创建的最接近
 *    "接下来该做的"，而不是 `orderIndex`，那会让驾驶舱的推荐随数据形状漂移。
 *
 * 排序键完整写死在这里而不是分散比较，是为了能写一条测试把优先级钉死：否则
 * "我为什么被推荐了这一目"永远无法回答。
 */
function compareRows(a: NextItemRow, b: NextItemRow): number {
  if (a.blockingCount !== b.blockingCount) return b.blockingCount - a.blockingCount;
  const aStarted = a.phase !== 'task' || a.objectiveCount > 0 || a.unitCount > 0;
  const bStarted = b.phase !== 'task' || b.objectiveCount > 0 || b.unitCount > 0;
  if (aStarted !== bStarted) return aStarted ? -1 : 1;
  // 同为进行中：最近动的在前。同为未开始：最早建的在前。
  return aStarted ? b.updatedAt.localeCompare(a.updatedAt) : a.updatedAt.localeCompare(b.updatedAt);
}

/**
 * 待办列表的顺序，与 `chooseNextItem` 完全一致。
 *
 * 单独导出是因为驾驶舱同时要两块信息：大卡片要**一个**推荐，待办要**一列**顺序。
 * 两块各自写排序就会出现"大卡片推 2-1-2，待办第一条是 2-2-1"，而用户没有任何
 * 办法判断哪个才是系统的想法——这正是"看一眼没有想法"的成因之一。共用一个比较
 * 函数后，二者的第一条在构造上就不可能不同。
 *
 * 已出片的目被剔除，理由与 `chooseNextItem` 相同：待办是"要动手的事"。
 */
export function pendingItems(rows: readonly NextItemRow[]): NextItemRow[] {
  return rows.filter((row) => !isProduced(row)).sort(compareRows);
}

/**
 * 选出驾驶舱要推荐的那一目。
 *
 * 返回 `null` 的情况只有一种：所有目都已出片。没有目、没有目标、章都算哪一种
 * ——骨架返回 `null` 是错的，因为"还没建第一个目"本身就是下一步，界面必须能说出
 * 来。所以空输入由调用方渲染空状态，而不是让本函数编一个理由。
 */
export function chooseNextItem(rows: readonly NextItemRow[]): NextItemDecision | null {
  const candidates = pendingItems(rows);
  if (candidates.length === 0) return null;
  return decisionFor(candidates[0], candidates);
}

/**
 * 把一行变成"为什么是它 + 下一步做什么 + 卡在哪"。
 *
 * 理由的措辞分三种情况，因为它们要求用户做的事根本不同：有阻塞缺陷时要做的是
 * 修东西而不是往前推；已经在设计中是接着干；还没开始是开个头。把这三种混成
 * "继续完成 2-1-2"，就是设计稿里说的那种"看一眼没有想法"。
 */
function decisionFor(row: NextItemRow, all: readonly NextItemRow[]): NextItemDecision {
  const base = {
    taskId: row.taskId,
    code: row.code,
    title: row.title,
    phase: row.phase,
    actionLabel: PHASE_ACTION[row.phase],
  };

  if (row.blockingCount > 0) {
    return {
      ...base,
      cause: 'blocked',
      reason: `设计已经做到能出片这一步，但有 ${row.blockingCount} 处审核问题挡住了导出。`,
      blockers: [`${row.blockingCount} 处审核未处理`],
    };
  }

  const isSkeleton = row.phase === 'task' && row.unitCount === 0 && row.objectiveCount === 0;
  if (isSkeleton) {
    const siblings = all.filter((other) => other.taskId !== row.taskId).length;
    return {
      ...base,
      cause: 'not-started',
      reason: `还没开始设计。${siblings > 0 ? `同一系列里还有 ${siblings} 目。` : ''}从"${PHASE_STATE_LABEL.task}"开始。`,
      blockers: [],
    };
  }

  const started = row.phase !== 'task';
  return {
    ...base,
    cause: started ? 'in-progress' : 'not-started',
    reason: `卡在第 ${CURRICULUM_DESIGN_PHASES.indexOf(row.phase) + 1} 步 · ${STEP_LABEL[row.phase]}。`,
    blockers: [],
  };
}
