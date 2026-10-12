/**
 * The reverse-design store: CRUD over the outcome-first curriculum tables, plus
 * the phase machine that keeps design in order.
 *
 * Two things here are more than plumbing.
 *
 * **The phase machine.** A task carries a `design_phase`, and this store will
 * not author a later phase's rows while the task is still in an earlier one.
 * That is the enforcement of "outcomes before knowledge, knowledge before
 * outline, outline before materials" — a rule the model documents but cannot
 * otherwise keep, because every table is individually writable.
 *
 * **Ownership is checked on every foreign key.** `curriculum_dependency`
 * deliberately has no foreign keys on its endpoints, so a mixed objective/node
 * graph can live in one table; the price is that nothing but this store stops
 * an edge pointing at a row that does not exist. Every write therefore
 * validates its endpoints, and the write is refused rather than stored broken.
 */
import { randomBytes } from 'node:crypto';

import type { Queryable } from '@openmaic/storage/document/pg';
import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

import type {
  CurriculumAssessmentMode,
  CurriculumAuditFindingRecord,
  CurriculumAuditFindingStatus,
  CurriculumAuditSeverity,
  CurriculumConfirmationActor,
  CurriculumCoverageDepth,
  CurriculumCoverageKind,
  CurriculumDeckDesign,
  CurriculumDependencyEdgeType,
  CurriculumDependencyKind,
  CurriculumDependencyRecord,
  CurriculumDesignConfirmationRecord,
  CurriculumDesignPhase,
  CurriculumDesignSnapshot,
  CurriculumDifficulty,
  CurriculumEvidenceRecord,
  CurriculumEvidenceType,
  CurriculumHintPolicy,
  CurriculumLabTaskRecord,
  CurriculumLearningNodeRecord,
  CurriculumNodeObjectiveRecord,
  CurriculumNodeType,
  CurriculumObjectiveLevel,
  CurriculumObjectiveRecord,
  CurriculumObjectiveStatus,
  CurriculumObjectiveType,
  CurriculumQuestionRecord,
  CurriculumQuestionType,
  CurriculumSupportLevel,
  CurriculumTaskRecord,
  CurriculumTaskStatus,
  CurriculumTeachingDesign,
  CurriculumUnitCoverageRecord,
  CurriculumUnitDependencyEdgeType,
  CurriculumUnitDependencyRecord,
  CurriculumUnitRecord,
  CurriculumUnitRole,
  CurriculumUnitType,
  LabHint,
  LabKeyBehavior,
  LabReferenceStep,
  LabScoreRule,
  LabVerifyRule,
} from '@/lib/curriculum/design-types';
import {
  auditCurriculumDesign,
  evaluateCurriculumQuality,
  type CurriculumAuditFinding,
} from '@/lib/curriculum/audit';
import { buildDesignCoverage, summariseCoverage } from '@/lib/curriculum/design-coverage';
import { changedDirectionKeys, directionValuesOf } from '@/lib/curriculum/design-direction';
import { deriveVerifiability, nextCurriculumDesignPhase } from '@/lib/curriculum/design-types';
import { examStrictRefusal } from '@/lib/curriculum/lab-authoring';
import { curriculumQualityLayerLabel } from '@/lib/curriculum/quality-labels';
import { ensureCurriculumSchema } from '@/lib/persistence/curriculum';
import { withSchemaBootstrapLock } from '@/lib/persistence/schema-bootstrap-lock';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';

export class CurriculumDesignNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CurriculumDesignNotFoundError';
  }
}

export class CurriculumDesignValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CurriculumDesignValidationError';
  }
}

/**
 * Raised when the design phase refuses an operation — either a write that
 * belongs to a phase the task has not reached, or an attempt to leave the
 * current phase while it is still incomplete.
 *
 * `current` is where the task is, `required` is the phase whose threshold was
 * not met. Both refusals carry the pair, so a client has one shape to read
 * rather than having to tell "you are too early" from "you are not done yet".
 */
export class CurriculumPhaseError extends Error {
  constructor(
    readonly current: CurriculumDesignPhase,
    readonly required: CurriculumDesignPhase,
    message: string,
  ) {
    super(message);
    this.name = 'CurriculumPhaseError';
  }
}

// ── Inputs ──────────────────────────────────────────────────────────────────

export interface CurriculumTaskInput {
  seriesId?: string | null;
  title: string;
  audience?: string | null;
  learnerLevel?: string | null;
  trainingScenario?: string | null;
  durationHours?: number | null;
  applicationScene?: string | null;
  problemStatement?: string | null;
  status?: CurriculumTaskStatus;
}

export type CurriculumTaskPatch = Partial<CurriculumTaskInput>;

export interface CurriculumObjectiveInput {
  parentId?: string | null;
  code?: string | null;
  title: string;
  description?: string | null;
  objectiveType: CurriculumObjectiveType;
  bloomLevel?: string | null;
  level?: CurriculumObjectiveLevel;
  expectedBehavior?: string;
  minCriteria?: string[];
  proficientCriteria?: string[];
  excellentCriteria?: string[];
  difficulty?: CurriculumDifficulty;
  verifiable?: boolean;
  unverifiableReason?: string | null;
  status?: CurriculumObjectiveStatus;
  sortOrder?: number;
}

export type CurriculumObjectivePatch = Partial<CurriculumObjectiveInput>;

export interface CurriculumEvidenceInput {
  objectiveId: string;
  evidenceType: CurriculumEvidenceType;
  verificationMethod: string;
  successCondition: string;
  conditionExpression?: string | null;
  auxiliaryCondition?: string | null;
  assessmentMode?: CurriculumAssessmentMode;
  thresholdPass?: number;
  thresholdProficient?: number;
  thresholdExcellent?: number;
  timeLimitSec?: number | null;
  hintPolicy?: CurriculumHintPolicy;
  independent?: boolean;
  processRecord?: boolean;
  sortOrder?: number;
}

export type CurriculumEvidencePatch = Partial<CurriculumEvidenceInput>;

export interface CurriculumLearningNodeInput {
  parentId?: string | null;
  code?: string | null;
  name: string;
  nodeType: CurriculumNodeType;
  summary?: string | null;
  difficulty?: CurriculumDifficulty | null;
  sortOrder?: number;
}

export type CurriculumLearningNodePatch = Partial<CurriculumLearningNodeInput>;

export interface CurriculumNodeObjectiveInput {
  nodeId: string;
  objectiveId: string;
  supportLevel?: CurriculumSupportLevel;
  note?: string | null;
}

export interface CurriculumDependencyInput {
  sourceId: string;
  targetId: string;
  sourceKind: CurriculumDependencyKind;
  targetKind: CurriculumDependencyKind;
  edgeType: CurriculumDependencyEdgeType;
  strength?: number;
  note?: string | null;
}

export interface CurriculumUnitInput {
  parentId?: string | null;
  unitType: CurriculumUnitType;
  title: string;
  code?: string | null;
  unitRole?: CurriculumUnitRole | null;
  hours?: number | null;
  orderIndex?: number;
  teachingDesign?: CurriculumTeachingDesign;
  deckDesign?: CurriculumDeckDesign;
  stageId?: string | null;
}

export type CurriculumUnitPatch = Partial<CurriculumUnitInput>;

export interface CurriculumUnitCoverageInput {
  unitId: string;
  objectiveId: string;
  coverageKind: CurriculumCoverageKind;
  depth?: CurriculumCoverageDepth;
  orderIndex?: number;
  note?: string | null;
}

export interface CurriculumUnitDependencyInput {
  sourceUnitId: string;
  targetUnitId: string;
  edgeType?: CurriculumUnitDependencyEdgeType;
  strength?: number;
  note?: string | null;
}

export interface CurriculumQuestionInput {
  unitId: string;
  objectiveId: string;
  evidenceId?: string | null;
  questionType: CurriculumQuestionType;
  stem: string;
  options?: { key: string; text: string }[];
  answer?: string[];
  explanation?: string | null;
  distractors?: { optionKey: string; misconception: string }[];
  difficulty?: CurriculumDifficulty;
  bloomLevel?: string | null;
  score?: number;
  sortOrder?: number;
}

export type CurriculumQuestionPatch = Partial<CurriculumQuestionInput>;

export interface CurriculumLabTaskInput {
  unitId: string;
  objectiveId: string;
  evidenceId?: string | null;
  assessmentMode?: CurriculumAssessmentMode;
  taskGoal: string;
  brief?: string;
  expectedResult?: string | null;
  dockerImage: string;
  containerConfig?: Record<string, unknown>;
  initState?: Record<string, unknown>;
  resetPolicy?: string;
  referenceSolution?: LabReferenceStep[] | null;
  verifyRules: LabVerifyRule[];
  keyBehaviors?: LabKeyBehavior[];
  finalStateRule?: string | null;
  scoreRules?: LabScoreRule[];
  scoringMode?: string;
  timeLimitSec?: number | null;
  hintPolicy?: CurriculumHintPolicy;
  allowRetry?: boolean;
  hintLadder?: LabHint[];
  sortOrder?: number;
}

export type CurriculumLabTaskPatch = Partial<CurriculumLabTaskInput>;

export interface CurriculumAuditFindingInput {
  ruleCode: string;
  severity?: CurriculumAuditSeverity;
  message: string;
  refKind?: string | null;
  refId?: string | null;
  refIds?: string[];
  status?: CurriculumAuditFindingStatus;
}

// ── Rows ────────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

