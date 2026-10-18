/**
 * 七步的归属：哪几步属于课程系列，哪几步属于某一目。
 *
 * 这套七步是**按「一门课」设计的流程**，而在《CTF 综合实战》这样的系列里，
 * 「一门课」是目（一节课、一个视频）。于是同一套七步在六十多个目上各走一遍，
 * 得到的是六十多份互相对不上的课程方向、六十多套互不相连的知识图，用户的原话是
 * 「每个目都有 7 步需要做？？？」和「咋又是课程方向和目标和大纲」。
 *
 * 本模块是这张表的**唯一一份**：界面的步骤条分组、目编辑器的横幅、目第 1 步卡片
 * 的只读/可编辑判断、以及系列设计页的说明，全部读它。写在别处就会出现「步骤条说
 * 是系列的、卡片却让人编辑」这种同屏矛盾——而它们都只在界面上看得出来。
 *
 * 归属的判据不是"哪个页面先做的"，而是**这件事一次定完对六十多个目都成立**：
 *
 * - 授课对象、学员基础、场景、范围、总学时：整个系列一份。让每个目各填一遍，
 *   得到的是六十份互相矛盾的答案，而不是六十份设计。
 * - 课程目标、知识体系：也是整个系列一张图。目只**承接**其中相关的几条/几个点。
 * - 本目分几段、每段讲什么、配哪些题和实操、审核：切到目这一级才有意义，
 *   因为它们描述的是「这一节课」。
 *
 * 注意第 4 步在系列层也有一个同名物：系列大纲（章 → 节 → 目）在驾驶舱里维护，
 * 它决定**有哪些目**；而第 4 步「本目大纲」决定**这一目内部讲几段**。两者不是
 * 同一件事，标签上刻意区分（见 `ui-labels.ts` 的 `STEP_WORK_NAME.outline`）。
 */

import type { CurriculumDesignPhase } from './design-types';
import { CURRICULUM_DESIGN_PHASE_ORDER } from './design-editing';

/** 这一件事是谁定的。`series` = 系列层定一次，所有目共用；`item` = 每一目各做一次。 */
export type StepOwner = 'series' | 'item';

/**
 * 本目在这一步**做什么**。
 *
 * - `inherit`：什么都不用填，继承系列的值，确认即可（确实不同的目可以覆盖）。
 * - `select`：系列给了全集，本目挑自己要承担的那几条。
 * - `own`：这是本目自己的工作，系列层没有对应物。
 */
export type ItemStepDuty = 'inherit' | 'select' | 'own';

export interface StepOwnership {
  owner: StepOwner;
  itemDuty: ItemStepDuty;
  /** 一句话说明归属，卡片横幅与文档共用。 */
  note: string;
}

/**
 * 七步归属表。键必须覆盖全部阶段——`Record<CurriculumDesignPhase, …>` 让漏一步
 * 变成编译错误，而不是界面上少一个分组。
 */
export const STEP_OWNERSHIP: Record<CurriculumDesignPhase, StepOwnership> = {
  task: {
    owner: 'series',
    itemDuty: 'inherit',
    note: '受众、基础、场景、课程范围、总学时都在系列层定一次；本目继承，只有本目确实不同时才覆盖。',
  },
  outcomes: {
    owner: 'series',
    itemDuty: 'select',
    note: '课程目标属于整个系列；本目从里面挑自己要承担的几条，并为每条写本目的证据。',
  },
  graph: {
    owner: 'series',
    itemDuty: 'select',
    note: '知识体系属于整个系列；本目只挑本目要讲的点，并连到承接的目标。',
  },
  outline: {
    owner: 'item',
    itemDuty: 'own',
    note: '本目分几段、每段讲/练/考什么、按什么顺序讲。系列大纲（章→节→目）只决定有哪些目。',
  },
  teaching: {
    owner: 'item',
    itemDuty: 'own',
    note: '这一目每一段的 slide 页面与讲稿。',
  },
  assessment: {
    owner: 'item',
    itemDuty: 'own',
    note: '这一目的理论题与 Docker 实操，挂在承诺了对应目标的条目上。',
  },
  review: {
    owner: 'item',
    itemDuty: 'own',
    note: '这一目自己的审核：漏教、漏练、漏考。系列完整性检查在驾驶舱，不在这七步里。',
  },
};

/** 系列层定的步骤（按步骤顺序）。顺序由阶段机派生，不另写一份清单。 */
export const SERIES_OWNED_PHASES: readonly CurriculumDesignPhase[] =
  CURRICULUM_DESIGN_PHASE_ORDER.filter((phase) => STEP_OWNERSHIP[phase].owner === 'series');

/** 每一目自己做的步骤（按步骤顺序）。 */
export const ITEM_OWNED_PHASES: readonly CurriculumDesignPhase[] =
  CURRICULUM_DESIGN_PHASE_ORDER.filter((phase) => STEP_OWNERSHIP[phase].owner === 'item');

export function stepOwner(phase: CurriculumDesignPhase): StepOwner {
  return STEP_OWNERSHIP[phase].owner;
}

export function isSeriesOwned(phase: CurriculumDesignPhase): boolean {
  return stepOwner(phase) === 'series';
}

/**
 * 系列层是否已经把这一步定完了。界面用它把「系列还没定」与「本目还没做」分开：
 * 两者都会让这一步做不了，但要做的事完全不同（去系列设计页 / 在这里干活）。
 *
 * 只接受真正的"内容是否齐"的判据，不猜：`direction` 传方向缺口是否为空，
 * `objectives` / `knowledge` 传条数是否大于 0。判断留在调用方，因为这个模块
 * 不读库。
 */
export function seriesStepReady(phase: CurriculumDesignPhase, hasContent: boolean): boolean {
  return isSeriesOwned(phase) && hasContent;
}
