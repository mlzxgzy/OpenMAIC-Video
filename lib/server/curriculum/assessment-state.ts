/**
 * The step-7 state payload, in the shape the card and the phase header read.
 *
 * Same job as `teaching-state.ts`, and for the same reason: the turn route, the GET
 * and the POST of the state route all answer with this, so it is written once
 * rather than three times. Three copies drift, and the drift is silent — a dialog
 * that computes "ready" itself simply disagrees with the gate instead of failing.
 *
 * Two things are deliberately read rather than re-derived:
 *
 * - **`gaps` comes from `assessmentGaps`** — the same function the phase gate and
 *   the audit rules call, so the card cannot report "还差一道题" for an item the
 *   gate considers finished.
 * - **`auditFindings` comes from `auditCurriculumDesign`** — the assessment-layer
 *   rules belong to the audit, and a conversation-side copy of them would be a
 *   second definition of what a signed assessment needs.
 */
import { auditCurriculumDesign, type CurriculumAuditFinding } from '@/lib/curriculum/audit';
import {
  assessmentBoardOf,
  assessmentGaps,
  formatAssessmentPlan,
  type AssessmentGap,
} from '@/lib/curriculum/design-assessment';
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

export interface AssessmentPayload {
  /** Everything the panel needs to show what is attached where. */
  units: CurriculumDesignSnapshot['units'];
  unitCoverage: CurriculumDesignSnapshot['unitCoverage'];
  objectives: CurriculumDesignSnapshot['objectives'];
  evidence: CurriculumDesignSnapshot['evidence'];
  questions: CurriculumDesignSnapshot['questions'];
  labTasks: CurriculumDesignSnapshot['labTasks'];
  gaps: AssessmentGap[];
  /** Advisory only — the machine can see it but must not decide it for the author. */
  findings: { text: string }[];
  /** The audit's own assessment-layer findings, read rather than re-derived. */
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

/**
 * The audit rules this step surfaces: they are about where an artifact hangs and
 * whether it can be graded. `coverage_without_artifact`, `question_off_item`,
 * `lab_off_item` and `exam_evidence_practice_lab` are the step-7 rules; the other
 * three existed before it and are the same judgement seen from the other side.
 */
const ASSESSMENT_AUDIT_RULES = new Set([
  'evidence_no_artifact',
  'drill_no_objective',
  'lab_no_verify_rule',
  'lab_verify_grades_by_path',
  'question_off_item',
  'lab_off_item',
  'coverage_without_artifact',
  'exam_evidence_practice_lab',
]);

export function assessmentAuditFindings(
  snapshot: CurriculumDesignSnapshot,
): CurriculumAuditFinding[] {
  return auditCurriculumDesign(snapshot).filter((finding) =>
    ASSESSMENT_AUDIT_RULES.has(finding.rule),
  );
}

/** What the stored design is still missing, in the words the prompt and the card both use. */
export function assessmentGapsOfSnapshot(snapshot: CurriculumDesignSnapshot): AssessmentGap[] {
  return assessmentGaps(snapshot);
}

/**
 * Everything that blocks signing the assessment, in the words the card shows.
 *
 * Deduplicated textually: the audit rules and the step's gaps share a judgement
 * (`lab_without_verify_rule` vs `lab_no_verify_rule` produce the same sentence), and
 * a refusal that repeats itself reads as two problems.
 */
export function assessmentBlockers(snapshot: CurriculumDesignSnapshot): string[] {
  const texts = [
    ...assessmentGapsOfSnapshot(snapshot).map((gap) => gap.text),
    ...assessmentAuditFindings(snapshot).map((finding) => finding.message),
  ];
  return [...new Set(texts)];
}

export async function assessmentState(
  ctx: DesignContext,
  taskId: string,
  snapshot: CurriculumDesignSnapshot,
): Promise<AssessmentPayload> {
  const gaps = assessmentGapsOfSnapshot(snapshot);
  const auditFindings = assessmentAuditFindings(snapshot);
  const confirmation = await getCurriculumDesignStepConfirmation(
    ctx.queryable,
    ctx.ownerId,
    taskId,
    'assessment',
  );
  const task = await getCurriculumTask(ctx.queryable, ctx.ownerId, taskId);
  const next = task ? nextCurriculumDesignPhase(task.designPhase) : null;
  const phaseGaps =
    next !== null ? await phaseCompletionGaps(ctx.queryable, ctx.ownerId, taskId, next) : [];
  return {
    units: snapshot.units,
    unitCoverage: snapshot.unitCoverage,
    objectives: snapshot.objectives,
    evidence: snapshot.evidence,
    questions: snapshot.questions,
    labTasks: snapshot.labTasks,
    gaps,
    findings: [],
    auditFindings,
    confirmation,
    confirmed: confirmation !== null,
    nextPhase: next,
    phaseGaps,
    readyToAdvance: next !== null && phaseGaps.length === 0,
    plan: formatAssessmentPlan(assessmentBoardOf(snapshot)),
  };
}