interface TaskRow extends Row {
  id: string;
  series_id: string | null;
  title: string;
  audience: string | null;
  learner_level: string | null;
  training_scenario: string | null;
  duration_hours: number | string | null;
  application_scene: string | null;
  problem_statement: string | null;
  status: string;
  design_phase: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ObjectiveRow extends Row {
  id: string;
  task_id: string;
  parent_id: string | null;
  code: string | null;
  title: string;
  description: string | null;
  objective_type: string;
  bloom_level: string | null;
  level: string;
  expected_behavior: string;
  min_criteria: unknown;
  proficient_criteria: unknown;
  excellent_criteria: unknown;
  difficulty: string;
  verifiable: boolean;
  unverifiable_reason: string | null;
  status: string;
  sort_order: number | string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface EvidenceRow extends Row {
  id: string;
  task_id: string;
  objective_id: string;
  evidence_type: string;
  verification_method: string;
  success_condition: string;
  condition_expression: string | null;
  auxiliary_condition: string | null;
  assessment_mode: string;
  threshold_pass: number | string;
  threshold_proficient: number | string;
  threshold_excellent: number | string;
  time_limit_sec: number | string | null;
  hint_policy: string;
  independent: boolean;
  process_record: boolean;
  sort_order: number | string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface NodeRow extends Row {
  id: string;
  task_id: string;
  parent_id: string | null;
  code: string | null;
  name: string;
  node_type: string;
  summary: string | null;
  difficulty: string | null;
  sort_order: number | string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface NodeObjectiveRow extends Row {
  id: string;
  task_id: string;
  node_id: string;
  objective_id: string;
  support_level: string;
  note: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface DependencyRow extends Row {
  id: string;
  task_id: string;
  source_id: string;
  target_id: string;
  source_kind: string;
  target_kind: string;
  edge_type: string;
  strength: number | string;
  note: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface UnitRow extends Row {
  id: string;
  task_id: string;
  parent_id: string | null;
  unit_type: string;
  title: string;
  code: string | null;
  unit_role: string | null;
  hours: number | string | null;
  order_index: number | string;
  teaching_design: unknown;
  deck_design: unknown;
  stage_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface UnitCoverageRow extends Row {
  id: string;
  task_id: string;
  unit_id: string;
  objective_id: string;
  coverage_kind: string;
  depth: string;
  order_index: number | string;
  note: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface UnitDependencyRow extends Row {
  id: string;
  task_id: string;
  source_unit_id: string;
  target_unit_id: string;
  edge_type: string;
  strength: number | string;
  note: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface QuestionRow extends Row {
  id: string;
  task_id: string;
  unit_id: string;
  objective_id: string;
  evidence_id: string | null;
  question_type: string;
  stem: string;
  options: unknown;
  answer: unknown;
  explanation: string | null;
  distractors: unknown;
  difficulty: string;
  bloom_level: string | null;
  score: number | string;
  sort_order: number | string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface LabTaskRow extends Row {
  id: string;
  task_id: string;
  unit_id: string;
  objective_id: string;
  evidence_id: string | null;
  assessment_mode: string;
  task_goal: string;
  brief: string;
  expected_result: string | null;
  docker_image: string;
  container_config: unknown;
  init_state: unknown;
  reset_policy: string;
  reference_solution: unknown;
  verify_rules: unknown;
  key_behaviors: unknown;
  final_state_rule: string | null;
  score_rules: unknown;
  scoring_mode: string;
  time_limit_sec: number | string | null;
  hint_policy: string;
  allow_retry: boolean;
  hint_ladder: unknown;
  sort_order: number | string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface AuditFindingRow extends Row {
  id: string;
  task_id: string;
  rule_code: string;
  severity: string;
  message: string;
  ref_kind: string | null;
  ref_id: string | null;
  ref_ids: unknown;
  status: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ConfirmationRow extends Row {
  id: string;
  task_id: string;
  step: string;
  confirmed_by: string;
  note: string | null;
  confirmed_at: Date | string;
}

// ── Column lists ────────────────────────────────────────────────────────────

const TASK_COLUMNS = `id, series_id, title, audience, learner_level, training_scenario,
       duration_hours, application_scene, problem_statement, status, design_phase,
       created_at, updated_at`;

const OBJECTIVE_COLUMNS = `id, task_id, parent_id, code, title, description, objective_type,
       bloom_level, level, expected_behavior, min_criteria, proficient_criteria,
       excellent_criteria, difficulty, verifiable, unverifiable_reason, status, sort_order,
       created_at, updated_at`;

const EVIDENCE_COLUMNS = `id, task_id, objective_id, evidence_type, verification_method,
       success_condition, condition_expression, auxiliary_condition, assessment_mode,
       threshold_pass, threshold_proficient, threshold_excellent, time_limit_sec,
       hint_policy, independent, process_record, sort_order, created_at, updated_at`;

const NODE_COLUMNS = `id, task_id, parent_id, code, name, node_type, summary, difficulty,
       sort_order, created_at, updated_at`;

const NODE_OBJECTIVE_COLUMNS = `id, task_id, node_id, objective_id, support_level, note,
       created_at, updated_at`;

const DEPENDENCY_COLUMNS = `id, task_id, source_id, target_id, source_kind, target_kind,
       edge_type, strength, note, created_at, updated_at`;

const UNIT_COLUMNS = `id, task_id, parent_id, unit_type, title, code, unit_role, hours,
       order_index, teaching_design, deck_design, stage_id, created_at, updated_at`;

const UNIT_COVERAGE_COLUMNS = `id, task_id, unit_id, objective_id, coverage_kind, depth,
       order_index, note, created_at, updated_at`;

const UNIT_DEPENDENCY_COLUMNS = `id, task_id, source_unit_id, target_unit_id, edge_type,
       strength, note, created_at, updated_at`;

const QUESTION_COLUMNS = `id, task_id, unit_id, objective_id, evidence_id, question_type, stem,
       options, answer, explanation, distractors, difficulty, bloom_level, score, sort_order,
       created_at, updated_at`;

const LAB_TASK_COLUMNS = `id, task_id, unit_id, objective_id, evidence_id, assessment_mode,
       task_goal, brief, expected_result, docker_image, container_config, init_state,
       reset_policy, reference_solution, verify_rules, key_behaviors, final_state_rule,
       score_rules, scoring_mode, time_limit_sec, hint_policy, allow_retry, hint_ladder,
       sort_order, created_at, updated_at`;

const AUDIT_FINDING_COLUMNS = `id, task_id, rule_code, severity, message, ref_kind, ref_id,
       ref_ids, status, created_at, updated_at`;

const CONFIRMATION_COLUMNS = `id, task_id, step, confirmed_by, note, confirmed_at`;

// ── Provider ────────────────────────────────────────────────────────────────

const SCHEMA_STATE_KEY = Symbol.for('openmaic.curriculum-design.schema');
const schemaState = globalThis as typeof globalThis & {
  [SCHEMA_STATE_KEY]?: { connectionString: string; ready: Promise<void> };
};

export async function getCurriculumDesignProvider() {
  const connectionString = process.env.DATABASE_URL ?? '';
  const persistence = await getServerPersistenceProvider(connectionString);
  const cached = schemaState[SCHEMA_STATE_KEY];
  if (!cached || cached.connectionString !== connectionString) {
    const ready = withSchemaBootstrapLock(
      persistence.pool as unknown as ConnectableQueryable,
      ensureCurriculumSchema,
    );
    schemaState[SCHEMA_STATE_KEY] = { connectionString, ready };
    ready.catch(() => {
      if (schemaState[SCHEMA_STATE_KEY]?.ready === ready) delete schemaState[SCHEMA_STATE_KEY];
    });
  }
  await schemaState[SCHEMA_STATE_KEY]!.ready;
  return persistence;
}

export function resetCurriculumDesignSchemaForTests(): void {
  delete schemaState[SCHEMA_STATE_KEY];
}

// ── Small helpers ───────────────────────────────────────────────────────────

function createId(prefix: string): string {
  return `${prefix}-${randomBytes(9).toString('base64url')}`;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function numeric(value: number | string): number {
  return typeof value === 'number' ? value : Number(value);
}

function nullableNumeric(value: number | string | null): number | null {
  return value === null ? value : numeric(value);
}

function optionalText(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function requiredText(value: string | null | undefined, field: string): string {
  const text = optionalText(value);
  if (!text) throw new CurriculumDesignValidationError(`${field} 不能为空`);
  return text;
}

/** JSONB columns round-trip through the driver as strings on some paths. */
function jsonValue<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

function stringList(value: unknown): string[] {
  const parsed = jsonValue<unknown>(value, []);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry): entry is string => typeof entry === 'string');
}

function jsonParam(value: unknown): string {
  return JSON.stringify(value ?? null);
}

// ── Mappers ─────────────────────────────────────────────────────────────────

function mapTask(row: TaskRow): CurriculumTaskRecord {
  return {
    id: row.id,
    seriesId: row.series_id,
    title: row.title,
    audience: row.audience,
    learnerLevel: row.learner_level,
    trainingScenario: row.training_scenario,
    durationHours: nullableNumeric(row.duration_hours),
    applicationScene: row.application_scene,
    problemStatement: row.problem_statement,
    status: row.status as CurriculumTaskStatus,
    designPhase: row.design_phase as CurriculumDesignPhase,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapObjective(row: ObjectiveRow): CurriculumObjectiveRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    parentId: row.parent_id,
    code: row.code,
    title: row.title,
    description: row.description,
    objectiveType: row.objective_type as CurriculumObjectiveType,
    bloomLevel: row.bloom_level as CurriculumObjectiveRecord['bloomLevel'],
    level: row.level as CurriculumObjectiveLevel,
    expectedBehavior: row.expected_behavior,
    minCriteria: stringList(row.min_criteria),
    proficientCriteria: stringList(row.proficient_criteria),
    excellentCriteria: stringList(row.excellent_criteria),
    difficulty: row.difficulty as CurriculumDifficulty,
    verifiable: row.verifiable,
    unverifiableReason: row.unverifiable_reason,
    status: row.status as CurriculumObjectiveStatus,
    sortOrder: numeric(row.sort_order),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapEvidence(row: EvidenceRow): CurriculumEvidenceRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    objectiveId: row.objective_id,
    evidenceType: row.evidence_type as CurriculumEvidenceType,
    verificationMethod: row.verification_method,
    successCondition: row.success_condition,
    conditionExpression: row.condition_expression,
    auxiliaryCondition: row.auxiliary_condition,
    assessmentMode: row.assessment_mode as CurriculumAssessmentMode,
    thresholdPass: numeric(row.threshold_pass),
    thresholdProficient: numeric(row.threshold_proficient),
    thresholdExcellent: numeric(row.threshold_excellent),
    timeLimitSec: nullableNumeric(row.time_limit_sec),
    hintPolicy: row.hint_policy as CurriculumHintPolicy,
    independent: row.independent,
    processRecord: row.process_record,
    sortOrder: numeric(row.sort_order),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapNode(row: NodeRow): CurriculumLearningNodeRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    parentId: row.parent_id,
    code: row.code,
    name: row.name,
    nodeType: row.node_type as CurriculumNodeType,
    summary: row.summary,
    difficulty: row.difficulty as CurriculumDifficulty | null,
    sortOrder: numeric(row.sort_order),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapNodeObjective(row: NodeObjectiveRow): CurriculumNodeObjectiveRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    nodeId: row.node_id,
    objectiveId: row.objective_id,
    supportLevel: row.support_level as CurriculumSupportLevel,
    note: row.note,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapDependency(row: DependencyRow): CurriculumDependencyRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    sourceId: row.source_id,
    targetId: row.target_id,
    sourceKind: row.source_kind as CurriculumDependencyKind,
    targetKind: row.target_kind as CurriculumDependencyKind,
    edgeType: row.edge_type as CurriculumDependencyEdgeType,
    strength: numeric(row.strength),
    note: row.note,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapUnit(row: UnitRow): CurriculumUnitRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    parentId: row.parent_id,
    unitType: row.unit_type as CurriculumUnitType,
    title: row.title,
    code: row.code,
    unitRole: row.unit_role as CurriculumUnitRole | null,
    hours: nullableNumeric(row.hours),
    orderIndex: numeric(row.order_index),
    teachingDesign: jsonValue<CurriculumTeachingDesign>(row.teaching_design, {}),
    deckDesign: jsonValue<CurriculumDeckDesign>(row.deck_design, {}),
    stageId: row.stage_id,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapUnitCoverage(row: UnitCoverageRow): CurriculumUnitCoverageRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    unitId: row.unit_id,
    objectiveId: row.objective_id,
    coverageKind: row.coverage_kind as CurriculumCoverageKind,
    depth: row.depth as CurriculumCoverageDepth,
    orderIndex: numeric(row.order_index),
    note: row.note,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapUnitDependency(row: UnitDependencyRow): CurriculumUnitDependencyRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    sourceUnitId: row.source_unit_id,
    targetUnitId: row.target_unit_id,
    edgeType: row.edge_type as CurriculumUnitDependencyEdgeType,
    strength: numeric(row.strength),
    note: row.note,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapQuestion(row: QuestionRow): CurriculumQuestionRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    unitId: row.unit_id,
    objectiveId: row.objective_id,
    evidenceId: row.evidence_id,
    questionType: row.question_type as CurriculumQuestionType,
    stem: row.stem,
    options: jsonValue(row.options, []),
    answer: stringList(row.answer),
    explanation: row.explanation,
    distractors: jsonValue(row.distractors, []),
    difficulty: row.difficulty as CurriculumDifficulty,
    bloomLevel: row.bloom_level as CurriculumQuestionRecord['bloomLevel'],
    score: numeric(row.score),
    sortOrder: numeric(row.sort_order),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapLabTask(row: LabTaskRow): CurriculumLabTaskRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    unitId: row.unit_id,
    objectiveId: row.objective_id,
    evidenceId: row.evidence_id,
    assessmentMode: row.assessment_mode as CurriculumAssessmentMode,
    taskGoal: row.task_goal,
    brief: row.brief,
    expectedResult: row.expected_result,
    dockerImage: row.docker_image,
    containerConfig: jsonValue<Record<string, unknown>>(row.container_config, {}),
    initState: jsonValue<Record<string, unknown>>(row.init_state, {}),
    resetPolicy: row.reset_policy as CurriculumLabTaskRecord['resetPolicy'],
    referenceSolution: jsonValue<LabReferenceStep[] | null>(row.reference_solution, null),
    verifyRules: jsonValue<LabVerifyRule[]>(row.verify_rules, []),
    keyBehaviors: jsonValue<LabKeyBehavior[]>(row.key_behaviors, []),
    finalStateRule: row.final_state_rule,
    scoreRules: jsonValue<LabScoreRule[]>(row.score_rules, []),
    scoringMode: row.scoring_mode as CurriculumLabTaskRecord['scoringMode'],
    timeLimitSec: nullableNumeric(row.time_limit_sec),
    hintPolicy: row.hint_policy as CurriculumHintPolicy,
    allowRetry: row.allow_retry,
    hintLadder: jsonValue<LabHint[]>(row.hint_ladder, []),
    sortOrder: numeric(row.sort_order),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapAuditFinding(row: AuditFindingRow): CurriculumAuditFindingRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    ruleCode: row.rule_code,
    severity: row.severity as CurriculumAuditSeverity,
    message: row.message,
    refKind: row.ref_kind,
    refId: row.ref_id,
    refIds: stringList(row.ref_ids),
    status: row.status as CurriculumAuditFindingStatus,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapConfirmation(row: ConfirmationRow): CurriculumDesignConfirmationRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    step: row.step as CurriculumDesignPhase,
    confirmedAt: iso(row.confirmed_at),
    confirmedBy: row.confirmed_by as CurriculumConfirmationActor,
    note: row.note,
  };
}

// ── Phase machine ───────────────────────────────────────────────────────────

/**
 * Which phase must a task have reached before rows of `required` may be
 * written? Phases are ordered, so the rule is simply "the task is at or past
 * this phase". Editing always stays allowed: a course being revised should not
 * be frozen at the phase it first reached.
 */
const PHASE_ORDER: readonly CurriculumDesignPhase[] = [
  'task',
  'outcomes',
  'graph',
  'outline',
  'teaching',
  'assessment',
  'review',
];

function phaseRank(phase: CurriculumDesignPhase): number {
  const index = PHASE_ORDER.indexOf(phase);
  return index < 0 ? 0 : index;
}

async function readTaskPhase(
  queryable: Queryable,
  ownerId: string,
  taskId: string,
): Promise<CurriculumDesignPhase> {
  const result = await queryable.query<{ design_phase: string }>(
    'SELECT design_phase FROM curriculum_task WHERE owner_id = $1 AND id = $2',
    [ownerId, taskId],
  );
  const row = result.rows[0];
  if (!row) throw new CurriculumDesignNotFoundError('课程任务不存在');
  return row.design_phase as CurriculumDesignPhase;
}

async function assertPhase(
  queryable: Queryable,
  ownerId: string,
  taskId: string,
  required: CurriculumDesignPhase,
): Promise<CurriculumDesignPhase> {
  const current = await readTaskPhase(queryable, ownerId, taskId);
  if (phaseRank(current) < phaseRank(required)) {
    throw new CurriculumPhaseError(
      current,
      required,
      `课程任务当前处于「${current}」阶段；「${required}」的工作在它之后。` + '请先完成当前阶段。',
    );
  }
  return current;
}

// ── Existence checks ────────────────────────────────────────────────────────

async function readObjectiveRow(
  queryable: Queryable,
  ownerId: string,
  objectiveId: string,
): Promise<ObjectiveRow | null> {
  const result = await queryable.query<ObjectiveRow>(
    `SELECT ${OBJECTIVE_COLUMNS} FROM curriculum_objective WHERE owner_id = $1 AND id = $2`,
    [ownerId, objectiveId],
  );
  return result.rows[0] ?? null;
}

async function readNodeRow(
  queryable: Queryable,
  ownerId: string,
  nodeId: string,
): Promise<NodeRow | null> {
  const result = await queryable.query<NodeRow>(
    `SELECT ${NODE_COLUMNS} FROM curriculum_learning_node WHERE owner_id = $1 AND id = $2`,
    [ownerId, nodeId],
  );
  return result.rows[0] ?? null;
}

async function readUnitRow(
  queryable: Queryable,
  ownerId: string,
  unitId: string,
): Promise<UnitRow | null> {
  const result = await queryable.query<UnitRow>(
    `SELECT ${UNIT_COLUMNS} FROM curriculum_unit WHERE owner_id = $1 AND id = $2`,
    [ownerId, unitId],
  );
  return result.rows[0] ?? null;
}

async function assertSeriesOwned(
  queryable: Queryable,
  ownerId: string,
  seriesId: string | null | undefined,
): Promise<void> {
  if (!seriesId) return;
  const result = await queryable.query<{ id: string }>(
    'SELECT id FROM curriculum_series WHERE owner_id = $1 AND id = $2',
    [ownerId, seriesId],
  );
  if (!result.rows[0]) throw new CurriculumDesignNotFoundError('课程系列不存在');
}

/**
 * A dependency endpoint must exist and belong to the same task. The edge table
 * has no foreign keys by design, so this is the only thing standing between a
 * mixed graph and a graph of dangling ids.
 */
async function assertEndpointOwned(
  queryable: Queryable,
  ownerId: string,
  taskId: string,
  id: string,
  kind: CurriculumDependencyKind,
): Promise<void> {
  const row =
    kind === 'objective'
      ? await readObjectiveRow(queryable, ownerId, id)
      : await readNodeRow(queryable, ownerId, id);
  if (!row) throw new CurriculumDesignNotFoundError(`${kind} 不存在：${id}`);
  if (row.task_id !== taskId) {
    throw new CurriculumDesignValidationError(`${kind} ${id} 不属于同一个课程任务`);
  }
}

// ── Task CRUD ───────────────────────────────────────────────────────────────

export async function createCurriculumTask(
  queryable: Queryable,
  ownerId: string,
  input: CurriculumTaskInput,
): Promise<CurriculumTaskRecord> {
  const title = requiredText(input.title, 'title');
  await assertSeriesOwned(queryable, ownerId, input.seriesId);
  const result = await queryable.query<TaskRow>(
    `INSERT INTO curriculum_task
       (id, owner_id, series_id, title, audience, learner_level, training_scenario,
        duration_hours, application_scene, problem_statement, status, design_phase)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'task')
     RETURNING ${TASK_COLUMNS}`,
    [
      createId('task'),
      ownerId,
      input.seriesId ?? null,
      title,
      optionalText(input.audience),
      optionalText(input.learnerLevel),
      optionalText(input.trainingScenario),
      input.durationHours ?? null,
      optionalText(input.applicationScene),
      optionalText(input.problemStatement),
      input.status ?? 'draft',
    ],
  );
  const row = result.rows[0];
  if (!row) throw new CurriculumDesignValidationError('课程任务创建失败');
  return mapTask(row);
}

export async function updateCurriculumTask(
  queryable: Queryable,
  ownerId: string,
  taskId: string,
  patch: CurriculumTaskPatch,
): Promise<CurriculumTaskRecord> {
  const existing = await queryable.query<TaskRow>(
    `SELECT ${TASK_COLUMNS} FROM curriculum_task WHERE owner_id = $1 AND id = $2`,
    [ownerId, taskId],
  );
  const current = existing.rows[0];
  if (!current) throw new CurriculumDesignNotFoundError('课程任务不存在');
  if (patch.seriesId !== undefined) await assertSeriesOwned(queryable, ownerId, patch.seriesId);
  const nextTitle = patch.title !== undefined ? requiredText(patch.title, 'title') : current.title;

  const result = await queryable.query<TaskRow>(
    `UPDATE curriculum_task
        SET series_id = $3, title = $4, audience = $5, learner_level = $6,
            training_scenario = $7, duration_hours = $8, application_scene = $9,
            problem_statement = $10, status = $11, updated_at = now()
      WHERE owner_id = $1 AND id = $2
      RETURNING ${TASK_COLUMNS}`,
    [
      ownerId,
      taskId,
      patch.seriesId !== undefined ? patch.seriesId : current.series_id,
      nextTitle,
      patch.audience !== undefined ? optionalText(patch.audience) : current.audience,
      patch.learnerLevel !== undefined ? optionalText(patch.learnerLevel) : current.learner_level,
      patch.trainingScenario !== undefined
        ? optionalText(patch.trainingScenario)
        : current.training_scenario,
      patch.durationHours !== undefined
        ? patch.durationHours
        : nullableNumeric(current.duration_hours),
      patch.applicationScene !== undefined
        ? optionalText(patch.applicationScene)
        : current.application_scene,
      patch.problemStatement !== undefined
        ? optionalText(patch.problemStatement)
        : current.problem_statement,
      patch.status ?? (current.status as CurriculumTaskStatus),
    ],
  );
  const row = result.rows[0];
  if (!row) throw new CurriculumDesignNotFoundError('课程任务不存在');
  const updated = mapTask(row);
  // A confirmation belongs to the values it confirmed. Editing the brief after
  // the user signed it off therefore re-opens the step, or the gate would open
  // onto a card nobody agreed to. Only a real change counts: the AI restates most
  // of the card on every write, and revoking on a no-op rewrite would revoke the
  // confirmation the user just gave.
  const changed = changedDirectionKeys(
    directionValuesOf(mapTask(current)),
    directionValuesOf(updated),
  );
  if (changed.length > 0) {
    await withdrawCurriculumDesignStep(queryable, ownerId, taskId, 'task');
  }
  return updated;
}

// ── Step confirmation ───────────────────────────────────────────────────────

/**
 * Record that the user signed off a design step, so the phase machine may leave
 * it. Re-confirming replaces the previous row (the table is unique per step), and
 * {@link withdrawCurriculumDesignStep} deletes it — there is no history table,
 * because the only question the design ever asks is "is this step signed off
 * *now*".
 *
 * `actor` is deliberately caller-supplied rather than assumed: the confirmation
 * button and the AI conversation both confirm, and the record has to keep them
 * apart (see {@link CurriculumConfirmationActor}). It is not a security boundary
 * — both open the gate — it is the difference between "the user clicked" and "a
 * model said the user said so".
 */
export async function confirmCurriculumDesignStep(
  queryable: Queryable,
  ownerId: string,
  taskId: string,
  step: CurriculumDesignPhase,
  actor: CurriculumConfirmationActor,
  note?: string | null,
): Promise<CurriculumDesignConfirmationRecord> {
  const exists = await queryable.query<{ id: string }>(
    'SELECT id FROM curriculum_task WHERE owner_id = $1 AND id = $2',
    [ownerId, taskId],
  );
  if (!exists.rows[0]) throw new CurriculumDesignNotFoundError('课程任务不存在');

  const result = await queryable.query<ConfirmationRow>(
    `INSERT INTO curriculum_design_confirmation
       (id, owner_id, task_id, step, confirmed_by, note, confirmed_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (owner_id, task_id, step) DO UPDATE
       SET confirmed_by = EXCLUDED.confirmed_by,
           note = EXCLUDED.note,
           confirmed_at = now()
     RETURNING ${CONFIRMATION_COLUMNS}`,
    [createId('confirm'), ownerId, taskId, step, actor, optionalText(note)],
  );
  const row = result.rows[0];
  if (!row) throw new CurriculumDesignValidationError('确认记录写入失败');
  return mapConfirmation(row);
}

/**
 * Drop a step's confirmation. Returns whether a row was there, so a route can
 * answer 404 for "there was nothing to withdraw" rather than pretending.
 */
export async function withdrawCurriculumDesignStep(
  queryable: Queryable,
  ownerId: string,
  taskId: string,
  step: CurriculumDesignPhase,
): Promise<boolean> {
  const result = await queryable.query<{ id: string }>(
    `DELETE FROM curriculum_design_confirmation
      WHERE owner_id = $1 AND task_id = $2 AND step = $3
      RETURNING id`,
    [ownerId, taskId, step],
  );
  return result.rows.length > 0;
}

export async function getCurriculumDesignStepConfirmation(
  queryable: Queryable,
  ownerId: string,
  taskId: string,
  step: CurriculumDesignPhase,
): Promise<CurriculumDesignConfirmationRecord | null> {
  const result = await queryable.query<ConfirmationRow>(
    `SELECT ${CONFIRMATION_COLUMNS} FROM curriculum_design_confirmation
      WHERE owner_id = $1 AND task_id = $2 AND step = $3`,
    [ownerId, taskId, step],
  );
  const row = result.rows[0];
  return row ? mapConfirmation(row) : null;
}

export async function listCurriculumDesignConfirmations(
  queryable: Queryable,
  ownerId: string,
  taskId: string,
): Promise<CurriculumDesignConfirmationRecord[]> {
  const result = await queryable.query<ConfirmationRow>(
    `SELECT ${CONFIRMATION_COLUMNS} FROM curriculum_design_confirmation
      WHERE owner_id = $1 AND task_id = $2
      ORDER BY confirmed_at`,
    [ownerId, taskId],
  );
  return result.rows.map(mapConfirmation);
}

/**
 * Advance the design phase, one step at a time and only when the phase it is
 * leaving is actually complete. This is where "define the outcome before
 * choosing the content" becomes non-optional: `outcomes` cannot be entered
 * until the brief is filled in, `outline` cannot be entered until every
 * outcome has evidence, and so on.
 *
 * An incomplete boundary is refused with {@link CurriculumPhaseError} — the
 * same refusal as a write that ran ahead of the phase — so the caller always
 * receives the same pair of phases. Returning the gaps is what makes the
 * refusal actionable; returning a different error type for it is what made a
 * client treat "not finished yet" as "malformed request".
 */
export async function advanceCurriculumTaskPhase(
  queryable: Queryable,
  ownerId: string,
  taskId: string,
): Promise<CurriculumTaskRecord> {
  const current = await readTaskPhase(queryable, ownerId, taskId);
  const next = nextCurriculumDesignPhase(current);
  if (!next) return (await getCurriculumTask(queryable, ownerId, taskId))!;

  const blocking = await phaseCompletionGaps(queryable, ownerId, taskId, next);
  if (blocking.length > 0) {
    throw new CurriculumPhaseError(
      current,
      next,
      `无法进入「${next}」阶段：${blocking.join('；')}`,
    );
  }
  const result = await queryable.query<TaskRow>(
    `UPDATE curriculum_task SET design_phase = $3, updated_at = now()
      WHERE owner_id = $1 AND id = $2
      RETURNING ${TASK_COLUMNS}`,
    [ownerId, taskId, next],
  );
  const row = result.rows[0];
  if (!row) throw new CurriculumDesignNotFoundError('课程任务不存在');
  return mapTask(row);
}

/**
 * What is still missing before the task may enter `next`. An empty array means
 * the phase boundary is satisfied. Each entry names a concrete gap rather than
 * a phase name, so the message can be acted on.
 */
export async function phaseCompletionGaps(
  queryable: Queryable,
  ownerId: string,
  taskId: string,
  next: CurriculumDesignPhase,
): Promise<string[]> {
  const gaps: string[] = [];

  if (next === 'outcomes') {
    const task = await queryable.query<{
      audience: string | null;
      learner_level: string | null;
      duration_hours: number | string | null;
      problem_statement: string | null;
    }>(
      `SELECT audience, learner_level, duration_hours, problem_statement
         FROM curriculum_task WHERE owner_id = $1 AND id = $2`,
      [ownerId, taskId],
    );
    const row = task.rows[0];
    if (!row) throw new CurriculumDesignNotFoundError('课程任务不存在');
    if (!row.audience) gaps.push('课程简介缺少授课对象');
    if (!row.problem_statement) gaps.push('课程简介缺少要解决的问题');
    if (row.duration_hours === null) gaps.push('课程简介缺少培训时长');
    // The brief being filled in is not the same fact as the user having agreed
    // to it, and the AI-assisted flow is exactly where the two come apart: the
    // model writes the card in one turn, and until the author reads it back the
    // course is the model's plan rather than the author's. Every later phase
    // builds on this card, so the sign-off is checked here rather than left to
    // the UI — a client that POSTs the phase route directly meets the same gate.
    const confirmation = await getCurriculumDesignStepConfirmation(
      queryable,
      ownerId,
      taskId,
      'task',
    );
    if (!confirmation) {
      gaps.push('课程方向还没有确认（确认后才会进入学习成果阶段）');
    }
  }

  if (next === 'graph') {
    const objectives = await queryable.query<{ count: number | string }>(
      'SELECT count(*)::int AS count FROM curriculum_objective WHERE owner_id = $1 AND task_id = $2',
      [ownerId, taskId],
    );
    if (Number(objectives.rows[0]?.count ?? 0) === 0) {
      gaps.push('还没有定义任何学习目标');
    }
    // Every outcome needs a way of being evidenced before the graph is built
    // on top of it, or the graph is an unanchored collection of topics.
    const unevidenced = await queryable.query<{ id: string }>(
      `SELECT o.id FROM curriculum_objective o
         WHERE o.owner_id = $1 AND o.task_id = $2
           AND NOT EXISTS (SELECT 1 FROM curriculum_evidence e
                            WHERE e.owner_id = $1 AND e.objective_id = o.id)
         LIMIT 5`,
      [ownerId, taskId],
    );
    if (unevidenced.rows.length > 0) {
      gaps.push(`${unevidenced.rows.length} 个学习目标还没有证据，例如 ${unevidenced.rows[0].id}`);
    }
  }

  if (next === 'outline') {
    const orphanNodes = await queryable.query<{ count: number | string }>(
      `SELECT count(*)::int AS count
         FROM curriculum_learning_node n
        WHERE n.owner_id = $1 AND n.task_id = $2
          AND NOT EXISTS (SELECT 1 FROM curriculum_node_objective no
                           WHERE no.owner_id = $1 AND no.node_id = n.id)`,
      [ownerId, taskId],
    );
    if (Number(orphanNodes.rows[0]?.count ?? 0) > 0) {
      gaps.push(`${orphanNodes.rows[0].count} 个知识/技能节点不支撑任何学习目标`);
    }
  }

  if (next === 'teaching') {
    const untaught = await queryable.query<{ count: number | string }>(
      `SELECT count(*)::int AS count
         FROM curriculum_objective o
        WHERE o.owner_id = $1 AND o.task_id = $2 AND o.status <> 'archived'
          AND NOT EXISTS (SELECT 1 FROM curriculum_unit_coverage uc
                           WHERE uc.owner_id = $1 AND uc.objective_id = o.id
                             AND uc.coverage_kind = 'teach')`,
      [ownerId, taskId],
    );
    if (Number(untaught.rows[0]?.count ?? 0) > 0) {
      gaps.push(`${untaught.rows[0].count} 个学习目标还没有被任何条目讲授`);
    }
  }

  // Deliberately the same predicate as the `teaching` boundary above — not a
  // copy-paste. An outcome may still be authored while the task sits in
  // `teaching` (creating one needs `outcomes`, which is at-or-past), and such
  // an outcome has no teaching yet. Re-checking here is what stops the task
  // entering `assessment` — where questions and lab tasks get authored — on top
  // of an outcome the course never teaches.
  if (next === 'assessment') {
    const untaught = await queryable.query<{ count: number | string }>(
      `SELECT count(*)::int AS count
         FROM curriculum_objective o
        WHERE o.owner_id = $1 AND o.task_id = $2 AND o.status <> 'archived'
          AND NOT EXISTS (SELECT 1 FROM curriculum_unit_coverage uc
                           WHERE uc.owner_id = $1 AND uc.objective_id = o.id
                             AND uc.coverage_kind = 'teach')`,
      [ownerId, taskId],
    );
    if (Number(untaught.rows[0]?.count ?? 0) > 0) {
      gaps.push(`${untaught.rows[0].count} 个学习目标还没有被讲授`);
    }
  }

  return gaps;
}

export async function getCurriculumTask(
  queryable: Queryable,
  ownerId: string,
  taskId: string,
): Promise<CurriculumTaskRecord | null> {
  const result = await queryable.query<TaskRow>(
    `SELECT ${TASK_COLUMNS} FROM curriculum_task WHERE owner_id = $1 AND id = $2`,
    [ownerId, taskId],
  );
  const row = result.rows[0];
  return row ? mapTask(row) : null;
}

export async function listCurriculumTasks(
  queryable: Queryable,
  ownerId: string,
  seriesId?: string | null,
): Promise<CurriculumTaskRecord[]> {
  const result = await queryable.query<TaskRow>(
    `SELECT ${TASK_COLUMNS}
       FROM curriculum_task
      WHERE owner_id = $1 AND ($2::text IS NULL OR series_id = $2)
      ORDER BY created_at DESC`,
    [ownerId, seriesId ?? null],
  );
  return result.rows.map(mapTask);
}

/**
 * One item, owner-scoped.
 *
 * Exists because producing an item needs to read its `unitRole`, its page plan
 * and the task it belongs to, and every caller was reaching for the private
 * `readUnitRow` instead. The role is what decides what kind of run this is, so
 * a route that cannot read it cannot honour the design.
 *
 * A unit whose `taskId` does not match is still returned: deciding whether it
 * belongs to the task in the path is the caller's, because it is the caller's
 * URL that made the claim.
 */
export async function getCurriculumUnit(
  queryable: Queryable,
  ownerId: string,
  unitId: string,
): Promise<CurriculumUnitRecord | null> {
  const row = await readUnitRow(queryable, ownerId, unitId);
  return row ? mapUnit(row) : null;
}

/**
 * The outcomes one item teaches, practises or assesses.
 *
 * The expected behavior is returned rather than the title on purpose: a title
 * names a topic and a behavior names what the learner must be able to do, and
 * only the second is something a generator can build a page towards. Ordering is
 * the outcome's own, so a run's requirement lists a course's promises in the
 * order the course promised them.
 */
export async function listCurriculumUnitOutcomeBehaviors(
  queryable: Queryable,
  ownerId: string,
  unitId: string,
): Promise<string[]> {
  const result = await queryable.query<{ expected_behavior: string }>(
    `SELECT o.expected_behavior
       FROM curriculum_unit_coverage c
       JOIN curriculum_objective o
         ON o.id = c.objective_id AND o.owner_id = c.owner_id
      WHERE c.owner_id = $1 AND c.unit_id = $2
      ORDER BY o.sort_order, o.id`,
    [ownerId, unitId],
  );
  return result.rows.map((row) => row.expected_behavior);
}

export async function deleteCurriculumTask(
  queryable: Queryable,
  ownerId: string,
  taskId: string,
): Promise<void> {
  const result = await queryable.query<{ id: string }>(
    'DELETE FROM curriculum_task WHERE owner_id = $1 AND id = $2 RETURNING id',
    [ownerId, taskId],
  );
  if (!result.rows[0]) throw new CurriculumDesignNotFoundError('课程任务不存在');
}

// ── Objective CRUD ──────────────────────────────────────────────────────────

export async function createCurriculumObjective(
  queryable: Queryable,
  ownerId: string,
  taskId: string,
  input: CurriculumObjectiveInput,
): Promise<CurriculumObjectiveRecord> {
  await assertPhase(queryable, ownerId, taskId, 'outcomes');
  const title = requiredText(input.title, 'title');
  if (input.parentId) {
    const parent = await readObjectiveRow(queryable, ownerId, input.parentId);
    if (!parent) throw new CurriculumDesignNotFoundError('父级学习目标不存在');
    if (parent.task_id !== taskId) {
      throw new CurriculumDesignValidationError('父级学习目标不属于同一个课程任务');
    }
  }
  const result = await queryable.query<ObjectiveRow>(
    `INSERT INTO curriculum_objective
       (id, owner_id, task_id, parent_id, code, title, description, objective_type, bloom_level,
        level, expected_behavior, min_criteria, proficient_criteria, excellent_criteria,
        difficulty, verifiable, unverifiable_reason, status, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14::jsonb,$15,$16,$17,$18,$19)
     RETURNING ${OBJECTIVE_COLUMNS}`,
    [
      createId('obj'),
      ownerId,
      taskId,
      input.parentId ?? null,
      optionalText(input.code),
      title,
      optionalText(input.description),
      input.objectiveType,
      optionalText(input.bloomLevel),
      input.level ?? 'component',
      optionalText(input.expectedBehavior) ?? '',
      jsonParam(input.minCriteria ?? []),
      jsonParam(input.proficientCriteria ?? []),
      jsonParam(input.excellentCriteria ?? []),
      input.difficulty ?? 'basic',
      // Derived, never taken on trust. The CHECK only refuses a claim the
      // shape cannot support; nothing infers the claim from the shape, so a
      // caller that forgot to derive would store a perfectly checkable outcome
      // as unverifiable — and nothing downstream would refuse it, it would
      // just silently never be assessable. An explicit `false` still wins: an
      // outcome reclassified as a topic is a decision, not an omission.
      deriveVerifiability(input.expectedBehavior, input.minCriteria, input.verifiable),
      optionalText(input.unverifiableReason),
      input.status ?? 'draft',
      input.sortOrder ?? 0,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new CurriculumDesignValidationError('学习目标创建失败');
  return mapObjective(row);
}

export async function updateCurriculumObjective(
  queryable: Queryable,
  ownerId: string,
  objectiveId: string,
  patch: CurriculumObjectivePatch,
): Promise<CurriculumObjectiveRecord> {
  const current = await readObjectiveRow(queryable, ownerId, objectiveId);
  if (!current) throw new CurriculumDesignNotFoundError('学习目标不存在');
  if (patch.parentId) {
    const parent = await readObjectiveRow(queryable, ownerId, patch.parentId);
    if (!parent) throw new CurriculumDesignNotFoundError('父级学习目标不存在');
    if (parent.task_id !== current.task_id) {
      throw new CurriculumDesignValidationError('父级学习目标不属于同一个课程任务');
    }
  }
  // Hoisted so the derivation below reads exactly the values this UPDATE
  // writes, rather than a second, separately-merged copy of them.
  const nextBehavior =
    patch.expectedBehavior !== undefined
      ? (optionalText(patch.expectedBehavior) ?? '')
      : current.expected_behavior;
  const nextMinCriteria =
    patch.minCriteria !== undefined ? patch.minCriteria : stringList(current.min_criteria);
  const result = await queryable.query<ObjectiveRow>(
    `UPDATE curriculum_objective
        SET parent_id = $3, code = $4, title = $5, description = $6, objective_type = $7,
            bloom_level = $8, level = $9, expected_behavior = $10, min_criteria = $11::jsonb,
            proficient_criteria = $12::jsonb, excellent_criteria = $13::jsonb, difficulty = $14,
            verifiable = $15, unverifiable_reason = $16, status = $17, sort_order = $18,
            updated_at = now()
      WHERE owner_id = $1 AND id = $2
      RETURNING ${OBJECTIVE_COLUMNS}`,
    [
      ownerId,
      objectiveId,
      patch.parentId !== undefined ? patch.parentId : current.parent_id,
      patch.code !== undefined ? optionalText(patch.code) : current.code,
      patch.title !== undefined ? requiredText(patch.title, 'title') : current.title,
      patch.description !== undefined ? optionalText(patch.description) : current.description,
      patch.objectiveType ?? (current.objective_type as CurriculumObjectiveType),
      patch.bloomLevel !== undefined ? optionalText(patch.bloomLevel) : current.bloom_level,
      patch.level ?? (current.level as CurriculumObjectiveLevel),
      nextBehavior,
      jsonParam(nextMinCriteria),
      patch.proficientCriteria !== undefined
        ? jsonParam(patch.proficientCriteria)
        : jsonParam(stringList(current.proficient_criteria)),
      patch.excellentCriteria !== undefined
        ? jsonParam(patch.excellentCriteria)
        : jsonParam(stringList(current.excellent_criteria)),
      patch.difficulty ?? (current.difficulty as CurriculumDifficulty),
      // Against the MERGED fields: adding the behavior to an outcome that only
      // had a title is the ordinary way one becomes checkable, so deriving
      // from the patch alone would leave it unverifiable forever.
      deriveVerifiability(nextBehavior, nextMinCriteria, patch.verifiable),
      patch.unverifiableReason !== undefined
        ? optionalText(patch.unverifiableReason)
        : current.unverifiable_reason,
      patch.status ?? (current.status as CurriculumObjectiveStatus),
      patch.sortOrder ?? numeric(current.sort_order),
    ],
  );
  const row = result.rows[0];
  if (!row) throw new CurriculumDesignNotFoundError('学习目标不存在');
  return mapObjective(row);
}

export async function deleteCurriculumObjective(
  queryable: Queryable,
  ownerId: string,
  objectiveId: string,
): Promise<void> {
  const result = await queryable.query<{ id: string }>(
    'DELETE FROM curriculum_objective WHERE owner_id = $1 AND id = $2 RETURNING id',
    [ownerId, objectiveId],
  );
  if (!result.rows[0]) throw new CurriculumDesignNotFoundError('学习目标不存在');
}

// ── Evidence CRUD ───────────────────────────────────────────────────────────

export async function createCurriculumEvidence(
  queryable: Queryable,
  ownerId: string,
  taskId: string,
  input: CurriculumEvidenceInput,
): Promise<CurriculumEvidenceRecord> {
  await assertPhase(queryable, ownerId, taskId, 'outcomes');
  const objective = await readObjectiveRow(queryable, ownerId, input.objectiveId);
  if (!objective) throw new CurriculumDesignNotFoundError('学习目标不存在');
  if (objective.task_id !== taskId) {
    throw new CurriculumDesignValidationError('该学习目标不属于本课程任务');
  }
  const result = await queryable.query<EvidenceRow>(
    `INSERT INTO curriculum_evidence
       (id, owner_id, task_id, objective_id, evidence_type, verification_method,
        success_condition, condition_expression, auxiliary_condition, assessment_mode,
        threshold_pass, threshold_proficient, threshold_excellent, time_limit_sec,
        hint_policy, independent, process_record, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     RETURNING ${EVIDENCE_COLUMNS}`,
    [
      createId('ev'),
      ownerId,
      taskId,
      input.objectiveId,
      input.evidenceType,
      requiredText(input.verificationMethod, 'verificationMethod'),
      requiredText(input.successCondition, 'successCondition'),
      optionalText(input.conditionExpression),
      optionalText(input.auxiliaryCondition),
      input.assessmentMode ?? 'practice',
      input.thresholdPass ?? 0.6,
      input.thresholdProficient ?? 0.8,
      input.thresholdExcellent ?? 0.95,
      input.timeLimitSec ?? null,
      input.hintPolicy ?? 'unlimited',
      input.independent ?? true,
      input.processRecord ?? true,
      input.sortOrder ?? 0,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new CurriculumDesignValidationError('证据创建失败');
  return mapEvidence(row);
}

export async function deleteCurriculumEvidence(
  queryable: Queryable,
  ownerId: string,
  evidenceId: string,
): Promise<void> {
  const result = await queryable.query<{ id: string }>(
    'DELETE FROM curriculum_evidence WHERE owner_id = $1 AND id = $2 RETURNING id',
    [ownerId, evidenceId],
  );
  if (!result.rows[0]) throw new CurriculumDesignNotFoundError('证据不存在');
}

// ── Learning node CRUD ──────────────────────────────────────────────────────

export async function createCurriculumLearningNode(
  queryable: Queryable,
  ownerId: string,
  taskId: string,
  input: CurriculumLearningNodeInput,
): Promise<CurriculumLearningNodeRecord> {
  await assertPhase(queryable, ownerId, taskId, 'graph');
  const name = requiredText(input.name, 'name');
  if (input.parentId) {
    const parent = await readNodeRow(queryable, ownerId, input.parentId);
    if (!parent) throw new CurriculumDesignNotFoundError('父级知识/技能节点不存在');
    if (parent.task_id !== taskId) {
      throw new CurriculumDesignValidationError('父级知识/技能节点不属于同一个课程任务');
    }
  }
  const result = await queryable.query<NodeRow>(
    `INSERT INTO curriculum_learning_node
       (id, owner_id, task_id, parent_id, code, name, node_type, summary, difficulty, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING ${NODE_COLUMNS}`,
    [
      createId('node'),
      ownerId,
      taskId,
      input.parentId ?? null,
      optionalText(input.code),
      name,
      input.nodeType,
      optionalText(input.summary),
      input.difficulty ?? null,
      input.sortOrder ?? 0,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new CurriculumDesignValidationError('知识/技能节点创建失败');
  return mapNode(row);
}

export async function updateCurriculumLearningNode(
  queryable: Queryable,
  ownerId: string,
  nodeId: string,
  patch: CurriculumLearningNodePatch,
): Promise<CurriculumLearningNodeRecord> {
  const current = await readNodeRow(queryable, ownerId, nodeId);
  if (!current) throw new CurriculumDesignNotFoundError('知识/技能节点不存在');
  if (patch.parentId) {
    const parent = await readNodeRow(queryable, ownerId, patch.parentId);
    if (!parent) throw new CurriculumDesignNotFoundError('父级知识/技能节点不存在');
    if (parent.task_id !== current.task_id) {
      throw new CurriculumDesignValidationError('父级知识/技能节点不属于同一个课程任务');
    }
  }
  const result = await queryable.query<NodeRow>(
    `UPDATE curriculum_learning_node
        SET parent_id = $3, code = $4, name = $5, node_type = $6, summary = $7,
            difficulty = $8, sort_order = $9, updated_at = now()
      WHERE owner_id = $1 AND id = $2
      RETURNING ${NODE_COLUMNS}`,
    [
      ownerId,
      nodeId,
      patch.parentId !== undefined ? patch.parentId : current.parent_id,
      patch.code !== undefined ? optionalText(patch.code) : current.code,
      patch.name !== undefined ? requiredText(patch.name, 'name') : current.name,
      patch.nodeType ?? (current.node_type as CurriculumNodeType),
      patch.summary !== undefined ? optionalText(patch.summary) : current.summary,
      patch.difficulty !== undefined ? patch.difficulty : current.difficulty,
      patch.sortOrder ?? numeric(current.sort_order),
    ],
  );
  const row = result.rows[0];
  if (!row) throw new CurriculumDesignNotFoundError('知识/技能节点不存在');
  return mapNode(row);
}

export async function deleteCurriculumLearningNode(
  queryable: Queryable,
  ownerId: string,
  nodeId: string,
): Promise<void> {
  const result = await queryable.query<{ id: string }>(
    'DELETE FROM curriculum_learning_node WHERE owner_id = $1 AND id = $2 RETURNING id',
    [ownerId, nodeId],
  );
  if (!result.rows[0]) throw new CurriculumDesignNotFoundError('知识/技能节点不存在');
}

export async function setCurriculumNodeObjectives(
  queryable: Queryable,
  ownerId: string,
  taskId: string,
  links: CurriculumNodeObjectiveInput[],
): Promise<CurriculumNodeObjectiveRecord[]> {
  await assertPhase(queryable, ownerId, taskId, 'graph');
  // Dedupe on the pair, which is this table's own UNIQUE key. Keying on the
  // objective alone silently keeps one supporter per outcome, which is the
  // opposite of what the layer is for: an outcome built from several knowledge
  // nodes loses all but the last, and the audit then reports it as unsupported
  // on a design that does support it.
  const unique = new Map<string, CurriculumNodeObjectiveInput>();
  for (const link of links) {
    unique.set(`${link.nodeId}:${link.objectiveId}`, link);
  }
  for (const link of unique.values()) {
    const node = await readNodeRow(queryable, ownerId, link.nodeId);
    if (!node) throw new CurriculumDesignNotFoundError(`知识/技能节点不存在：${link.nodeId}`);
    const objective = await readObjectiveRow(queryable, ownerId, link.objectiveId);
    if (!objective) {
      throw new CurriculumDesignNotFoundError(`学习目标不存在：${link.objectiveId}`);
    }
    if (node.task_id !== taskId || objective.task_id !== taskId) {
      throw new CurriculumDesignValidationError('知识/技能节点和学习目标必须属于同一个课程任务');
    }
  }

  await queryable.query(
    'DELETE FROM curriculum_node_objective WHERE owner_id = $1 AND task_id = $2',
    [ownerId, taskId],
  );
  const created: CurriculumNodeObjectiveRecord[] = [];
  for (const link of unique.values()) {
    const result = await queryable.query<NodeObjectiveRow>(
      `INSERT INTO curriculum_node_objective
         (id, owner_id, task_id, node_id, objective_id, support_level, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING ${NODE_OBJECTIVE_COLUMNS}`,
      [
        createId('nobj'),
        ownerId,
        taskId,
        link.nodeId,
        link.objectiveId,
        link.supportLevel ?? 'primary',
        optionalText(link.note),
      ],
    );
    const row = result.rows[0];
    if (row) created.push(mapNodeObjective(row));
  }
  return created;
}

// ── Dependency CRUD ─────────────────────────────────────────────────────────

/**
 * The directed learning-order edges, kept acyclic. `related` and `composes`
 * are not order claims, so they are exempt: a cycle in "these two topics are
 * related to each other" is not a design error, while a cycle in
 * "you must learn A before B" is.
 */
const DIRECTED_EDGE_TYPES: readonly CurriculumDependencyEdgeType[] = [
  'prerequisite',
  'derives',
  'supports',
  'practices',
  'progresses',
];

export async function createCurriculumDependency(
  queryable: Queryable,
  ownerId: string,
  taskId: string,
  input: CurriculumDependencyInput,
): Promise<CurriculumDependencyRecord> {
  await assertPhase(queryable, ownerId, taskId, 'graph');
  if (input.sourceId === input.targetId) {
    throw new CurriculumDesignValidationError('依赖不能指向自身');
  }
  await assertEndpointOwned(queryable, ownerId, taskId, input.sourceId, input.sourceKind);
  await assertEndpointOwned(queryable, ownerId, taskId, input.targetId, input.targetKind);
  await assertDependencyAcyclic(
    queryable,
    ownerId,
    taskId,
    input.sourceId,
    input.sourceKind,
    input.targetId,
    input.targetKind,
    input.edgeType,
  );

  const result = await queryable.query<DependencyRow>(
    `INSERT INTO curriculum_dependency
       (id, owner_id, task_id, source_id, target_id, source_kind, target_kind, edge_type,
        strength, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (owner_id, task_id, source_kind, source_id, target_kind, target_id, edge_type)
     DO UPDATE SET strength = EXCLUDED.strength, note = EXCLUDED.note, updated_at = now()
     RETURNING ${DEPENDENCY_COLUMNS}`,
    [
      createId('dep'),
      ownerId,
      taskId,
      input.sourceId,
      input.targetId,
      input.sourceKind,
      input.targetKind,
      input.edgeType,
      input.strength ?? 1.0,
      optionalText(input.note),
    ],
  );
  const row = result.rows[0];
  if (!row) throw new CurriculumDesignValidationError('依赖创建失败');
  return mapDependency(row);
}

/**
 * Would adding source -> target close a cycle? Walk forward from the new
 * edge's target along existing edges, following source -> target, and see
 * whether the new edge's source is ever reached. If it is, the source is
 * already downstream of its own prerequisite.
 *
 * The walk is on directed order claims only, and it matches on both the id and
 * the kind of each endpoint: `curriculum_dependency` is polymorphic, so an
 * objective id must not be able to walk a node's edges.
 */
async function assertDependencyAcyclic(
  queryable: Queryable,
  ownerId: string,
  taskId: string,
  sourceId: string,
  sourceKind: CurriculumDependencyKind,
  targetId: string,
  targetKind: CurriculumDependencyKind,
  edgeType: CurriculumDependencyEdgeType,
): Promise<void> {
  if (!DIRECTED_EDGE_TYPES.includes(edgeType)) return;
  const result = await queryable.query<{ target_id: string }>(
    `WITH RECURSIVE reachable AS (
       SELECT target_id, target_kind
         FROM curriculum_dependency
        WHERE owner_id = $1 AND task_id = $2
          AND source_id = $3 AND source_kind = $4 AND edge_type = $5
      UNION
       SELECT dep.target_id, dep.target_kind
         FROM curriculum_dependency dep
         JOIN reachable ON dep.source_id = reachable.target_id
                       AND dep.source_kind = reachable.target_kind
        WHERE dep.owner_id = $1 AND dep.task_id = $2 AND dep.edge_type = $5
     )
     SELECT target_id FROM reachable WHERE target_id = $6 AND target_kind = $7 LIMIT 1`,
    [ownerId, taskId, targetId, targetKind, edgeType, sourceId, sourceKind],
  );
  if (result.rows[0]) {
    throw new CurriculumDesignValidationError('依赖会形成环');
  }
}

export async function deleteCurriculumDependency(
  queryable: Queryable,
  ownerId: string,
  dependencyId: string,
): Promise<void> {
  const result = await queryable.query<{ id: string }>(
    'DELETE FROM curriculum_dependency WHERE owner_id = $1 AND id = $2 RETURNING id',
    [ownerId, dependencyId],
  );
  if (!result.rows[0]) throw new CurriculumDesignNotFoundError('依赖不存在');
}

// ── Unit CRUD ───────────────────────────────────────────────────────────────

/**
 * A chapter classifies and carries no teaching role; an item is a teaching
 * unit and is exactly one of lecture, practice or exam.
 *
 * The table's `curriculum_unit_role_shape` CHECK enforces this too, but a
 * constraint violation reaches the caller as a 500 — and getting this wrong is
 * an ordinary authoring mistake, not a server fault. Stated here, it is a
 * refusal that names the rule.
 */
function assertUnitRoleShape(
  unitType: CurriculumUnitType,
  unitRole: CurriculumUnitRole | null | undefined,
): void {
  const role = unitRole ?? null;
  if (unitType === 'chapter' && role !== null) {
    throw new CurriculumDesignValidationError(
      '章节只做归类，不能有教学角色；只有条目才会是 lecture、practice 或 exam',
    );
  }
  if (unitType === 'item' && role === null) {
    throw new CurriculumDesignValidationError(
      '条目是教学单元，必须声明它的角色：lecture、practice 或 exam',
    );
  }
}

export async function createCurriculumUnit(
  queryable: Queryable,
  ownerId: string,
  taskId: string,
  input: CurriculumUnitInput,
): Promise<CurriculumUnitRecord> {
  await assertPhase(queryable, ownerId, taskId, 'outline');
  const title = requiredText(input.title, 'title');
  assertUnitRoleShape(input.unitType, input.unitRole);
  if (input.parentId) {
    const parent = await readUnitRow(queryable, ownerId, input.parentId);
    if (!parent) throw new CurriculumDesignNotFoundError('父级单元不存在');
    if (parent.task_id !== taskId) {
      throw new CurriculumDesignValidationError('父级单元不属于同一个课程任务');
    }
  }
  const result = await queryable.query<UnitRow>(
    `INSERT INTO curriculum_unit
       (id, owner_id, task_id, parent_id, unit_type, title, code, unit_role, hours,
        order_index, teaching_design, deck_design, stage_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13)
     RETURNING ${UNIT_COLUMNS}`,
    [
      createId('unit'),
      ownerId,
      taskId,
      input.parentId ?? null,
      input.unitType,
      title,
      optionalText(input.code),
      input.unitRole ?? null,
      input.hours ?? null,
      input.orderIndex ?? 0,
      jsonParam(input.teachingDesign ?? {}),
      jsonParam(input.deckDesign ?? {}),
      optionalText(input.stageId),
    ],
  );
  const row = result.rows[0];
  if (!row) throw new CurriculumDesignValidationError('大纲单元创建失败');
  return mapUnit(row);
}

export async function updateCurriculumUnit(
  queryable: Queryable,
  ownerId: string,
  unitId: string,
  patch: CurriculumUnitPatch,
): Promise<CurriculumUnitRecord> {
  const current = await readUnitRow(queryable, ownerId, unitId);
  if (!current) throw new CurriculumDesignNotFoundError('大纲单元不存在');
  // Checked against the merged role and the stored kind. `unitType` is not in
  // the UPDATE below and is not meant to be: a chapter and an item are not
  // interchangeable after creation, so a patch that names one is ignored here
  // and refused by the route's own contract.
  assertUnitRoleShape(
    (current.unit_type as CurriculumUnitType) ?? 'item',
    patch.unitRole !== undefined
      ? patch.unitRole
      : (current.unit_role as CurriculumUnitRole | null),
  );
  if (patch.parentId) {
    const parent = await readUnitRow(queryable, ownerId, patch.parentId);
    if (!parent) throw new CurriculumDesignNotFoundError('父级单元不存在');
    if (parent.task_id !== current.task_id) {
      throw new CurriculumDesignValidationError('父级单元不属于同一个课程任务');
    }
  }
  const result = await queryable.query<UnitRow>(
    `UPDATE curriculum_unit
        SET parent_id = $3, title = $4, code = $5, unit_role = $6, hours = $7,
            order_index = $8, teaching_design = $9::jsonb, deck_design = $10::jsonb,
            stage_id = $11, updated_at = now()
      WHERE owner_id = $1 AND id = $2
      RETURNING ${UNIT_COLUMNS}`,
    [
      ownerId,
      unitId,
      patch.parentId !== undefined ? patch.parentId : current.parent_id,
      patch.title !== undefined ? requiredText(patch.title, 'title') : current.title,
      patch.code !== undefined ? optionalText(patch.code) : current.code,
      patch.unitRole !== undefined ? patch.unitRole : current.unit_role,
      patch.hours !== undefined ? patch.hours : nullableNumeric(current.hours),
      patch.orderIndex ?? numeric(current.order_index),
      patch.teachingDesign !== undefined
        ? jsonParam(patch.teachingDesign)
        : jsonParam(jsonValue(current.teaching_design, {})),
      patch.deckDesign !== undefined
        ? jsonParam(patch.deckDesign)
        : jsonParam(jsonValue(current.deck_design, {})),
      patch.stageId !== undefined ? optionalText(patch.stageId) : current.stage_id,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new CurriculumDesignNotFoundError('大纲单元不存在');
  return mapUnit(row);
}

export async function deleteCurriculumUnit(
  queryable: Queryable,
  ownerId: string,
  unitId: string,
): Promise<void> {
  const result = await queryable.query<{ id: string }>(
    'DELETE FROM curriculum_unit WHERE owner_id = $1 AND id = $2 RETURNING id',
    [ownerId, unitId],
  );
  if (!result.rows[0]) throw new CurriculumDesignNotFoundError('大纲单元不存在');
}

/**
 * Record one teach / practice / assess claim. Repeating the same
 * (unit, objective, kind) updates its depth and note rather than adding a
 * second, competing claim.
 */
export async function createCurriculumUnitCoverage(
  queryable: Queryable,
  ownerId: string,
  taskId: string,
  input: CurriculumUnitCoverageInput,
): Promise<CurriculumUnitCoverageRecord> {
  const unit = await readUnitRow(queryable, ownerId, input.unitId);
  if (!unit) throw new CurriculumDesignNotFoundError(`大纲单元不存在：${input.unitId}`);
  if (unit.task_id !== taskId) {
    throw new CurriculumDesignValidationError('大纲单元不属于同一个课程任务');
  }
  const objective = await readObjectiveRow(queryable, ownerId, input.objectiveId);
  if (!objective) {
    throw new CurriculumDesignNotFoundError(`学习目标不存在：${input.objectiveId}`);
  }
  if (objective.task_id !== taskId) {
    throw new CurriculumDesignValidationError('该学习目标不属于本课程任务');
  }
  // The phase gate is deliberately not applied here: revising coverage is
  // editing an existing design, and a course being revised must not be frozen
  // at the phase it first reached.

  const result = await queryable.query<UnitCoverageRow>(
    `INSERT INTO curriculum_unit_coverage
       (id, owner_id, task_id, unit_id, objective_id, coverage_kind, depth, order_index, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (unit_id, objective_id, coverage_kind)
     DO UPDATE SET depth = EXCLUDED.depth, order_index = EXCLUDED.order_index,
                   note = EXCLUDED.note, updated_at = now()
     RETURNING ${UNIT_COVERAGE_COLUMNS}`,
    [
      createId('cov'),
      ownerId,
      taskId,
      input.unitId,
      input.objectiveId,
      input.coverageKind,
      input.depth ?? 'standard',
      input.orderIndex ?? 0,
      optionalText(input.note),
    ],
  );
  const row = result.rows[0];
  if (!row) throw new CurriculumDesignValidationError('覆盖记录创建失败');
  return mapUnitCoverage(row);
}

/**
 * Replace the whole teach / practice / assess ledger for one task. Written in
 * the caller's transaction so the closed loop is never observed half-updated:
 * a moment where an objective has lost its only teaching is worse than a
 * moment where nothing changed.
 */
export async function setCurriculumUnitCoverage(
  queryable: Queryable,
  ownerId: string,
  taskId: string,
  rows: CurriculumUnitCoverageInput[],
): Promise<CurriculumUnitCoverageRecord[]> {
  await assertPhase(queryable, ownerId, taskId, 'outline');
  const unique = new Map<string, CurriculumUnitCoverageInput>();
  for (const row of rows) {
    unique.set(`${row.unitId}:${row.objectiveId}:${row.coverageKind}`, row);
  }
  for (const row of unique.values()) {
    const unit = await readUnitRow(queryable, ownerId, row.unitId);
    if (!unit) throw new CurriculumDesignNotFoundError(`大纲单元不存在：${row.unitId}`);
    const objective = await readObjectiveRow(queryable, ownerId, row.objectiveId);
    if (!objective) {
      throw new CurriculumDesignNotFoundError(`学习目标不存在：${row.objectiveId}`);
    }
    if (unit.task_id !== taskId || objective.task_id !== taskId) {
      throw new CurriculumDesignValidationError('单元和学习目标必须属于同一个课程任务');
    }
  }

  await queryable.query(
    'DELETE FROM curriculum_unit_coverage WHERE owner_id = $1 AND task_id = $2',
    [ownerId, taskId],
  );
  const created: CurriculumUnitCoverageRecord[] = [];
  for (const [index, row] of [...unique.values()].entries()) {
    const result = await queryable.query<UnitCoverageRow>(
      `INSERT INTO curriculum_unit_coverage
         (id, owner_id, task_id, unit_id, objective_id, coverage_kind, depth, order_index, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING ${UNIT_COVERAGE_COLUMNS}`,
      [
        createId('cov'),
        ownerId,
        taskId,
        row.unitId,
        row.objectiveId,
        row.coverageKind,
        row.depth ?? 'standard',
        row.orderIndex ?? index,
        optionalText(row.note),
      ],
    );
    const out = result.rows[0];
    if (out) created.push(mapUnitCoverage(out));
  }
  return created;
}

export async function createCurriculumUnitDependency(
  queryable: Queryable,
  ownerId: string,
  taskId: string,
  input: CurriculumUnitDependencyInput,
): Promise<CurriculumUnitDependencyRecord> {
  await assertPhase(queryable, ownerId, taskId, 'outline');
  if (input.sourceUnitId === input.targetUnitId) {
    throw new CurriculumDesignValidationError('单元不能作为自己的先修');
  }
  for (const unitId of [input.sourceUnitId, input.targetUnitId]) {
    const unit = await readUnitRow(queryable, ownerId, unitId);
    if (!unit) throw new CurriculumDesignNotFoundError(`大纲单元不存在：${unitId}`);
    if (unit.task_id !== taskId) {
      throw new CurriculumDesignValidationError('单元不属于同一个课程任务');
    }
  }
  const result = await queryable.query<UnitDependencyRow>(
    `INSERT INTO curriculum_unit_dependency
       (id, owner_id, task_id, source_unit_id, target_unit_id, edge_type, strength, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (owner_id, task_id, source_unit_id, target_unit_id, edge_type)
     DO UPDATE SET strength = EXCLUDED.strength, note = EXCLUDED.note, updated_at = now()
     RETURNING ${UNIT_DEPENDENCY_COLUMNS}`,
    [
      createId('udep'),
      ownerId,
      taskId,
      input.sourceUnitId,
      input.targetUnitId,
      input.edgeType ?? 'prerequisite',
      input.strength ?? 1.0,
      optionalText(input.note),
    ],
  );
  const row = result.rows[0];
  if (!row) throw new CurriculumDesignValidationError('单元依赖创建失败');
  return mapUnitDependency(row);
}

/**
 * Remove one teaching-order claim. The write counterpart is
 * {@link createCurriculumUnitDependency}, which cannot express removal: an
 * edge is an independent row, not a field, so getting the order wrong during
 * the outline phase was previously unfixable without deleting the whole task.
 *
 * The table *is* read now, and deliberately so. The audit's
 * `unit_dependency_out_of_order` and `unit_dependency_cycle` check these edges
 * against `unit.orderIndex`, so an author who declares "B follows A" and then
 * places B first is told so, and a claimed order that loops is caught. That is
 * a second, independent check from `dependency_out_of_order`, which compares
 * the *objective* graph against delivery order and knows nothing about these
 * edges: the two claims can be satisfied by different sequences, and only the
 * author's own edge says which one was meant.
 *
 * It is still a store and route concern with no agent tool, and that remains
 * deliberate. The model can author an edge it cannot withdraw, but it does not
 * need to: a wrong edge produces a finding the author can see and delete,
 * whereas an agent-writable deletion would let the same pass that writes a bad
 * order quietly erase the evidence of it.
 */
export async function deleteCurriculumUnitDependency(
  queryable: Queryable,
  ownerId: string,
  unitDependencyId: string,
): Promise<void> {
  const result = await queryable.query<{ id: string }>(
    'DELETE FROM curriculum_unit_dependency WHERE owner_id = $1 AND id = $2 RETURNING id',
    [ownerId, unitDependencyId],
  );
  if (!result.rows[0]) throw new CurriculumDesignNotFoundError('单元依赖不存在');
}

// ── Question CRUD ───────────────────────────────────────────────────────────

export async function createCurriculumQuestion(
  queryable: Queryable,
  ownerId: string,
  taskId: string,
  input: CurriculumQuestionInput,
): Promise<CurriculumQuestionRecord> {
  await assertPhase(queryable, ownerId, taskId, 'assessment');
  const stem = requiredText(input.stem, 'stem');
  const unit = await readUnitRow(queryable, ownerId, input.unitId);
  if (!unit) throw new CurriculumDesignNotFoundError('大纲单元不存在');
  const objective = await readObjectiveRow(queryable, ownerId, input.objectiveId);
  if (!objective) throw new CurriculumDesignNotFoundError('学习目标不存在');
  if (unit.task_id !== taskId || objective.task_id !== taskId) {
    throw new CurriculumDesignValidationError('单元和学习目标必须属于同一个课程任务');
  }
  // A question with nothing to select from is not a question; the answer must
  // also be a subset of the options, or it can never be marked.
  const options = input.options ?? [];
  if (input.questionType !== 'true_false' && options.length < 2) {
    throw new CurriculumDesignValidationError('选择题至少需要两个选项');
  }
  const answer = input.answer ?? [];
  if (answer.length === 0) {
    throw new CurriculumDesignValidationError('题目需要答案');
  }
  if (options.length > 0) {
    const keys = new Set(options.map((option) => option.key));
    const stray = answer.filter((key) => !keys.has(key));
    if (stray.length > 0) {
      throw new CurriculumDesignValidationError(`答案引用了不存在的选项：${stray.join('、')}`);
    }
  }

  const result = await queryable.query<QuestionRow>(
    `INSERT INTO curriculum_question
       (id, owner_id, task_id, unit_id, objective_id, evidence_id, question_type, stem, options,
        answer, explanation, distractors, difficulty, bloom_level, score, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12::jsonb,$13,$14,$15,$16)
     RETURNING ${QUESTION_COLUMNS}`,
    [
      createId('q'),
      ownerId,
      taskId,
      input.unitId,
      input.objectiveId,
      input.evidenceId ?? null,
      input.questionType,
      stem,
      jsonParam(options),
      jsonParam(answer),
      optionalText(input.explanation),
      jsonParam(input.distractors ?? []),
      input.difficulty ?? 'basic',
      optionalText(input.bloomLevel),
      input.score ?? 1,
      input.sortOrder ?? 0,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new CurriculumDesignValidationError('题目创建失败');
  return mapQuestion(row);
}

export async function updateCurriculumQuestion(
  queryable: Queryable,
  ownerId: string,
  questionId: string,
  patch: CurriculumQuestionPatch,
): Promise<CurriculumQuestionRecord> {
  const current = await queryable.query<QuestionRow>(
    `SELECT ${QUESTION_COLUMNS} FROM curriculum_question WHERE owner_id = $1 AND id = $2`,
    [ownerId, questionId],
  );
  const row = current.rows[0];
  if (!row) throw new CurriculumDesignNotFoundError('题目不存在');
  const result = await queryable.query<QuestionRow>(
    `UPDATE curriculum_question
        SET unit_id = $3, objective_id = $4, evidence_id = $5, question_type = $6, stem = $7,
            options = $8::jsonb, answer = $9::jsonb, explanation = $10, distractors = $11::jsonb,
            difficulty = $12, bloom_level = $13, score = $14, sort_order = $15, updated_at = now()
      WHERE owner_id = $1 AND id = $2
      RETURNING ${QUESTION_COLUMNS}`,
    [
      ownerId,
      questionId,
      patch.unitId ?? row.unit_id,
      patch.objectiveId ?? row.objective_id,
      patch.evidenceId !== undefined ? patch.evidenceId : row.evidence_id,
      patch.questionType ?? (row.question_type as CurriculumQuestionType),
      patch.stem !== undefined ? requiredText(patch.stem, 'stem') : row.stem,
      patch.options !== undefined
        ? jsonParam(patch.options)
        : jsonParam(jsonValue(row.options, [])),
      patch.answer !== undefined ? jsonParam(patch.answer) : jsonParam(stringList(row.answer)),
      patch.explanation !== undefined ? optionalText(patch.explanation) : row.explanation,
      patch.distractors !== undefined
        ? jsonParam(patch.distractors)
        : jsonParam(jsonValue(row.distractors, [])),
      patch.difficulty ?? (row.difficulty as CurriculumDifficulty),
      patch.bloomLevel !== undefined ? optionalText(patch.bloomLevel) : row.bloom_level,
      patch.score ?? numeric(row.score),
      patch.sortOrder ?? numeric(row.sort_order),
    ],
  );
  const updated = result.rows[0];
  if (!updated) throw new CurriculumDesignNotFoundError('题目不存在');
  return mapQuestion(updated);
}

export async function deleteCurriculumQuestion(
  queryable: Queryable,
  ownerId: string,
  questionId: string,
): Promise<void> {
  const result = await queryable.query<{ id: string }>(
    'DELETE FROM curriculum_question WHERE owner_id = $1 AND id = $2 RETURNING id',
    [ownerId, questionId],
  );
  if (!result.rows[0]) throw new CurriculumDesignNotFoundError('题目不存在');
}

// ── Lab task CRUD ───────────────────────────────────────────────────────────

export async function createCurriculumLabTask(
  queryable: Queryable,
  ownerId: string,
  taskId: string,
  input: CurriculumLabTaskInput,
): Promise<CurriculumLabTaskRecord> {
  await assertPhase(queryable, ownerId, taskId, 'assessment');
  const unit = await readUnitRow(queryable, ownerId, input.unitId);
  if (!unit) throw new CurriculumDesignNotFoundError('大纲单元不存在');
  const objective = await readObjectiveRow(queryable, ownerId, input.objectiveId);
  if (!objective) throw new CurriculumDesignNotFoundError('学习目标不存在');
  if (unit.task_id !== taskId || objective.task_id !== taskId) {
    throw new CurriculumDesignValidationError('单元和学习目标必须属于同一个课程任务');
  }
  // The grading input, not the model's route through the task. A lab with no
  // rule is ungradable, and a lab graded by its reference path would mark
  // every correct alternative wrong.
  if (!Array.isArray(input.verifyRules) || input.verifyRules.length === 0) {
    throw new CurriculumDesignValidationError(
      '实操任务至少需要一条验证规则；参考解法不能作为验证规则',
    );
  }
  /**
   * Stated here rather than left to `curriculum_lab_exam_strict`.
   *
   * The constraint is still the backstop, but its message names the constraint:
   * a caller who picks "exam" and keeps the practice defaults is told that "a
   * rule on this field was not satisfied", which names none of the three things
   * to change. The rule is the same one; this is the version that says it.
   *
   * The values are the ones the insert would use, defaults included, so the
   * sentence describes the row that would have been written.
   */
  const examRefusal = examStrictRefusal({
    assessmentMode: input.assessmentMode ?? 'practice',
    hintPolicy: input.hintPolicy ?? 'unlimited',
    allowRetry: input.allowRetry ?? true,
    timeLimitSec: input.timeLimitSec ?? null,
  });
  if (examRefusal) throw new CurriculumDesignValidationError(examRefusal);

  const result = await queryable.query<LabTaskRow>(
    `INSERT INTO curriculum_lab_task
       (id, owner_id, task_id, unit_id, objective_id, evidence_id, assessment_mode, task_goal,
        brief, expected_result, docker_image, container_config, init_state, reset_policy,
        reference_solution, verify_rules, key_behaviors, final_state_rule, score_rules,
        scoring_mode, time_limit_sec, hint_policy, allow_retry, hint_ladder, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14,$15::jsonb,$16::jsonb,
             $17::jsonb,$18,$19::jsonb,$20,$21,$22,$23,$24::jsonb,$25)
     RETURNING ${LAB_TASK_COLUMNS}`,
    [
      createId('lab'),
      ownerId,
      taskId,
      input.unitId,
      input.objectiveId,
      input.evidenceId ?? null,
      input.assessmentMode ?? 'practice',
      requiredText(input.taskGoal, 'taskGoal'),
      optionalText(input.brief) ?? '',
      optionalText(input.expectedResult),
      requiredText(input.dockerImage, 'dockerImage'),
      jsonParam(input.containerConfig ?? {}),
      jsonParam(input.initState ?? {}),
      input.resetPolicy ?? 'on-demand',
      input.referenceSolution ? jsonParam(input.referenceSolution) : null,
      jsonParam(input.verifyRules),
      jsonParam(input.keyBehaviors ?? []),
      optionalText(input.finalStateRule),
      jsonParam(input.scoreRules ?? []),
      input.scoringMode ?? 'result',
      input.timeLimitSec ?? null,
      input.hintPolicy ?? 'unlimited',
      input.allowRetry ?? true,
      jsonParam(input.hintLadder ?? []),
      input.sortOrder ?? 0,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new CurriculumDesignValidationError('实操任务创建失败');
  return mapLabTask(row);
}

export async function updateCurriculumLabTask(
  queryable: Queryable,
  ownerId: string,
  labTaskId: string,
  patch: CurriculumLabTaskPatch,
): Promise<CurriculumLabTaskRecord> {
  const current = await queryable.query<LabTaskRow>(
    `SELECT ${LAB_TASK_COLUMNS} FROM curriculum_lab_task WHERE owner_id = $1 AND id = $2`,
    [ownerId, labTaskId],
  );
  const row = current.rows[0];
  if (!row) throw new CurriculumDesignNotFoundError('实操任务不存在');
  if (patch.verifyRules !== undefined && patch.verifyRules.length === 0) {
    throw new CurriculumDesignValidationError('实操任务必须保留至少一条验证规则');
  }
  /**
   * The exam rule is checked against the *resulting* row, not the patch.
   *
   * `curriculum_lab_exam_strict` is a row constraint, so a one-field patch can
   * break it — an update that sets `hintPolicy: 'unlimited'` on an existing exam
   * is the same defect as creating a warm exam, and checking only the fields
   * present in the patch would let it through to a raw constraint violation.
   */
  const examRefusal = examStrictRefusal({
    assessmentMode: patch.assessmentMode ?? (row.assessment_mode as CurriculumAssessmentMode),
    hintPolicy: patch.hintPolicy ?? (row.hint_policy as CurriculumHintPolicy),
    allowRetry: patch.allowRetry ?? row.allow_retry,
    timeLimitSec:
      patch.timeLimitSec !== undefined ? patch.timeLimitSec : nullableNumeric(row.time_limit_sec),
  });
  if (examRefusal) throw new CurriculumDesignValidationError(examRefusal);
  const result = await queryable.query<LabTaskRow>(
    `UPDATE curriculum_lab_task
        SET unit_id = $3, objective_id = $4, evidence_id = $5, assessment_mode = $6, task_goal = $7,
            brief = $8, expected_result = $9, docker_image = $10, container_config = $11::jsonb,
            init_state = $12::jsonb, reset_policy = $13, reference_solution = $14::jsonb,
            verify_rules = $15::jsonb, key_behaviors = $16::jsonb, final_state_rule = $17,
            score_rules = $18::jsonb, scoring_mode = $19, time_limit_sec = $20, hint_policy = $21,
            allow_retry = $22, hint_ladder = $23::jsonb, sort_order = $24, updated_at = now()
      WHERE owner_id = $1 AND id = $2
      RETURNING ${LAB_TASK_COLUMNS}`,
    [
      ownerId,
      labTaskId,
      patch.unitId ?? row.unit_id,
      patch.objectiveId ?? row.objective_id,
      patch.evidenceId !== undefined ? patch.evidenceId : row.evidence_id,
      patch.assessmentMode ?? (row.assessment_mode as CurriculumAssessmentMode),
      patch.taskGoal !== undefined ? requiredText(patch.taskGoal, 'taskGoal') : row.task_goal,
      patch.brief !== undefined ? (optionalText(patch.brief) ?? '') : row.brief,
      patch.expectedResult !== undefined ? optionalText(patch.expectedResult) : row.expected_result,
      patch.dockerImage !== undefined
        ? requiredText(patch.dockerImage, 'dockerImage')
        : row.docker_image,
      patch.containerConfig !== undefined
        ? jsonParam(patch.containerConfig)
        : jsonParam(jsonValue(row.container_config, {})),
      patch.initState !== undefined
        ? jsonParam(patch.initState)
        : jsonParam(jsonValue(row.init_state, {})),
      patch.resetPolicy ?? row.reset_policy,
      patch.referenceSolution !== undefined
        ? patch.referenceSolution
          ? jsonParam(patch.referenceSolution)
          : null
        : row.reference_solution
          ? jsonParam(jsonValue(row.reference_solution, []))
          : null,
      patch.verifyRules !== undefined
        ? jsonParam(patch.verifyRules)
        : jsonParam(jsonValue(row.verify_rules, [])),
      patch.keyBehaviors !== undefined
        ? jsonParam(patch.keyBehaviors)
        : jsonParam(jsonValue(row.key_behaviors, [])),
      patch.finalStateRule !== undefined
        ? optionalText(patch.finalStateRule)
        : row.final_state_rule,
      patch.scoreRules !== undefined
        ? jsonParam(patch.scoreRules)
        : jsonParam(jsonValue(row.score_rules, [])),
      patch.scoringMode ?? row.scoring_mode,
      patch.timeLimitSec !== undefined ? patch.timeLimitSec : nullableNumeric(row.time_limit_sec),
      patch.hintPolicy ?? (row.hint_policy as CurriculumHintPolicy),
      patch.allowRetry ?? row.allow_retry,
      patch.hintLadder !== undefined
        ? jsonParam(patch.hintLadder)
        : jsonParam(jsonValue(row.hint_ladder, [])),
      patch.sortOrder ?? numeric(row.sort_order),
    ],
  );
  const updated = result.rows[0];
  if (!updated) throw new CurriculumDesignNotFoundError('实操任务不存在');
  return mapLabTask(updated);
}

export async function deleteCurriculumLabTask(
  queryable: Queryable,
  ownerId: string,
  labTaskId: string,
): Promise<void> {
  const result = await queryable.query<{ id: string }>(
    'DELETE FROM curriculum_lab_task WHERE owner_id = $1 AND id = $2 RETURNING id',
    [ownerId, labTaskId],
  );
  if (!result.rows[0]) throw new CurriculumDesignNotFoundError('实操任务不存在');
}

// ── Audit findings ──────────────────────────────────────────────────────────

export async function replaceCurriculumAuditFindings(
  queryable: Queryable,
  ownerId: string,
  taskId: string,
  findings: CurriculumAuditFindingInput[],
): Promise<CurriculumAuditFindingRecord[]> {
  // A review re-runs; keeping resolved and waived findings would let a fixed
  // defect stay visible, and keeping open ones from a stale run would report
  // problems that no longer exist.
  await queryable.query(
    `DELETE FROM curriculum_audit_finding
      WHERE owner_id = $1 AND task_id = $2 AND status = 'open'`,
    [ownerId, taskId],
  );
  const created: CurriculumAuditFindingRecord[] = [];
  for (const finding of findings) {
    const result = await queryable.query<AuditFindingRow>(
      `INSERT INTO curriculum_audit_finding
         (id, owner_id, task_id, rule_code, severity, message, ref_kind, ref_id, ref_ids, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
       RETURNING ${AUDIT_FINDING_COLUMNS}`,
      [
        createId('finding'),
        ownerId,
        taskId,
        requiredText(finding.ruleCode, 'ruleCode'),
        finding.severity ?? 'warning',
        requiredText(finding.message, 'message'),
        optionalText(finding.refKind),
        optionalText(finding.refId),
        jsonParam(finding.refIds ?? []),
        finding.status ?? 'open',
      ],
    );
    const row = result.rows[0];
    if (row) created.push(mapAuditFinding(row));
  }
  return created;
}

export async function setCurriculumAuditFindingStatus(
  queryable: Queryable,
  ownerId: string,
  findingId: string,
  status: CurriculumAuditFindingStatus,
): Promise<CurriculumAuditFindingRecord> {
  const result = await queryable.query<AuditFindingRow>(
    `UPDATE curriculum_audit_finding SET status = $3, updated_at = now()
      WHERE owner_id = $1 AND id = $2
      RETURNING ${AUDIT_FINDING_COLUMNS}`,
    [ownerId, findingId, status],
  );
  const row = result.rows[0];
  if (!row) throw new CurriculumDesignNotFoundError('审核发现不存在');
  return mapAuditFinding(row);
}

// ── Snapshot ────────────────────────────────────────────────────────────────

/**
 * Everything one task's design is, in one payload. The workspace reads this
 * once and then answers both directions locally: outcome -> evidence ->
 * nodes -> items, and item -> outcomes -> prerequisites.
 */
export async function getCurriculumDesignSnapshot(
  queryable: Queryable,
  ownerId: string,
  taskId: string,
): Promise<CurriculumDesignSnapshot> {
  const task = await getCurriculumTask(queryable, ownerId, taskId);
  if (!task) throw new CurriculumDesignNotFoundError('课程任务不存在');

  const scoped = (table: string, columns: string, order: string) =>
    queryable.query<Row>(
      `SELECT ${columns} FROM ${table} WHERE owner_id = $1 AND task_id = $2 ORDER BY ${order}`,
      [ownerId, taskId],
    );

  const [objectiveResult, evidenceResult, nodeResult, nodeObjectiveResult, dependencyResult] =
    await Promise.all([
      scoped('curriculum_objective', OBJECTIVE_COLUMNS, 'sort_order, created_at'),
      scoped('curriculum_evidence', EVIDENCE_COLUMNS, 'sort_order, created_at'),
      scoped('curriculum_learning_node', NODE_COLUMNS, 'sort_order, created_at'),
      scoped('curriculum_node_objective', NODE_OBJECTIVE_COLUMNS, 'created_at'),
      scoped('curriculum_dependency', DEPENDENCY_COLUMNS, 'created_at'),
    ]);

  const unitResult = await queryable.query<UnitRow>(
    `SELECT ${UNIT_COLUMNS} FROM curriculum_unit
      WHERE owner_id = $1 AND task_id = $2
      ORDER BY order_index, created_at`,
    [ownerId, taskId],
  );

  const [coverageResult, unitDependencyResult, questionResult, labResult, findingResult] =
    await Promise.all([
      scoped('curriculum_unit_coverage', UNIT_COVERAGE_COLUMNS, 'unit_id, order_index, created_at'),
      scoped('curriculum_unit_dependency', UNIT_DEPENDENCY_COLUMNS, 'created_at'),
      scoped('curriculum_question', QUESTION_COLUMNS, 'sort_order, created_at'),
      scoped('curriculum_lab_task', LAB_TASK_COLUMNS, 'sort_order, created_at'),
      scoped('curriculum_audit_finding', AUDIT_FINDING_COLUMNS, 'created_at'),
    ]);

  return {
    task,
    confirmations: await listCurriculumDesignConfirmations(queryable, ownerId, taskId),
    objectives: objectiveResult.rows.map((row) => mapObjective(row as ObjectiveRow)),
    evidence: evidenceResult.rows.map((row) => mapEvidence(row as EvidenceRow)),
    nodes: nodeResult.rows.map((row) => mapNode(row as NodeRow)),
    nodeObjectives: nodeObjectiveResult.rows.map((row) =>
      mapNodeObjective(row as NodeObjectiveRow),
    ),
    dependencies: dependencyResult.rows.map((row) => mapDependency(row as DependencyRow)),
    units: unitResult.rows.map(mapUnit),
    unitCoverage: coverageResult.rows.map((row) => mapUnitCoverage(row as UnitCoverageRow)),
    unitDependencies: unitDependencyResult.rows.map((row) =>
      mapUnitDependency(row as UnitDependencyRow),
    ),
    questions: questionResult.rows.map((row) => mapQuestion(row as QuestionRow)),
    labTasks: labResult.rows.map((row) => mapLabTask(row as LabTaskRow)),
    auditFindings: findingResult.rows.map((row) => mapAuditFinding(row as AuditFindingRow)),
  };
}

// ── Review ───────────────────────────────────────────────────────────────────

export interface CurriculumDesignEvaluation {
  /** The audit's verdict, before persistence — derived, not stored rows. */
  findings: CurriculumAuditFinding[];
  quality: ReturnType<typeof evaluateCurriculumQuality>;
  coverage: ReturnType<typeof buildDesignCoverage>;
  verdict: ReturnType<typeof summariseCoverage>;
  /** Whether the design may be handed to generation and export. */
  exportable: boolean;
}

export interface CurriculumDesignReview extends Omit<CurriculumDesignEvaluation, 'findings'> {
  findings: CurriculumAuditFindingRecord[];
}

/**
 * The whole review, computed from a snapshot and touching nothing.
 *
 * Split out from the persisting wrapper so a read can ask "would this export?"
 * without writing: a GET that records findings would make every prefetch and
 * retry a mutation, and the answer would then depend on who asked last.
 */
export function evaluateCurriculumDesign(
  snapshot: CurriculumDesignSnapshot,
): CurriculumDesignEvaluation {
  const findings = auditCurriculumDesign(snapshot);
  const quality = evaluateCurriculumQuality(findings);
  const coverage = buildDesignCoverage(snapshot);
  const verdict = summariseCoverage(coverage);
  return {
    findings,
    quality,
    coverage,
    verdict,
    exportable: quality.exportable && verdict.complete,
  };
}

/**
 * Why a design cannot be produced, in the order the layers are checked.
 *
 * Reporting the FIRST broken layer rather than all of them is deliberate:
 * fixing a later layer while an earlier one is still broken produces coverage
 * that points at the wrong thing. The list is empty exactly when the design is
 * exportable.
 */
export function describeCurriculumExportBlockers(
  evaluation: Pick<CurriculumDesignEvaluation, 'quality' | 'verdict'>,
): string[] {
  const parts: string[] = [];
  if (!evaluation.quality.exportable) {
    // The label, not the identifier: this line is the only explanation the
    // author gets for why the course cannot be produced, and `outcomes_verifiable`
    // is not a thing a teacher can act on.
    const layer = evaluation.quality.firstBrokenLayer;
    parts.push(
      layer === null
        ? '设计审核未通过'
        : `设计审核未通过：卡在「${curriculumQualityLayerLabel(layer)}」层`,
    );
  }
  if (!evaluation.verdict.complete) {
    parts.push(evaluation.verdict.summary);
  }
  return parts;
}

/**
 * Run the full design review for one task and persist the findings.
 *
 * The audit is pure, so it runs over a snapshot that was already read; this
 * wrapper adds the two things a pure function cannot do — persist the result
 * so the workspace can show it, and fold the coverage verdict in so callers
 * get the loop state without a second query.
 *
 * Persisting is a replace, not an append: a review re-runs after an edit, and
 * carrying a fixed defect forward as `open` would report problems that no
 * longer exist. Resolved and waived findings survive so a decision to accept a
 * known gap is not silently erased by the next review.
 */
export async function reviewCurriculumTaskDesign(
  queryable: Queryable,
  ownerId: string,
  taskId: string,
): Promise<CurriculumDesignReview> {
  const snapshot = await getCurriculumDesignSnapshot(queryable, ownerId, taskId);
  const evaluation = evaluateCurriculumDesign(snapshot);

  const persisted = await replaceCurriculumAuditFindings(
    queryable,
    ownerId,
    taskId,
    evaluation.findings.map((finding) => ({
      ruleCode: finding.rule,
      severity: finding.severity,
      message: finding.message,
      refKind: finding.refKind,
      refId: finding.refId,
      refIds: finding.refIds,
      status: 'open' as const,
    })),
  );

  return { ...evaluation, findings: persisted };
}

/**
 * The gate that generation and export must pass.
 *
 * It re-reads the snapshot rather than trusting a previously stored review,
 * because the design can change after a review and a stale "pass" would let an
 * unclosed loop into production. Throwing rather than returning a boolean keeps
 * the check impossible to forget at a call site that ignores the result.
 */
export async function assertCurriculumDesignExportable(
  queryable: Queryable,
  ownerId: string,
  taskId: string,
): Promise<CurriculumDesignReview> {
  const review = await reviewCurriculumTaskDesign(queryable, ownerId, taskId);
  const blockers = describeCurriculumExportBlockers(review);
  if (blockers.length === 0) return review;
  throw new CurriculumDesignValidationError(`这门课程目前还不能生成：${blockers.join('；')}。`);
}
