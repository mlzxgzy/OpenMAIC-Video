/**
 * What the design workbench is allowed to offer, derived from the store's gates.
 *
 * This exists because the last two rounds were spent removing dead paths: a
 * button that the server refuses, a create form that nothing calls, a panel that
 * says "no entry point" while offering none. A workbench that offers an edit the
 * store answers 409 to is the same defect wearing a new screen — the user finds
 * out by clicking, which is the worst place to find out.
 *
 * So the gate table is transcribed here once, and the components ask it instead
 * of re-deriving the rules. Two rules in the store drive the shape:
 *
 * 1. **Only creation is phase-gated.** `assertPhase` appears in the `create*`
 *    and `set*` functions and in none of the `update*` or `delete*` ones,
 *    because the store's own comment says "editing always stays allowed: a
 *    course being revised should not be frozen at the phase it first reached."
 *    An editor therefore hides *creation* before its phase and leaves editing
 *    on forever — offering to delete a mistake at `review` is correct, offering
 *    to author a brand-new objective at `task` is not.
 *
 * 2. **A disabled control must say why.** `ProductionPathChoice` already
 *    carries a `blockedReason` for the same reason. Here {@link
 *    AuthoringAvailability} does the same, so no panel can render a greyed-out
 *    button with no explanation, and the explanation names the phase to reach
 *    rather than merely the phase being in.
 *
 * The table is transcribed rather than imported because the store's gates live
 * inside function bodies, reachable only by issuing SQL. `tests/curriculum/
 * design-editing.test.ts` pins every row against the live store, so a gate added
 * to the store without a row here fails the suite rather than silently widening
 * the workbench.
 */

import type { CurriculumDesignPhase } from './design-types';

export const CURRICULUM_DESIGN_PHASE_ORDER: readonly CurriculumDesignPhase[] = [
  'task',
  'outcomes',
  'graph',
  'outline',
  'teaching',
  'assessment',
  'review',
];

/**
 * The kinds of thing the workbench can create.
 *
 * Each names one POST/PUT the store gates. `brief` is absent because the brief
 * is a PATCH on the task and is never gated — the task row exists before it can
 * have a phase, and freezing a brief would make `task` a phase you cannot leave.
 */
export type DesignAuthoring =
  | 'outcomes'
  | 'evidence'
  | 'nodes'
  | 'node-objectives'
  | 'dependencies'
  | 'units'
  | 'coverage'
  | 'unit-dependencies'
  | 'questions'
  | 'lab-tasks';

interface AuthoringGate {
  /** Human name, used in the refusal message. */
  label: string;
  /** The phase whose `assertPhase` call governs this creation. */
  requiredPhase: CurriculumDesignPhase;
}

/**
 * One row per gated store write. Read this table as "the phase at which this
 * kind of row may first be created".
 *
 * `coverage` is `outline` because the workbench writes it with PUT
 * (`setCurriculumUnitCoverage`), which is gated. The store's POST twin
 * (`createCurriculumUnitCoverage`) carries no gate at all; see
 * `COVERAGE_WRITE_NOTE` below for why the workbench does not use it.
 */
export const DESIGN_AUTHORING_GATES: Readonly<Record<DesignAuthoring, AuthoringGate>> = {
  outcomes: { label: '学习目标', requiredPhase: 'outcomes' },
  evidence: { label: '评价证据', requiredPhase: 'outcomes' },
  nodes: { label: '知识点', requiredPhase: 'graph' },
  'node-objectives': { label: '知识点与目标的支撑关系', requiredPhase: 'graph' },
  dependencies: { label: '学习顺序依赖', requiredPhase: 'graph' },
  units: { label: '大纲条目', requiredPhase: 'outline' },
  coverage: { label: '教/练/考覆盖', requiredPhase: 'outline' },
  'unit-dependencies': { label: '条目顺序', requiredPhase: 'outline' },
  questions: { label: '测验题', requiredPhase: 'assessment' },
  'lab-tasks': { label: '实操任务', requiredPhase: 'assessment' },
};

