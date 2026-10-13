/**
 * "这个目现在卡住了几处" —— 驾驶舱那个红色计数到底该数什么。
 *
 * 存在的理由是一次被浏览器测试抓到的误报。`evaluateCurriculumDesign` 返回的
 * `blocking` 是**整份设计**的 error 级发现，包括"还没有任何条目：教学设计是逐条
 * 写的"这种"后面某一步还没做"的报告。于是刚确认课程方向、一步都还没走的一目，
 * 驾驶舱显示"4 处审核问题挡住了导出"——它一处缺陷都没有，只是审核在报告未来。
 *
 * 后果不是难看，是**排序被彻底带偏**：`chooseNextItem` 把"有阻塞"排在最前，
 * 于是每一次新建的目都会因为"还没做后面几步"而抢到主角位，用户打开驾驶舱看到的
 * 第一件事永远是"这一目有 4 处问题"，而点进去什么也修不了。
 *
 * 规则：一条发现只有在它所属的层**已经被这份设计走到**时才算"现在卡住"。
 * 没走到的层上的一句话不是缺陷，是进度。层与阶段的对应写死在
 * {@link PHASE_REACHED_LAYERS}，并由 `next-item.test.ts` 之外的用例钉住边界——
 * 阶段机与审核各有一份阶段顺序（`CURRICULUM_DESIGN_PHASES` 与
 * `CURRICULUM_QUALITY_LAYERS`），这里把两者对起来，对错了就是静默漏报。
 *
 * 纯函数：不读库、不调审核，输入是调用方已经算好的发现列表。
 */

import { CURRICULUM_QUALITY_LAYERS, type CurriculumQualityLayer } from './audit';
import type { CurriculumAuditFinding } from './audit';
import { CURRICULUM_DESIGN_PHASES, type CurriculumDesignPhase } from './design-types';

/**
 * 每个阶段"已经走到"的层，含该阶段自己正在做的层。
 *
 * 对应关系是设计上的，不是巧合：
 *
 * | 阶段 | 走到哪 | 层的含义 |
 * |---|---|---|
 * | `task` | —（无） | 简介还没写就是还没写，不是缺陷 |
 * | `outcomes` | outcomes_clear, outcomes_verifiable | 目标写得清不清、能不能验证 |
 * | `graph` | + support_complete, dependency_valid | 前置知识与依赖关系 |
 * | `outline` | + curriculum_covers | 条目排出来了吗 |
 * | `teaching` | + teach_covers | 每一条讲没讲 |
 * | `assessment` | + practice_covers, assess_covers | 练没练、考没考 |
 * | `review` | + traceable | 端到端可追溯 |
 *
 * `review` 之后的层全部到达，所以一目的最终状态与导出闸门口径一致：此刻
 * `countBlockingFindings` 与 `evaluation.blocking.length` 必然相等。这不是巧合，
 * 是"阶段机走完 = 审核全面生效"这条不变式的直接后果，也是为什么
 * `next-item` 只需在早期阶段做减法。
 *
 * 缺一个阶段会怎样：某一层永远算"没走到"，那一层上的真缺陷就永远不计数——
 * 缺陷从此隐形。所以这个表**必须**在阶段或层任一方增删时同步，`tests/curriculum`
 * 里有一条测试比对两侧的长度。
 */
const PHASE_REACHED_LAYERS: Record<CurriculumDesignPhase, readonly CurriculumQualityLayer[]> = {
  task: [],
  outcomes: ['outcomes_clear', 'outcomes_verifiable'],
  graph: ['outcomes_clear', 'outcomes_verifiable', 'support_complete', 'dependency_valid'],
  outline: [
    'outcomes_clear',
    'outcomes_verifiable',
    'support_complete',
    'dependency_valid',
    'curriculum_covers',
  ],
  teaching: [
    'outcomes_clear',
    'outcomes_verifiable',
    'support_complete',
    'dependency_valid',
    'curriculum_covers',
    'teach_covers',
  ],
  assessment: [
    'outcomes_clear',
    'outcomes_verifiable',
    'support_complete',
    'dependency_valid',
    'curriculum_covers',
    'teach_covers',
    'practice_covers',
    'assess_covers',
  ],
  review: CURRICULUM_QUALITY_LAYERS,
};

/** 某一层在这一阶段是否已经走到了。 */
export function layerReachedAt(
  layer: CurriculumQualityLayer,
  phase: CurriculumDesignPhase,
): boolean {
  return PHASE_REACHED_LAYERS[phase].includes(layer);
}

/**
 * 这一目"现在卡住了几处"。
 *
 * 只数 `error` 级：`warning`/`note` 从来不拦导出，驾驶舱的红色计数若把它们算进去，
 * 用户会为一个从不拦任何事的问题放下别的工作。已接受（waived）的缺陷在调用方
 * 就不该出现（传入的应是 `blocking` 而不是 `findings`），这里不再重复过滤——
 * 但显式跳过 `status === 'waived'`，因为多传一份 `findings` 是很容易犯的错，
 * 而"接受过的缺陷又被算成阻塞"正是第八步刚修掉的那类 bug。
 */
export function countBlockingFindings(
  findings: readonly CurriculumAuditFinding[],
  phase: CurriculumDesignPhase,
): number {
  const reached = PHASE_REACHED_LAYERS[phase];
  let count = 0;
  for (const finding of findings) {
    if (finding.severity !== 'error') continue;
    if (!reached.includes(finding.layer)) continue;
    count += 1;
  }
  return count;
}

/** {@link PHASE_REACHED_LAYERS} 的可达层是否单调不减：后面的阶段不会少看到一层。 */
export function reachedLayersAreMonotonic(): boolean {
  const seen: CurriculumQualityLayer[] = [];
  for (const phase of CURRICULUM_DESIGN_PHASES) {
    const layers = PHASE_REACHED_LAYERS[phase];
    for (const layer of layers) {
      if (seen.includes(layer)) continue;
      seen.push(layer);
    }
    // 每个阶段的层必须恰好是"到该阶段为止累计出现过的层"，否则有层被跳过。
    if (layers.length !== new Set(layers).size) return false;
    if (layers.some((layer) => !seen.includes(layer))) return false;
  }
  return true;
}
