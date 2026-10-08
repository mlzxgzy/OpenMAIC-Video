/**
 * The reverse-design layer's domain types.
 *
 * These sit beside `types.ts` rather than replacing it. The ledger types
 * there describe a course as an operator-facing product; these describe a
 * course as a design artifact, and the two coexist during the transition.
 *
 * Two decisions are load-bearing and encoded in the shapes below:
 *
 * 1. **Objective types are not node types.** `CurriculumObjectiveType` has
 *    four values and `CurriculumNodeType` has two. Competency and task belong
 *    to the outcome layer, which is what finally gives them somewhere to carry
 *    a success criterion.
 *
 * 2. **The reference solution and the verification rules are different types.**
 *    {@link LabReferenceStep} says one way to solve the task;
 *    {@link LabVerifyRule} says what counts as done. A CTF task has many valid
 *    routes, so a single union type here would let a caller pass a step list
 *    where grading rules belong, and that mistake would silently grade by path.
 */

// ── Course task ─────────────────────────────────────────────────────────────

export const CURRICULUM_TASK_STATUSES = ['draft', 'active', 'archived'] as const;
export type CurriculumTaskStatus = (typeof CURRICULUM_TASK_STATUSES)[number];

/**
 * The design phases, in order. A task's `designPhase` is the authoritative
 * position: nothing downstream may be authored before the phase that owns it.
 * The order is the argument the whole model rests on — outcomes and their
 * evidence come before knowledge, knowledge before structure, structure before
 * materials, and review last.
 */
export const CURRICULUM_DESIGN_PHASES = [
  'task',
  'outcomes',
  'graph',
  'outline',
  'teaching',
  'assessment',
  'review',
] as const;
export type CurriculumDesignPhase = (typeof CURRICULUM_DESIGN_PHASES)[number];

/** The next phase, or null at the end. Used by the phase machine. */
export function nextCurriculumDesignPhase(
  phase: CurriculumDesignPhase,
): CurriculumDesignPhase | null {
  const index = CURRICULUM_DESIGN_PHASES.indexOf(phase);
  if (index < 0 || index >= CURRICULUM_DESIGN_PHASES.length - 1) return null;
  return CURRICULUM_DESIGN_PHASES[index + 1];
}

export const CURRICULUM_DIFFICULTIES = ['intro', 'basic', 'intermediate', 'advanced'] as const;
export type CurriculumDifficulty = (typeof CURRICULUM_DIFFICULTIES)[number];

export interface CurriculumTaskRecord {
  id: string;
  seriesId: string | null;
  title: string;
  audience: string | null;
  learnerLevel: string | null;
  trainingScenario: string | null;
  durationHours: number | null;
  applicationScene: string | null;
  problemStatement: string | null;
  status: CurriculumTaskStatus;
  designPhase: CurriculumDesignPhase;
  createdAt: string;
  updatedAt: string;
}

// ── Learning outcomes ───────────────────────────────────────────────────────

/**
 * The four kinds of thing a course is accountable for. They are deliberately
 * separate rather than one "type" enum over one bag of items, because each
 * answers a different question and carries a different kind of evidence:
 *
 * - `knowledge`   — the learner understands a mechanism ("why injection fires")
 * - `skill`       — the learner can perform a procedure ("build the payload")
 * - `competency`  — the learner can finish a whole job independently
 * - `task`        — an external, checkable result ("read /flag")
 */
export const CURRICULUM_OBJECTIVE_TYPES = ['knowledge', 'skill', 'competency', 'task'] as const;
export type CurriculumObjectiveType = (typeof CURRICULUM_OBJECTIVE_TYPES)[number];

export const CURRICULUM_BLOOM_LEVELS = [
  'remember',
  'understand',
  'apply',
  'analyze',
  'evaluate',
  'create',
] as const;
export type CurriculumBloomLevel = (typeof CURRICULUM_BLOOM_LEVELS)[number];

/** `course` outcomes are the course-level promises; `component` ones are unit-level. */
export const CURRICULUM_OBJECTIVE_LEVELS = ['course', 'component'] as const;
export type CurriculumObjectiveLevel = (typeof CURRICULUM_OBJECTIVE_LEVELS)[number];

export const CURRICULUM_OBJECTIVE_STATUSES = ['draft', 'approved', 'archived'] as const;
export type CurriculumObjectiveStatus = (typeof CURRICULUM_OBJECTIVE_STATUSES)[number];