/**
 * Why the workbench writes coverage with PUT rather than POST.
 *
 * Both routes record the same claim and both upsert on
 * `(unit_id, objective_id, coverage_kind)`. PUT replaces the task's whole
 * coverage set inside one transaction, which the store documents as the point:
 * "the closed loop is never observed half-updated". POST adds one claim at a
 * time, so a save that removes one claim and adds another can fail between them
 * and leave the matrix showing a loop that does not exist.
 *
 * The phase gate is a second, independent reason: PUT is gated at `outline` and
 * POST is not, so a POST-based editor could author new coverage claims from the
 * `task` phase — the only way to reach a stage where the UI is supposed to be
 * showing "not yet". That asymmetry looks accidental rather than designed, so
 * the workbench uses the stricter route and leaves the decision about the
 * ungated twin to a separate change.
 */
export const COVERAGE_WRITE_NOTE =
  '覆盖关系用 PUT 整体写入：一次事务内替换全量，避免闭环被观察到写了一半的状态；且 PUT 有 outline 阶段闸门，POST 没有。';

export interface AuthoringAvailability {
  kind: DesignAuthoring;
  /** Whether a create control for this kind should be enabled. */
  allowed: boolean;
  /**
   * Why creation is closed, in one sentence naming the phase to reach. `null`
   * when it is open. Never a bare phase name: "先做 X" is actionable, "X 未到"
   * is not.
   */
  reason: string | null;
  /** The phase that must be reached first, for the disabled control's tooltip. */
  requiredPhase: CurriculumDesignPhase;
}

const PHASE_LABELS: Record<CurriculumDesignPhase, string> = {
  task: '课程任务',
  outcomes: '学习成果',
  graph: '依赖图',
  outline: '课程大纲',
  teaching: '教学设计',
  assessment: '评价设计',
  review: '课程审核',
};

export function designPhaseLabel(phase: CurriculumDesignPhase): string {
  return PHASE_LABELS[phase];
}

function phaseRank(phase: CurriculumDesignPhase): number {
  const index = CURRICULUM_DESIGN_PHASE_ORDER.indexOf(phase);
  return index < 0 ? 0 : index;
}

/**
 * Decide whether one kind of row may be created at the task's current phase.
 *
 * The comparison is "at or past", matching the store's `assertPhase`, so a task
 * in `review` can still author — revising a course is not gated, and neither is
 * this. A naive equality check would freeze the whole workbench at `review`, which
 * is the phase where a course is most likely to be corrected.
 */
export function authoringAvailability(
  phase: CurriculumDesignPhase,
  kind: DesignAuthoring,
): AuthoringAvailability {
  const gate = DESIGN_AUTHORING_GATES[kind];
  const requiredPhase = gate.requiredPhase;
  const allowed = phaseRank(phase) >= phaseRank(requiredPhase);
  return {
    kind,
    allowed,
    requiredPhase,
    reason: allowed
      ? null
      : `先完成${PHASE_LABELS[requiredPhase]}阶段，才能新建${gate.label}。` +
        `当前在${PHASE_LABELS[phase]}阶段。`,
  };
}

/**
 * Every kind the workbench should render a create control for, with its state.
 *
 * Returning the whole table rather than filtering is deliberate: a section that
 * is simply absent is indistinguishable from a section that was forgotten, and
 * forgetting is how the previous dead paths were built. The caller decides
 * whether to hide a closed section or show it disabled with its reason.
 */
export function authoringTable(phase: CurriculumDesignPhase): AuthoringAvailability[] {
  return (Object.keys(DESIGN_AUTHORING_GATES) as DesignAuthoring[]).map((kind) =>
    authoringAvailability(phase, kind),
  );
}

/** The kinds that may be created right now, for a "what can I do next" summary. */
export function openAuthoringKinds(phase: CurriculumDesignPhase): DesignAuthoring[] {
  return authoringTable(phase)
    .filter((entry) => entry.allowed)
    .map((entry) => entry.kind);
}

/**
 * The phase the workbench should focus, which is not always the task's phase.
 *
 * A task sits in one phase, but a person editing it may be fixing something the
 * audit found two phases later. Rather than hiding the earlier layers — which is
 * how a course ends up with an outcome nothing teaches and no way to reach the
 * control that fixes it — the workbench shows every phase's section and lets
 * the current one be open. This is the phase to scroll to and to leave expanded.
 */
export function focusPhase(phase: CurriculumDesignPhase): CurriculumDesignPhase {
  return phase;
}
