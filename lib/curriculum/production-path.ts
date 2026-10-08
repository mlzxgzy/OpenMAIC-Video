/**
 * Which way a legacy course gets produced.
 *
 * The assembler panel this replaces had exactly one button: build a plan from a
 * knowledge-point selection and start a run whose requirement was a paragraph
 * of assembled prose. That path is still real and still used — batches
 * (`batch.ts`) run through it, and the ledger screen it lives on is the course
 * product's own screen. It is not the *design* path.
 *
 * The distinction matters because the two produce genuinely different courses:
 *
 * | | legacy assembly | designed item |
 * |---|---|---|
 * | what the run is told | a paragraph restating the title | the outcomes it serves |
 * | what it may generate | always `['slide']` | what `unit_role` allows |
 * | what closes the loop | nothing checks it | the export gate refuses |
 *
 * So this module is the seam that lets one screen offer both, and — more
 * importantly — makes the choice visible instead of implicit. A panel that
 * quietly assembled from knowledge points while the design screens sat next to
 * it is how the design model stays theoretical: the button people actually press
 * is the one that skips it.
 *
 * The functions are pure over values the caller already read, so both answers
 * are decidable in one render without a second query.
 */

import type { CurriculumDesignPhase, CurriculumUnitRecord } from '@/lib/curriculum/design-types';

/** What the panel is offering: two routes to a classroom, not two forms. */
export type ProductionPath = 'design' | 'assembly';

export interface ProductionPathChoice {
  /** Which path this task's shape selects. */
  path: ProductionPath;
  /** Whether the design path can actually start, i.e. an item exists to produce. */
  designAvailable: boolean;
  /**
   * Why the design path is not offered, in one sentence. `null` when it is.
   *
   * Kept as a sentence rather than a boolean pair so the panel cannot show a
   * disabled button with no reason — a disabled generate button with no
   * explanation is the thing that pushes people back to the legacy path.
   */
  blockedReason: string | null;
}

/**
 * Whether this design has anything to produce.
 *
 * A chapter carries no role and cannot be generated, so the test is "has at
 * least one item", not "has units". A task with only chapters is a skeleton: it
 * passes the outline phase and still has nothing a run could build.
 */
function producedItems(units: readonly CurriculumUnitRecord[]): CurriculumUnitRecord[] {
  return units.filter((unit) => unit.unitType === 'item');
}

/**
 * Pick the production path for one design task.
 *
 * The rule is deliberately biased toward the design path: a task that has
 * entered the `outline` phase has crossed "outcomes, evidence, knowledge and
 * dependencies are settled", and the only way forward from there is the designed
 * item. The legacy path remains available for a course whose design genuinely
 * does not exist — the knowledge-library-led screen — and is *not* offered here
 * once the task is far enough along that assembling from knowledge points would
 * contradict what the design already promised.
 *
 * Phases before `outline` are the exception in the other direction: with no
 * outcome loop defined, the design path has nothing to enforce and the legacy
 * path is the only one that can make progress. This is not a promotion of the
 * old model; it is the honest answer for a task that has not been designed yet,
 * and the panel says so.
 */
export function chooseProductionPath(input: {
  phase: CurriculumDesignPhase;
  units: readonly CurriculumUnitRecord[];
  /** Whether the task has any learning outcome to hang the loop on. */
  objectiveCount: number;
}): ProductionPathChoice {
  const items = producedItems(input.units);
  const designAvailable = items.length > 0;

  if (input.phase === 'outline' || input.phase === 'teaching' || input.phase === 'assessment') {
    if (designAvailable) {
      return { path: 'design', designAvailable: true, blockedReason: null };
    }
    return {
      path: 'design',
      designAvailable: false,
      blockedReason:
        '大纲里还没有条目（章不能单独生成）。回到大纲阶段加一个讲课、练习或考试条目，再从它生成。',
    };
  }

  if (input.phase === 'review') {
    return {
      path: 'design',
      designAvailable,
      blockedReason: designAvailable
        ? null
        : '大纲里还没有条目（章不能单独生成），这门课还没有可生产的内容。',
    };
  }

  // Before the outline there is nothing for the design path to enforce. The
  // legacy assembler is the only thing that can move the task forward, so it is
  // what is offered — labelled as the pre-design path so it is not mistaken for
  // the real one.
  return {
    path: 'assembly',
    designAvailable: false,
    blockedReason:
      input.objectiveCount === 0
        ? '课程还没有学习目标。逆向设计从"先定目标、再定证据"开始，组装器不会替你做这个决定。'
        : '课程还在目标与依赖图阶段。把目标、证据、知识技能和依赖关系定下来，大纲才有依据。',
  };
}