export interface CurriculumObjectiveRecord {
  id: string;
  taskId: string;
  parentId: string | null;
  code: string | null;
  title: string;
  description: string | null;
  objectiveType: CurriculumObjectiveType;
  bloomLevel: CurriculumBloomLevel | null;
  level: CurriculumObjectiveLevel;
  /**
   * The observable behavior that would let someone decide the outcome is met.
   * A title alone can never stand in for this: "了解 SQL 注入" is a topic, not
   * a result.
   */
  expectedBehavior: string;
  /** Minimum / proficient / excellent criteria, as the three bands of a rubric. */
  minCriteria: string[];
  proficientCriteria: string[];
  excellentCriteria: string[];
  difficulty: CurriculumDifficulty;
  /**
   * Whether this outcome can be evidenced at all. The database refuses to set
   * it true without an expected behavior and at least one minimum criterion.
   */
  verifiable: boolean;
  /** Why it cannot be verified, when `verifiable` is false. */
  unverifiableReason: string | null;
  status: CurriculumObjectiveStatus;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

// ── Evidence ────────────────────────────────────────────────────────────────

export const CURRICULUM_EVIDENCE_TYPES = [
  'quiz',
  'lab',
  'performance',
  'dialogue',
  'artifact',
] as const;
export type CurriculumEvidenceType = (typeof CURRICULUM_EVIDENCE_TYPES)[number];

/**
 * Practice and exam share one record shape on purpose: a lab is promoted from
 * drill to assessment by changing policy fields, not by becoming a different
 * kind of object. What differs is the contract — practice trains and may hint;
 * exam is independent, hint-free, and scored.
 */
export const CURRICULUM_ASSESSMENT_MODES = ['practice', 'exam'] as const;
export type CurriculumAssessmentMode = (typeof CURRICULUM_ASSESSMENT_MODES)[number];

export const CURRICULUM_HINT_POLICIES = ['unlimited', 'limited', 'forbidden'] as const;
export type CurriculumHintPolicy = (typeof CURRICULUM_HINT_POLICIES)[number];

export interface CurriculumEvidenceRecord {
  id: string;
  taskId: string;
  objectiveId: string;
  evidenceType: CurriculumEvidenceType;
  verificationMethod: string;
  successCondition: string;
  /** A machine-evaluable form of `successCondition`, when one exists. */
  conditionExpression: string | null;
  /** Weaker corroboration, e.g. "the run shows real injection behavior". */
  auxiliaryCondition: string | null;
  assessmentMode: CurriculumAssessmentMode;
  thresholdPass: number;
  thresholdProficient: number;
  thresholdExcellent: number;
  timeLimitSec: number | null;
  hintPolicy: CurriculumHintPolicy;
  independent: boolean;
  processRecord: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

// ── Knowledge and skill nodes ───────────────────────────────────────────────

/**
 * Only knowledge and skill. A competency is a learning outcome, not a node, and
 * a task is an external result; both live in {@link CurriculumObjectiveRecord}.
 */
export const CURRICULUM_NODE_TYPES = ['knowledge', 'skill'] as const;
export type CurriculumNodeType = (typeof CURRICULUM_NODE_TYPES)[number];

export interface CurriculumLearningNodeRecord {
  id: string;
  taskId: string;
  parentId: string | null;
  code: string | null;
  name: string;
  nodeType: CurriculumNodeType;
  summary: string | null;
  difficulty: CurriculumDifficulty | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export const CURRICULUM_SUPPORT_LEVELS = ['primary', 'secondary'] as const;
export type CurriculumSupportLevel = (typeof CURRICULUM_SUPPORT_LEVELS)[number];

export interface CurriculumNodeObjectiveRecord {
  id: string;
  taskId: string;
  nodeId: string;
  objectiveId: string;
  supportLevel: CurriculumSupportLevel;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Dependency graph ────────────────────────────────────────────────────────

/** Both kinds of endpoint share one edge table, so the graph stays one DAG. */
export const CURRICULUM_DEPENDENCY_KINDS = ['objective', 'node'] as const;
export type CurriculumDependencyKind = (typeof CURRICULUM_DEPENDENCY_KINDS)[number];

export const CURRICULUM_DEPENDENCY_EDGE_TYPES = [
  'prerequisite',
  'derives',
  'supports',
  'practices',
  'composes',
  'progresses',
] as const;
export type CurriculumDependencyEdgeType = (typeof CURRICULUM_DEPENDENCY_EDGE_TYPES)[number];

export interface CurriculumDependencyRecord {
  id: string;
  taskId: string;
  sourceId: string;
  targetId: string;
  sourceKind: CurriculumDependencyKind;
  targetKind: CurriculumDependencyKind;
  edgeType: CurriculumDependencyEdgeType;
  strength: number;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Outline: chapters and items ─────────────────────────────────────────────

export const CURRICULUM_UNIT_TYPES = ['chapter', 'item'] as const;
export type CurriculumUnitType = (typeof CURRICULUM_UNIT_TYPES)[number];

/** What an item is for. A chapter has none — it only classifies. */
export const CURRICULUM_UNIT_ROLES = ['lecture', 'practice', 'exam'] as const;
export type CurriculumUnitRole = (typeof CURRICULUM_UNIT_ROLES)[number];

export const CURRICULUM_COVERAGE_KINDS = ['teach', 'practice', 'assess'] as const;
export type CurriculumCoverageKind = (typeof CURRICULUM_COVERAGE_KINDS)[number];

export const CURRICULUM_COVERAGE_DEPTHS = ['brief', 'standard', 'deep'] as const;
export type CurriculumCoverageDepth = (typeof CURRICULUM_COVERAGE_DEPTHS)[number];

/** One planned slide and what it must achieve, not a topic heading. */
export interface CurriculumDeckPage {
  order: number;
  title: string;
  /** What this page has to make the learner understand or be able to do. */
  goal: string;
  coreInfo: string;
  mode: 'case' | 'explain' | 'demo' | 'compare' | 'summary' | 'diagram';
  emphasis?: string[];
  visual?: string;
  code?: string;
}

export interface CurriculumDeckDesign {
  estPages?: number;
  pages?: CurriculumDeckPage[];
}

/**
 * The teaching plan for a lecture item. The four depth buckets are the point:
 * deciding what to skip is part of designing the lesson, and an item that has
 * to say "everything relevant" has not been designed.
 */
export interface CurriculumTeachingDesign {
  objectives?: string[];
  nodes?: string[];
  prerequisites?: string[];
  /** Must be taught in full. */
  core?: string[];
  /** Covered quickly. */
  brief?: string[];
  /** Named once, not developed. */
  mention?: string[];
  /** Deliberately out of scope — recorded so the omission is a decision. */
  omit?: string[];
  sequence?: string[];
  cases?: string[];
  demos?: string[];
  operations?: string[];
  drills?: string[];
  summary?: string[];
}

export interface CurriculumUnitRecord {
  id: string;
  taskId: string;
  parentId: string | null;
  unitType: CurriculumUnitType;
  title: string;
  code: string | null;
  unitRole: CurriculumUnitRole | null;
  hours: number | null;
  orderIndex: number;
  teachingDesign: CurriculumTeachingDesign;
  deckDesign: CurriculumDeckDesign;
  stageId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CurriculumUnitCoverageRecord {
  id: string;
  taskId: string;
  unitId: string;
  objectiveId: string;
  coverageKind: CurriculumCoverageKind;
  depth: CurriculumCoverageDepth;
  orderIndex: number;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export const CURRICULUM_UNIT_DEPENDENCY_EDGE_TYPES = [
  'prerequisite',
  'follow-up',
  'related',
] as const;
export type CurriculumUnitDependencyEdgeType =
  (typeof CURRICULUM_UNIT_DEPENDENCY_EDGE_TYPES)[number];

export interface CurriculumUnitDependencyRecord {
  id: string;
  taskId: string;
  sourceUnitId: string;
  targetUnitId: string;
  edgeType: CurriculumUnitDependencyEdgeType;
  strength: number;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Assessment artifacts ────────────────────────────────────────────────────

export const CURRICULUM_QUESTION_TYPES = ['single', 'multiple', 'true_false'] as const;
export type CurriculumQuestionType = (typeof CURRICULUM_QUESTION_TYPES)[number];

export interface CurriculumQuestionOption {
  key: string;
  text: string;
}

/**
 * What a wrong answer reveals. Without this, a wrong choice is just a red mark
 * and the gap it came from is lost.
 */
export interface CurriculumQuestionDistractor {
  optionKey: string;
  misconception: string;
}

export interface CurriculumQuestionRecord {
  id: string;
  taskId: string;
  unitId: string;
  objectiveId: string;
  evidenceId: string | null;
  questionType: CurriculumQuestionType;
  stem: string;
  options: CurriculumQuestionOption[];
  answer: string[];
  explanation: string | null;
  distractors: CurriculumQuestionDistractor[];
  difficulty: CurriculumDifficulty;
  bloomLevel: CurriculumBloomLevel | null;
  score: number;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export const CURRICULUM_SCORING_MODES = ['result', 'process', 'key_step', 'time', 'mixed'] as const;
export type CurriculumScoringMode = (typeof CURRICULUM_SCORING_MODES)[number];

export const CURRICULUM_RESET_POLICIES = ['on-start', 'on-demand', 'never'] as const;
export type CurriculumResetPolicy = (typeof CURRICULUM_RESET_POLICIES)[number];

/** One recommended route through the task. Never an input to grading. */
export interface LabReferenceStep {
  step: number;
  action: string;
  detail?: string;
}

/** A machine-checkable condition. This, and only this, decides a result. */
export interface LabVerifyRule {
  kind:
    | 'flag'
    | 'file_read'
    | 'file_write'
    | 'env_state'
    | 'http_request'
    | 'process_exec'
    | 'custom';
  value?: string;
  path?: string;
  key?: string;
  method?: string;
  argv?: string[];
  expression?: string;
  note?: string;
}

export interface LabKeyBehavior {
  id: string;
  description: string;
  /** Marks the step this behavior corresponds to, for process scoring. */
  stepId?: string;
}

export interface LabScoreRule {
  kind: 'result' | 'process' | 'key_step' | 'time';
  weight: number;
  stepId?: string;
  note?: string;
}

export interface LabHint {
  level: number;
  content: string;
  costWeight?: number;
}

export interface CurriculumLabTaskRecord {
  id: string;
  taskId: string;
  unitId: string;
  objectiveId: string;
  evidenceId: string | null;
  assessmentMode: CurriculumAssessmentMode;
  taskGoal: string;
  brief: string;
  expectedResult: string | null;
  dockerImage: string;
  containerConfig: Record<string, unknown>;
  initState: Record<string, unknown>;
  resetPolicy: CurriculumResetPolicy;
  /**
   * Kept separate from {@link verifyRules} on purpose. A CTF task has many
   * correct routes; grading against this path would mark a correct solve wrong.
   * It exists for hints and write-ups.
   */
  referenceSolution: LabReferenceStep[] | null;
  verifyRules: LabVerifyRule[];
  keyBehaviors: LabKeyBehavior[];
  finalStateRule: string | null;
  scoreRules: LabScoreRule[];
  scoringMode: CurriculumScoringMode;
  timeLimitSec: number | null;
  hintPolicy: CurriculumHintPolicy;
  allowRetry: boolean;
  hintLadder: LabHint[];
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

// ── Audit ───────────────────────────────────────────────────────────────────

export const CURRICULUM_AUDIT_SEVERITIES = ['error', 'warning', 'info'] as const;
export type CurriculumAuditSeverity = (typeof CURRICULUM_AUDIT_SEVERITIES)[number];

export const CURRICULUM_AUDIT_FINDING_STATUSES = ['open', 'resolved', 'waived'] as const;
export type CurriculumAuditFindingStatus = (typeof CURRICULUM_AUDIT_FINDING_STATUSES)[number];

export interface CurriculumAuditFindingRecord {
  id: string;
  taskId: string;
  ruleCode: string;
  severity: CurriculumAuditSeverity;
  message: string;
  refKind: string | null;
  refId: string | null;
  refIds: string[];
  status: CurriculumAuditFindingStatus;
  createdAt: string;
  updatedAt: string;
}

// ── Snapshot ────────────────────────────────────────────────────────────────

/**
 * Everything the design workspace needs for one task. The two views the
 * workspace offers — "from outcome to course" and "from course to outcome" —
 * are both answered from this one payload.
 */
export interface CurriculumDesignSnapshot {
  task: CurriculumTaskRecord;
  objectives: CurriculumObjectiveRecord[];
  evidence: CurriculumEvidenceRecord[];
  nodes: CurriculumLearningNodeRecord[];
  nodeObjectives: CurriculumNodeObjectiveRecord[];
  dependencies: CurriculumDependencyRecord[];
  units: CurriculumUnitRecord[];
  unitCoverage: CurriculumUnitCoverageRecord[];
  unitDependencies: CurriculumUnitDependencyRecord[];
  questions: CurriculumQuestionRecord[];
  labTasks: CurriculumLabTaskRecord[];
  auditFindings: CurriculumAuditFindingRecord[];
}
