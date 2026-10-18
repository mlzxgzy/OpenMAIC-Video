'use client';

/**
 * 七步条 —— 目工作台与系列驾驶舱的脊椎：**1..7 每一步都标出来**，并指出现在站在哪一步。
 *
 * 上一版是 `design-workbench.tsx` 里的 `PhaseRail`：一排小号 `Badge`，只有当前那一步
 * 上色，其余是同深浅的灰字，而且**没有序号**。作者滚到第三张卡片时，页面上没有任何
 * 一处告诉他"这是第 3 步、前面两步已经签过、后面还有四步"——每张卡片都自称一个完整
 * 的任务，合起来没有方向。用户的原话是"还是不够指引，把每一步都标出来，1-7 这种，
 * 更加明显一些"。
 *
 * 现在多了一件事：**这七步不是同一个人的活**。第 1–3 步（课程方向、学习目标、知识
 * 体系）属于整个系列，定一次、所有目共用；第 4–7 步（本目大纲、讲稿分镜、题目实操、
 * 审核）才是每一目的工作。上一版把七步摊成一条线，用户在目里看到"第 1 步 课程方向"
 * 就以为要在这里再填一遍受众——这是"每个目都要七步？"和"咋又是课程方向"的直接来源。
 *
 * 所以条被分成两段，各自带一个标题：「系列层（定一次）」3 格、「本目（每一目都做）」
 * 4 格。序号仍是 1..7 连续的：分组说明归属，不改变流程顺序。归属表在
 * `lib/curriculum/step-ownership.ts`，这里只渲染，不判断。
 *
 * 三条规则不变：
 *
 * 1. **七步全显示。** 设计稿 §5.3 曾打算把第 5/6/7 步折成「…」（理由是后三步属于
 *    "产出模式"，应该走独立的生成入口）。那是设计者的推断；用户要的是"每一步都标出
 *    来"，推断让位。只含前四步的 `STEP_BAR_PHASES` 常量随之删除——留着一个没人读、
 *    又与界面相反的常量，下一个人会照着它改回去。
 * 2. **序号是主角。** 圆圈里的 1..7 比名字大、比名字先被看到；颜色只有三种状态，
 *    "我做到哪了"不需要读文字就能答。
 * 3. **状态不能只靠颜色。** 已走完是对勾、当前是实心加「你在这」、没开始是空心圆——
 *    色盲用户、灰度打印、截图里都能读。
 *
 * 外层容器带 `data-testid="step-rail"`、里面仍是 7 个 `li[data-step-state]`：分组是
 * 展示，不是新的结构，现有的断言（七格、唯一当前步）不改。
 */

import { Check } from 'lucide-react';

import { cn } from '@/lib/utils';
import { CURRICULUM_DESIGN_PHASE_ORDER } from '@/lib/curriculum/design-editing';
import { ITEM_OWNED_PHASES, SERIES_OWNED_PHASES } from '@/lib/curriculum/step-ownership';
import type { CurriculumDesignPhase } from '@/lib/curriculum/design-types';
import {
  PHASE_DOT_STATE,
  PHASE_STATE_LABEL,
  STEP_DONE_LABEL,
  STEP_NAME,
  STEP_NUMBER,
  stepRef,
} from '@/lib/curriculum/ui-labels';

/** 三种点位状态。`done` 由下标推出：阶段只能一格格推进，当前步之前的都已确认。 */
type DotState = keyof typeof PHASE_DOT_STATE;

const DOT_CLASS: Record<DotState, string> = {
  done: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  current: 'border-primary bg-primary text-primary-foreground ring-primary/20 ring-4',
  todo: 'border-border bg-background text-muted-foreground',
};

const NAME_CLASS: Record<DotState, string> = {
  done: 'text-muted-foreground',
  current: 'text-foreground font-medium',
  todo: 'text-muted-foreground/70',
};

const BAR_CLASS: Record<DotState, string> = {
  done: 'bg-emerald-500/40',
  current: 'bg-border',
  todo: 'bg-border',
};

