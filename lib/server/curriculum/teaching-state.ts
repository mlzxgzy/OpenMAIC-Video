/**
 * The step-6 state payload, in the shape the card and the phase header read.
 *
 * Same job as `outline-state.ts`, and for the same reason: the turn route, the
 * GET and the POST of the state route all answer with this, so it is written
 * once rather than three times. Three copies drift, and the drift is silent — a
 * dialog that computes "ready" itself simply disagrees with the gate instead of
 * failing.
 *
 * Two things are deliberately read rather than re-derived:
 *
 * - **`gaps` comes from `teachingGapsOfItems`** — the same function the phase
 *   gate and the audit rule call, so the card cannot report "还没有分镜" for an
 *   item the gate considers finished.
 * - **`auditFindings` comes from `auditCurriculumDesign`** — the teaching-layer
 *   rules belong to the audit, and a conversation-side copy of them would be a
 *   second definition of what a signed design needs.
 */
import { auditCurriculumDesign, type CurriculumAuditFinding } from '@/lib/curriculum/audit';
import {
  deckPageAdvisories,
  formatTeachingPlan,
  teachingGapsOfItems,
  teachingItemsOfRecords,
  type TeachingGap,
} from '@/lib/curriculum/design-teaching';
import {
  nextCurriculumDesignPhase,
  type CurriculumDesignConfirmationRecord,
  type CurriculumDesignSnapshot,
} from '@/lib/curriculum/design-types';
import type { DesignContext } from '@/lib/server/curriculum/design-http';
import {
  getCurriculumDesignStepConfirmation,
  getCurriculumTask,
  phaseCompletionGaps,
} from '@/lib/server/curriculum/design-store';

export interface TeachingPayload {
  /** The items this step authors, with their scripts and storyboards. */
  units: CurriculumDesignSnapshot['units'];
  unitCoverage: CurriculumDesignSnapshot['unitCoverage'];
  nodes: CurriculumDesignSnapshot['nodes'];
  nodeObjectives: CurriculumDesignSnapshot['nodeObjectives'];
  objectives: CurriculumDesignSnapshot['objectives'];
  gaps: TeachingGap[];
  /** Advisory only — the machine can see it but must not decide it for the author. */
  findings: { text: string }[];
  /** The audit's own teaching-layer findings, read rather than re-derived. */
  auditFindings: CurriculumAuditFinding[];
  confirmation: CurriculumDesignConfirmationRecord | null;
  confirmed: boolean;
  nextPhase: string | null;
  phaseGaps: string[];
  readyToAdvance: boolean;
  /** The rendered plan, so the card shows what the prompt showed. */
  plan: string;
  /** Present only on a conversation turn: what the author reads in the chat. */
  message?: string;
  /** Present only on a conversation turn: whether this turn recorded the sign-off. */
  confirmedThisTurn?: boolean;
  /** 这一轮没能写进去的东西，和为什么。作者必须看得见。 */
  warnings?: string[];
}

/** The audit rules this step surfaces: they are about the storyboard and the script. */
const TEACHING_AUDIT_RULES = new Set(['unit_lesson_undesigned', 'deck_script_conflict']);

export function teachingAuditFindings(
  snapshot: CurriculumDesignSnapshot,
): CurriculumAuditFinding[] {
  return auditCurriculumDesign(snapshot).filter((finding) =>
    TEACHING_AUDIT_RULES.has(finding.rule),
  );
}

/** What the stored design is still missing, in the words the prompt and the card both use. */
export function teachingGapsOfSnapshot(snapshot: CurriculumDesignSnapshot): TeachingGap[] {
  return teachingGapsOfItems(
    teachingItemsOfRecords(
      snapshot.units,
      snapshot.unitCoverage,
      snapshot.nodes,
      snapshot.nodeObjectives,
    ),
  );
}

/**
 * The advisory list: page counts that are far off a lecture's rhythm.
 *
 * Only the page count, for now. It is advisory because the length of a lesson is
 * the author's decision; what the machine can legitimately say is that
 * twenty-eight pages for one hour is probably two lessons.
 */
export function teachingAdvisoriesOfSnapshot(
  snapshot: CurriculumDesignSnapshot,
): { text: string }[] {
  return snapshot.units
    .filter((unit) => unit.unitType === 'item')
    .flatMap((unit) =>
      deckPageAdvisories({
        title: unit.title,
        role: unit.unitRole ?? 'lecture',
        deckDesign: unit.deckDesign ?? {},
      }),
    );
}

/**
 * Everything that blocks signing the teaching design, in the words the card shows.
 *
 * The same two sources and the same reason as {@link file://./outline-state.ts}'s
 * `outlineBlockers`, and shared for the same reason: the `confirm_course_teaching`
 * tool refuses on exactly this list.
 */
export function teachingBlockers(snapshot: CurriculumDesignSnapshot): string[] {
  return [
    ...new Set([
      ...teachingGapsOfSnapshot(snapshot).map((gap) => gap.text),
      ...teachingAuditFindings(snapshot).map((finding) => finding.message),
    ]),
  ];
}

export async function teachingState(
  ctx: DesignContext,
  taskId: string,
  snapshot: CurriculumDesignSnapshot,
): Promise<TeachingPayload> {
  const gaps = teachingGapsOfSnapshot(snapshot);
  const auditFindings = teachingAuditFindings(snapshot);
  const confirmation = await getCurriculumDesignStepConfirmation(
    ctx.queryable,
    ctx.ownerId,
    taskId,
    'teaching',
  );
  const task = await getCurriculumTask(ctx.queryable, ctx.ownerId, taskId);
  const next = task ? nextCurriculumDesignPhase(task.designPhase) : null;
  const phaseGaps =
    next !== null ? await phaseCompletionGaps(ctx.queryable, ctx.ownerId, taskId, next) : [];
  return {
    units: snapshot.units,
    unitCoverage: snapshot.unitCoverage,
    nodes: snapshot.nodes,
    nodeObjectives: snapshot.nodeObjectives,
    objectives: snapshot.objectives,
    gaps,
    findings: teachingAdvisoriesOfSnapshot(snapshot),
    auditFindings,
    confirmation,
    confirmed: confirmation !== null,
    nextPhase: next,
    phaseGaps,
    readyToAdvance: next !== null && phaseGaps.length === 0,
    plan: formatTeachingPlan({
      items: teachingItemsOfRecords(
        snapshot.units,
        snapshot.unitCoverage,
        snapshot.nodes,
        snapshot.nodeObjectives,
      ),
      objectives: snapshot.objectives.map((row) => ({ id: row.id, title: row.title })),
      chapters: snapshot.units
        .filter((unit) => unit.unitType === 'chapter')
        .map((unit) => ({ id: unit.id, title: unit.title, parentId: unit.parentId })),
    }),
  };
}