export interface StepRailProps {
  phase: CurriculumDesignPhase;
  className?: string;
}

/** 一段（系列层 / 本目）：一段说明 + 它自己的那几格。 */
function StepBand({
  title,
  hint,
  phases,
  phase,
  className,
}: {
  title: string;
  hint: string;
  phases: readonly CurriculumDesignPhase[];
  phase: CurriculumDesignPhase;
  className?: string;
}) {
  const currentRank = CURRICULUM_DESIGN_PHASE_ORDER.indexOf(phase);
  return (
    <div className={cn('flex min-w-0 flex-col gap-2', className)}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-xs font-semibold">{title}</span>
        <span className="text-muted-foreground text-[11px]">{hint}</span>
      </div>
      <ol
        className="grid gap-x-1 gap-y-2"
        style={{ gridTemplateColumns: `repeat(${phases.length}, minmax(0, 1fr))` }}
      >
        {phases.map((entry) => {
          const index = CURRICULUM_DESIGN_PHASE_ORDER.indexOf(entry);
          const state: DotState =
            index < currentRank ? 'done' : entry === phase ? 'current' : 'todo';
          const title =
            state === 'done'
              ? `第 ${STEP_NUMBER[entry]} 步 · ${STEP_NAME[entry]}（${PHASE_DOT_STATE.done}）：${STEP_DONE_LABEL[entry]}`
              : state === 'current'
                ? `第 ${STEP_NUMBER[entry]} 步 · ${STEP_NAME[entry]}（${PHASE_DOT_STATE.current}）`
                : `第 ${STEP_NUMBER[entry]} 步 · ${STEP_NAME[entry]}（${PHASE_STATE_LABEL[entry]}）`;
          return (
            <li
              key={entry}
              data-step={entry}
              data-step-state={state}
              title={title}
              className="flex min-w-0 flex-col gap-1.5"
            >
              <span className="flex items-center gap-1.5">
                <span
                  aria-hidden
                  className={cn(
                    'flex size-8 shrink-0 items-center justify-center rounded-full border text-sm font-semibold tabular-nums',
                    DOT_CLASS[state],
                  )}
                >
                  {state === 'done' ? <Check className="size-4" /> : STEP_NUMBER[entry]}
                </span>
                {entry !== phases[phases.length - 1] ? (
                  <span aria-hidden className={cn('h-px flex-1', BAR_CLASS[state])} />
                ) : null}
              </span>
              <span className={cn('truncate text-xs leading-tight', NAME_CLASS[state])}>
                {STEP_NAME[entry]}
              </span>
              <span
                className={cn(
                  'text-[11px] leading-none',
                  state === 'current' ? 'text-primary font-medium' : 'invisible',
                )}
              >
                你在这
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export function StepRail({ phase, className }: StepRailProps) {
  const total = CURRICULUM_DESIGN_PHASE_ORDER.length;

  return (
    <section
      aria-label={`第 ${STEP_NUMBER[phase]} 步，共 ${total} 步：${STEP_NAME[phase]}`}
      data-testid="step-rail"
      className={cn(
        'border-border bg-muted/30 flex flex-col gap-3 rounded-xl border p-3',
        className,
      )}
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-lg font-semibold tabular-nums">第 {STEP_NUMBER[phase]} 步</span>
        <span className="text-muted-foreground text-sm tabular-nums">/ 共 {total} 步</span>
        <span className="text-lg font-semibold">{STEP_NAME[phase]}</span>
      </div>

      {/*
        两段并排（宽屏）或上下（窄屏）。窄屏不横向滚动：两段各自 3/4 格，滚动会让
        "第 4 步"跑出视野，而分组本来就是让人一眼看到分界的。
      */}
      <div className="flex flex-col gap-3 md:flex-row md:gap-4">
        <StepBand
          title="系列层"
          hint="定一次，所有目共用"
          phases={SERIES_OWNED_PHASES}
          phase={phase}
          className="md:flex-[3]"
        />
        <div aria-hidden className="bg-border hidden w-px shrink-0 md:block" />
        <StepBand
          title="本目"
          hint="每一目都要做"
          phases={ITEM_OWNED_PHASES}
          phase={phase}
          className="md:flex-[4]"
        />
      </div>
    </section>
  );
}

/** 角标与当前步的关系。`null` 表示调用方没给当前步（此时角标只说"我是第几步"）。 */
const BADGE_RELATION_LABEL = {
  current: '你在这',
  done: '已走过',
  todo: '还没轮到',
} as const;
type BadgeRelation = keyof typeof BADGE_RELATION_LABEL;

const BADGE_CLASS: Record<BadgeRelation, string> = {
  current: 'bg-primary/10 text-primary',
  done: 'bg-muted text-muted-foreground',
  todo: 'bg-muted text-muted-foreground',
};

/**
 * 卡片角标：「第 N 步 / 共 7 步」，并说明这一步与当前步的关系。
 *
 * 步骤条只说明整条路，说明不了"屏幕上这一张卡片是哪一步"——编辑器的九张卡片是纵向
 * 排开的一条长页，离开顶部几百像素之后步骤条已经滚出视野。所以每张承担某一步的卡片
 * 自己带一个序号角标，`第 7 步` 与步骤条里的圆圈是同一个数字。
 *
 * `currentPhase` 不是装饰。只写"第 3 步"时，角标读起来像**状态**："我在第 3 步"。而
 * 编辑器会把七步的卡片全部排出来（前面的还能改、后面的只是还没轮到），于是一张
 * `第 3 步` 的紫色角标与步骤条上点在第 2 步的「你在这」同屏出现，用户的原话是
 * "还是不够指引"。加了关系和 `共 7 步` 之后，同一张卡片自己会说"第 3 步 / 共 7 步 ·
 * 还没轮到"，与步骤条不再打架；颜色也跟着状态走，不再是"紫色 = 当前"。
 */
export function StepBadge({
  phase,
  currentPhase,
  className,
}: {
  phase: CurriculumDesignPhase;
  currentPhase?: CurriculumDesignPhase | null;
  className?: string;
}) {
  const relation = badgeRelation(phase, currentPhase);
  return (
    <span
      data-testid="step-badge"
      data-step={phase}
      data-step-relation={relation ?? 'unknown'}
      title={stepTitle(phase)}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium tabular-nums',
        BADGE_CLASS[relation ?? 'current'],
        className,
      )}
    >
      <span>
        第 {STEP_NUMBER[phase]} 步
        <span className="opacity-60"> / 共 {CURRICULUM_DESIGN_PHASE_ORDER.length} 步</span>
      </span>
      {relation && relation !== 'current' ? (
        <span className="opacity-70">· {BADGE_RELATION_LABEL[relation]}</span>
      ) : null}
    </span>
  );
}

/** 角标上的关系，与步骤条同一个下标判断：前面的已走过、当前的就是它、后面的还没轮到。 */
function badgeRelation(
  phase: CurriculumDesignPhase,
  currentPhase: CurriculumDesignPhase | null | undefined,
): BadgeRelation | null {
  if (!currentPhase) return null;
  const here = CURRICULUM_DESIGN_PHASE_ORDER.indexOf(currentPhase);
  const mine = CURRICULUM_DESIGN_PHASE_ORDER.indexOf(phase);
  if (mine < 0 || here < 0) return null;
  if (mine < here) return 'done';
  return mine === here ? 'current' : 'todo';
}

/** 角标的悬浮说明：这一步问什么、做完意味着什么。序号用 `stepRef`，与门禁文案同一套词。 */
function stepTitle(phase: CurriculumDesignPhase): string {
  return `${stepRef(phase)} · ${STEP_NAME[phase]}：${STEP_DONE_LABEL[phase]}`;
}
