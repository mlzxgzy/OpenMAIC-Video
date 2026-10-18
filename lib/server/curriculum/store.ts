/**
 * The course-ledger store: owner-scoped CRUD over the curriculum tables
 * (`lib/persistence/curriculum.ts`). The schema is provisioned lazily, under
 * the shared bootstrap lock, on the first call into this module.
 *
 * The handler layer owns request identity and write fencing
 * (`withRequestOwner` + `fenceOwnerWrite`). These functions only ever act for
 * the `ownerId` they are given.
 */
import { randomBytes } from 'node:crypto';

import type { Queryable } from '@openmaic/storage/document/pg';
import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

import type { ProgramPlanExportCourse, ProgramPlanExportFile } from '@/lib/curriculum/program-io';
import { ensureCurriculumSchema } from '@/lib/persistence/curriculum';
import { withSchemaBootstrapLock } from '@/lib/persistence/schema-bootstrap-lock';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import type {
  CourseIndicatorSupportRecord,
  CourseKnowledgeCoverageLevel,
  CourseKnowledgePointRecord,
  CurriculumBatchItemRecord,
  CurriculumBatchItemStatus,
  CurriculumBatchRecord,
  CurriculumBatchStatus,
  CurriculumCourseRecord,
  CurriculumCourseStatus,
  CurriculumExportJobError,
  CurriculumExportJobRecord,
  CurriculumExportJobStatus,
  CurriculumGenerationJobError,
  CurriculumGenerationJobRecord,
  CurriculumGenerationJobStatus,
  CurriculumGenerationOutlineReview,
  CurriculumGraduationIndicatorRecord,
  CurriculumOutlineNodeType,
  CurriculumProgramCourseCategory,
  CurriculumProgramCourseRecord,
  CurriculumProgramRecord,
  CurriculumProgramStatus,
  CurriculumProgramVersionRecord,
  CurriculumRelationRecord,
  CurriculumRelationType,
  CurriculumSeriesOutlineNodeRecord,
  CurriculumSeriesRecord,
  CurriculumSnapshot,
  KnowledgePointDifficulty,
  KnowledgePointRecord,
  KnowledgePointRelationRecord,
  KnowledgePointRelationType,
  KnowledgePointType,
} from '@/lib/curriculum/types';

export interface CurriculumSeriesInput {
  name: string;
  description?: string | null;
  /** 系列级默认培训对象，目在创建时继承。 */
  audience?: string | null;
  /** 系列级默认学时，目在创建时继承。 */
  defaultHours?: number | null;
}

export interface CurriculumSeriesPatch {
  name?: string;
  description?: string | null;
  audience?: string | null;
  defaultHours?: number | null;
}

export interface CurriculumCourseInput {
  seriesId?: string | null;
  stageId?: string | null;
  title: string;
  code?: string | null;
  description?: string | null;
  chapter?: string | null;
  section?: string | null;
  lessonOrder?: number;
  credits?: number | null;
  hours?: number | null;
  semester?: string | null;
  status?: CurriculumCourseStatus;
}

export type CurriculumCoursePatch = Partial<CurriculumCourseInput>;

export interface CurriculumRelationInput {
  sourceCourseId: string;
  targetCourseId: string;
  relationType: CurriculumRelationType;
  note?: string | null;
}

export interface KnowledgePointInput {
  seriesId?: string | null;
  parentId?: string | null;
  name: string;
  code?: string | null;
  type?: KnowledgePointType;
  difficulty?: KnowledgePointDifficulty | null;
  summary?: string | null;
  sortOrder?: number;
}

export type KnowledgePointPatch = Partial<KnowledgePointInput>;

export interface CourseKnowledgePointInput {
  knowledgePointId: string;
  coverageLevel?: CourseKnowledgeCoverageLevel;
  sortOrder?: number;
  note?: string | null;
}

export interface KnowledgePointRelationInput {
  sourceKnowledgePointId: string;
  targetKnowledgePointId: string;
  relationType: KnowledgePointRelationType;
  note?: string | null;
}

export interface CurriculumGenerationJobInput {
  courseId: string;
  outlineReview: CurriculumGenerationOutlineReview;
  request?: Record<string, unknown>;
}

export interface CurriculumBatchItemInput {
  title: string;
  courseId?: string | null;
  request: Record<string, unknown>;
  maxAttempts?: number;
}

export interface CurriculumBatchInput {
  name: string;
  items: CurriculumBatchItemInput[];
}

export interface CurriculumExportJobOptions {
  resolution: '720p' | '1080p' | '4k';
  fps: number;
  quality: 'draft' | 'standard' | 'high';
  burnInSubtitles: boolean;
}

export interface CurriculumExportJobsInput extends CurriculumExportJobOptions {
  batchId?: string;
  batchItemIds: string[];
  /**
   * 直接按 stage 排队（目工作台的出片面板）。
   *
   * `batchItemIds` 那条路要求课程先经过"批量项"，而设计驱动的那条路（设计 →
   * 生成 → 课堂）没有批量项。两条路产出的都是同一个课程文档，所以导出这里
   * 允许以 stage 为单位入队，落库时 `batch_item_id` 为 NULL。
   */
  stageIds?: string[];
  /** 下载文件名用的展示名；不传就是「课堂」。 */
  stageTitle?: string;
}

export type CurriculumExportJobAction =
  | { action: 'attach-render'; renderJobId: string }
  | { action: 'progress'; progress: number }
  | { action: 'complete' }
  | { action: 'fail'; error: CurriculumExportJobError }
  | { action: 'retry' }
  | { action: 'cancel' };

export class CurriculumNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CurriculumNotFoundError';
  }
}

export class CurriculumValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CurriculumValidationError';
  }
}

export class CurriculumConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CurriculumConflictError';
  }
}

interface SeriesRow extends Record<string, unknown> {
  id: string;
  name: string;
  description: string | null;
  audience: string | null;
  default_hours: number | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface OutlineNodeRow extends Record<string, unknown> {
  id: string;
  series_id: string;
  parent_id: string | null;
  node_type: string;
  code: string | null;
  title: string;
  note: string | null;
  order_index: number | string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface CourseRow extends Record<string, unknown> {
  id: string;
  series_id: string | null;
  stage_id: string | null;
  title: string;
  code: string | null;
  description: string | null;
  chapter: string | null;
  section: string | null;
  lesson_order: number | string;
  credits: number | string | null;
  hours: number | string | null;
  semester: string | null;
  status: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface RelationRow extends Record<string, unknown> {
  id: string;
  source_course_id: string;
  target_course_id: string;
  relation_type: string;
  note: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface KnowledgePointRow extends Record<string, unknown> {
  id: string;
  series_id: string | null;
  parent_id: string | null;
  name: string;
  code: string | null;
  type: string;
  difficulty: string | null;
  summary: string | null;
  sort_order: number | string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface CourseKnowledgePointRow extends Record<string, unknown> {
  course_id: string;
  knowledge_point_id: string;
  coverage_level: string;
  sort_order: number | string;
  note: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface KnowledgePointRelationRow extends Record<string, unknown> {
  id: string;
  source_knowledge_point_id: string;
  target_knowledge_point_id: string;
  relation_type: string;
  note: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface GenerationJobRow extends Record<string, unknown> {
  id: string;
  course_id: string;
  run_id: string | null;
  stage_id: string | null;
  status: string;
  outline_review: string;
  error: Record<string, unknown> | null;
  started_at: Date | string | null;
  completed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface BatchRow extends Record<string, unknown> {
  id: string;
  name: string;
  status: string;
  started_at: Date | string | null;
  completed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface BatchItemRow extends Record<string, unknown> {
  id: string;
  batch_id: string;
  position: number | string;
  course_id: string | null;
  title: string;
  status: string;
  attempts: number | string;
  max_attempts: number | string;
  request: Record<string, unknown>;
  generation_job_id: string | null;
  run_id: string | null;
  stage_id: string | null;
  error: Record<string, unknown> | null;
  started_at: Date | string | null;
  completed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ExportCandidateRow extends Record<string, unknown> {
  batch_item_id: string;
  course_id: string | null;
  title: string;
  stage_id: string;
  course_title: string | null;
}

interface ExportJobRow extends Record<string, unknown> {
  id: string;
  course_id: string | null;
  batch_item_id: string | null;
  stage_id: string;
  title: string;
  status: string;
  resolution: string;
  fps: number | string;
  quality: string;
  burn_in_subtitles: boolean;
  progress: number | string;
  render_job_id: string | null;
  attempts: number | string;
  error: Record<string, unknown> | null;
  started_at: Date | string | null;
  completed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const SERIES_COLUMNS = `id, name, description, audience, default_hours, created_at, updated_at`;

const OUTLINE_NODE_COLUMNS = `id, series_id, parent_id, node_type, code, title, note,
       order_index, created_at, updated_at`;

const COURSE_COLUMNS = `id, series_id, stage_id, title, code, description, chapter, section,
       lesson_order, credits, hours, semester, status, created_at, updated_at`;

const RELATION_COLUMNS = `id, source_course_id, target_course_id, relation_type, note,
       created_at, updated_at`;

const KNOWLEDGE_POINT_COLUMNS = `id, series_id, parent_id, name, code, type, difficulty,
       summary, sort_order, created_at, updated_at`;

const COURSE_KNOWLEDGE_POINT_COLUMNS = `course_id, knowledge_point_id, coverage_level,
       sort_order, note, created_at, updated_at`;

const KNOWLEDGE_POINT_RELATION_COLUMNS = `id, source_knowledge_point_id, target_knowledge_point_id,
       relation_type, note, created_at, updated_at`;

const GENERATION_JOB_COLUMNS = `id, course_id, run_id, stage_id, status, outline_review,
       error, started_at, completed_at, created_at, updated_at`;

const BATCH_COLUMNS = `id, name, status, started_at, completed_at, created_at, updated_at`;

const BATCH_ITEM_COLUMNS = `id, batch_id, position, course_id, title, status, attempts, max_attempts,
       request, generation_job_id, run_id, stage_id, error, started_at, completed_at,
       created_at, updated_at`;

const EXPORT_JOB_COLUMNS = `id, course_id, batch_item_id, stage_id, title, status, resolution,
       fps, quality, burn_in_subtitles, progress, render_job_id, attempts, error,
       started_at, completed_at, created_at, updated_at`;

const EXPORT_JOB_RETURNING = `job.id, job.course_id, job.batch_item_id, job.stage_id, job.title,
       job.status, job.resolution, job.fps, job.quality, job.burn_in_subtitles, job.progress,
       job.render_job_id, job.attempts, job.error, job.started_at, job.completed_at,
       job.created_at, job.updated_at`;

const SCHEMA_STATE_KEY = Symbol.for('openmaic.curriculum.schema');
const schemaState = globalThis as typeof globalThis & {
  [SCHEMA_STATE_KEY]?: { connectionString: string; ready: Promise<void> };
};

/**
 * The persistence provider with the curriculum schema ensured once per
 * connection string in this process.
 */
export async function getCurriculumProvider() {
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

/** Test seam: forget the provisioned schema after a test drops it. */
export function resetCurriculumSchemaForTests(): void {
  delete schemaState[SCHEMA_STATE_KEY];
}

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
  return value === null ? null : numeric(value);
}

function mapSeries(row: SeriesRow, courseCount: number): CurriculumSeriesRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    audience: row.audience,
    defaultHours: nullableNumeric(row.default_hours),
    courseCount,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapOutlineNode(row: OutlineNodeRow): CurriculumSeriesOutlineNodeRecord {
  return {
    id: row.id,
    seriesId: row.series_id,
    parentId: row.parent_id,
    nodeType: row.node_type as CurriculumOutlineNodeType,
    code: row.code,
    title: row.title,
    note: row.note,
    orderIndex: numeric(row.order_index),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapCourse(row: CourseRow): CurriculumCourseRecord {
  return {
    id: row.id,
    seriesId: row.series_id,
    stageId: row.stage_id,
    title: row.title,
    code: row.code,
    description: row.description,
    chapter: row.chapter,
    section: row.section,
    lessonOrder: numeric(row.lesson_order),
    credits: nullableNumeric(row.credits),
    hours: nullableNumeric(row.hours),
    semester: row.semester,
    status: row.status as CurriculumCourseStatus,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapRelation(row: RelationRow): CurriculumRelationRecord {
  return {
    id: row.id,
    sourceCourseId: row.source_course_id,
    targetCourseId: row.target_course_id,
    relationType: row.relation_type as CurriculumRelationType,
    note: row.note,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapKnowledgePoint(row: KnowledgePointRow): KnowledgePointRecord {
  return {
    id: row.id,
    seriesId: row.series_id,
    parentId: row.parent_id,
    name: row.name,
    code: row.code,
    type: row.type as KnowledgePointType,
    difficulty: row.difficulty as KnowledgePointDifficulty | null,
    summary: row.summary,
    sortOrder: numeric(row.sort_order),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapCourseKnowledgePoint(row: CourseKnowledgePointRow): CourseKnowledgePointRecord {
  return {
    courseId: row.course_id,
    knowledgePointId: row.knowledge_point_id,
    coverageLevel: row.coverage_level as CourseKnowledgeCoverageLevel,
    sortOrder: numeric(row.sort_order),
    note: row.note,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapKnowledgePointRelation(row: KnowledgePointRelationRow): KnowledgePointRelationRecord {
  return {
    id: row.id,
    sourceKnowledgePointId: row.source_knowledge_point_id,
    targetKnowledgePointId: row.target_knowledge_point_id,
    relationType: row.relation_type as KnowledgePointRelationType,
    note: row.note,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function nullableIso(value: Date | string | null): string | null {
  return value === null ? null : iso(value);
}

function mapGenerationJob(row: GenerationJobRow): CurriculumGenerationJobRecord {
  const error = row.error;
  return {
    id: row.id,
    courseId: row.course_id,
    runId: row.run_id,
    stageId: row.stage_id,
    status: row.status as CurriculumGenerationJobStatus,
    outlineReview: row.outline_review as CurriculumGenerationOutlineReview,
    error:
      error && typeof error.code === 'string'
        ? {
            code: error.code,
            ...(typeof error.message === 'string' ? { message: error.message } : {}),
            ...(typeof error.step === 'string' || error.step === null
              ? { step: error.step as string | null }
              : {}),
          }
        : null,
    startedAt: nullableIso(row.started_at),
    completedAt: nullableIso(row.completed_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapBatch(row: BatchRow): CurriculumBatchRecord {
  return {
    id: row.id,
    name: row.name,
    status: row.status as CurriculumBatchStatus,
    startedAt: nullableIso(row.started_at),
    completedAt: nullableIso(row.completed_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapBatchItem(row: BatchItemRow): CurriculumBatchItemRecord {
  const error = row.error;
  return {
    id: row.id,
    batchId: row.batch_id,
    position: numeric(row.position),
    courseId: row.course_id,
    title: row.title,
    status: row.status as CurriculumBatchItemStatus,
    attempts: numeric(row.attempts),
    maxAttempts: numeric(row.max_attempts),
    generationJobId: row.generation_job_id,
    runId: row.run_id,
    stageId: row.stage_id,
    error:
      error && typeof error.code === 'string'
        ? {
            code: error.code,
            ...(typeof error.message === 'string' ? { message: error.message } : {}),
            ...(typeof error.step === 'string' || error.step === null
              ? { step: error.step as string | null }
              : {}),
          }
        : null,
    startedAt: nullableIso(row.started_at),
    completedAt: nullableIso(row.completed_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapExportJob(row: ExportJobRow): CurriculumExportJobRecord {
  const error = row.error;
  return {
    id: row.id,
    courseId: row.course_id,
    batchItemId: row.batch_item_id,
    stageId: row.stage_id,
    title: row.title,
    status: row.status as CurriculumExportJobStatus,
    resolution: row.resolution,
    fps: numeric(row.fps),
    quality: row.quality,
    burnInSubtitles: row.burn_in_subtitles === true,
    progress: Number(row.progress) || 0,
    renderJobId: row.render_job_id,
    attempts: numeric(row.attempts),
    error:
      error && typeof error.code === 'string'
        ? {
            code: error.code,
            ...(typeof error.message === 'string' ? { message: error.message } : {}),
          }
        : null,
    startedAt: nullableIso(row.started_at),
    completedAt: nullableIso(row.completed_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function optionalText(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function readCourseRow(
  queryable: Queryable,
  ownerId: string,
  courseId: string,
): Promise<CourseRow | null> {
  const result = await queryable.query<CourseRow>(
    `SELECT ${COURSE_COLUMNS}
       FROM curriculum_course
      WHERE owner_id = $1 AND id = $2`,
    [ownerId, courseId],
  );
  return result.rows[0] ?? null;
}

async function readKnowledgePointRow(
  queryable: Queryable,
  ownerId: string,
  knowledgePointId: string,
): Promise<KnowledgePointRow | null> {
  const result = await queryable.query<KnowledgePointRow>(
    `SELECT ${KNOWLEDGE_POINT_COLUMNS}
       FROM curriculum_knowledge_point
      WHERE owner_id = $1 AND id = $2`,
    [ownerId, knowledgePointId],
  );
  return result.rows[0] ?? null;
}

async function readSeriesRow(
  queryable: Queryable,
  ownerId: string,
  seriesId: string,
): Promise<SeriesRow | null> {
  const result = await queryable.query<SeriesRow>(
    `SELECT ${SERIES_COLUMNS}
       FROM curriculum_series
      WHERE owner_id = $1 AND id = $2`,
    [ownerId, seriesId],
  );
  return result.rows[0] ?? null;
}

/**
 * One owned series, including the defaults a 目 inherits on creation.
 *
 * The cockpit needs the defaults even when the series has no course rows yet —
 * which is exactly the state a brand-new series is in — so it cannot come from
 * the course-ledger snapshot, which is empty until there is a product to list.
 */
export async function getCurriculumSeries(
  queryable: Queryable,
  ownerId: string,
  seriesId: string,
): Promise<CurriculumSeriesRecord | null> {
  const row = await readSeriesRow(queryable, ownerId, seriesId);
  return row ? mapSeries(row, 0) : null;
}

async function assertSeriesOwned(
  queryable: Queryable,
  ownerId: string,
  seriesId: string | null | undefined,
): Promise<void> {
  if (!seriesId) return;
  const result = await queryable.query<{ id: string } & Record<string, unknown>>(
    'SELECT id FROM curriculum_series WHERE owner_id = $1 AND id = $2',
    [ownerId, seriesId],
  );
  if (!result.rows[0]) throw new CurriculumNotFoundError('课程系列不存在');
}

async function assertCourseOwned(
  queryable: Queryable,
  ownerId: string,
  courseId: string,
): Promise<void> {
  const row = await readCourseRow(queryable, ownerId, courseId);
  if (!row) throw new CurriculumNotFoundError('课程不存在');
}

async function assertKnowledgePointOwned(
  queryable: Queryable,
  ownerId: string,
  knowledgePointId: string,
): Promise<void> {
  const row = await readKnowledgePointRow(queryable, ownerId, knowledgePointId);
  if (!row) throw new CurriculumNotFoundError('知识点不存在');
}

/**
 * A knowledge point can nest to form a tree. The parent must belong to the
 * same owner, and setting a parent that is already a descendant of this point
 * would create a cycle.
 */
async function assertKnowledgePointParent(
  queryable: Queryable,
  ownerId: string,
  knowledgePointId: string | null,
  parentId: string | null,
): Promise<void> {
  if (!parentId) return;
  if (knowledgePointId && knowledgePointId === parentId) {
    throw new CurriculumValidationError('知识点不能作为自己的父级');
  }
  await assertKnowledgePointOwned(queryable, ownerId, parentId);
  if (!knowledgePointId) return;

  const result = await queryable.query<{ id: string } & Record<string, unknown>>(
    `WITH RECURSIVE descendants AS (
       SELECT id, parent_id
         FROM curriculum_knowledge_point
        WHERE owner_id = $1 AND parent_id = $2
       UNION ALL
       SELECT child.id, child.parent_id
         FROM curriculum_knowledge_point child
         JOIN descendants parent ON child.parent_id = parent.id
        WHERE child.owner_id = $1
     )
     SELECT id FROM descendants WHERE id = $3 LIMIT 1`,
    [ownerId, knowledgePointId, parentId],
  );
  if (result.rows[0]) {
    throw new CurriculumValidationError('知识点父级会形成环');
  }
}

const DIRECTED_KNOWLEDGE_POINT_RELATION_TYPES: readonly KnowledgePointRelationType[] = [
  'prerequisite',
  'follow-up',
  'contains',
];

/**
 * Directed knowledge relations must stay acyclic. The check asks whether the
 * new target can already reach the new source following the same relation
 * type: if it can, adding source -> target would close a cycle.
 */
async function assertKnowledgePointRelationAcyclic(
  queryable: Queryable,
  ownerId: string,
  sourceKnowledgePointId: string,
  targetKnowledgePointId: string,
  relationType: KnowledgePointRelationType,
): Promise<void> {
  if (!DIRECTED_KNOWLEDGE_POINT_RELATION_TYPES.includes(relationType)) return;
  const result = await queryable.query<{ id: string } & Record<string, unknown>>(
    `WITH RECURSIVE reachable AS (
       SELECT target_knowledge_point_id AS id
         FROM curriculum_knowledge_point_relation
        WHERE owner_id = $1
          AND source_knowledge_point_id = $2
          AND relation_type = $3
       UNION
       SELECT relation.target_knowledge_point_id
         FROM curriculum_knowledge_point_relation relation
         JOIN reachable ON relation.source_knowledge_point_id = reachable.id
        WHERE relation.owner_id = $1
          AND relation.relation_type = $3
     )
     SELECT id FROM reachable WHERE id = $4 LIMIT 1`,
    [ownerId, targetKnowledgePointId, relationType, sourceKnowledgePointId],
  );
  if (result.rows[0]) {
    throw new CurriculumValidationError('知识点关系会形成环');
  }
}

/** Every series, course, relation, knowledge point and course-point link of one owner. */
export async function listCurriculum(
  queryable: Queryable,
  ownerId: string,
): Promise<CurriculumSnapshot> {
  const [
    seriesResult,
    courseResult,
    relationResult,
    knowledgeResult,
    courseKnowledgeResult,
    knowledgeRelationResult,
    generationJobResult,
    batchResult,
    batchItemResult,
    exportJobResult,
    programResult,
    programVersionResult,
    graduationIndicatorResult,
    programCourseResult,
    courseIndicatorSupportResult,
  ] = await Promise.all([
    queryable.query<SeriesRow>(
      `SELECT ${SERIES_COLUMNS}
         FROM curriculum_series
        WHERE owner_id = $1
        ORDER BY lower(name), created_at`,
      [ownerId],
    ),
    queryable.query<CourseRow>(
      `SELECT ${COURSE_COLUMNS}
         FROM curriculum_course
        WHERE owner_id = $1
        ORDER BY COALESCE(series_id, ''), lesson_order, lower(title), created_at`,
      [ownerId],
    ),
    queryable.query<RelationRow>(
      `SELECT ${RELATION_COLUMNS}
         FROM curriculum_course_relation
        WHERE owner_id = $1
        ORDER BY created_at`,
      [ownerId],
    ),
    queryable.query<KnowledgePointRow>(
      `SELECT ${KNOWLEDGE_POINT_COLUMNS}
         FROM curriculum_knowledge_point
        WHERE owner_id = $1
        ORDER BY COALESCE(series_id, ''), sort_order, lower(name), created_at`,
      [ownerId],
    ),
    queryable.query<CourseKnowledgePointRow>(
      `SELECT ${COURSE_KNOWLEDGE_POINT_COLUMNS}
         FROM curriculum_course_knowledge_point
        WHERE owner_id = $1
        ORDER BY course_id, sort_order, created_at`,
      [ownerId],
    ),
    queryable.query<KnowledgePointRelationRow>(
      `SELECT ${KNOWLEDGE_POINT_RELATION_COLUMNS}
         FROM curriculum_knowledge_point_relation
        WHERE owner_id = $1
        ORDER BY created_at`,
      [ownerId],
    ),
    queryable.query<GenerationJobRow>(
      `SELECT ${GENERATION_JOB_COLUMNS}
         FROM curriculum_generation_job
        WHERE owner_id = $1
        ORDER BY created_at DESC`,
      [ownerId],
    ),
    queryable.query<BatchRow>(
      `SELECT ${BATCH_COLUMNS}
         FROM curriculum_batch
        WHERE owner_id = $1
        ORDER BY created_at DESC`,
      [ownerId],
    ),
    queryable.query<BatchItemRow>(
      `SELECT ${BATCH_ITEM_COLUMNS}
         FROM curriculum_batch_item
        WHERE owner_id = $1
        ORDER BY batch_id, position`,
      [ownerId],
    ),
    queryable.query<ExportJobRow>(
      `SELECT ${EXPORT_JOB_COLUMNS}
         FROM curriculum_export_job
        WHERE owner_id = $1
        ORDER BY created_at DESC`,
      [ownerId],
    ),
    queryable.query<ProgramRow>(
      `SELECT ${PROGRAM_COLUMNS}
         FROM curriculum_program
        WHERE owner_id = $1
        ORDER BY lower(name), created_at`,
      [ownerId],
    ),
    queryable.query<ProgramVersionRow>(
      `SELECT ${PROGRAM_VERSION_COLUMNS}
         FROM curriculum_program_version
        WHERE owner_id = $1
        ORDER BY COALESCE(program_id, ''), created_at`,
      [ownerId],
    ),
    queryable.query<GraduationIndicatorRow>(
      `SELECT ${GRADUATION_INDICATOR_COLUMNS}
         FROM curriculum_graduation_indicator
        WHERE owner_id = $1
        ORDER BY program_version_id, sort_order, lower(code), created_at`,
      [ownerId],
    ),
    queryable.query<ProgramCourseRow>(
      `SELECT ${PROGRAM_COURSE_COLUMNS}
         FROM curriculum_program_course
        WHERE owner_id = $1
        ORDER BY program_version_id, sort_order, created_at`,
      [ownerId],
    ),
    queryable.query<CourseIndicatorSupportRow>(
      `SELECT ${COURSE_INDICATOR_SUPPORT_COLUMNS}
         FROM curriculum_course_indicator_support
        WHERE owner_id = $1
        ORDER BY program_version_id, program_course_id, indicator_id`,
      [ownerId],
    ),
  ]);

  const courses = courseResult.rows.map(mapCourse);
  const courseCounts = new Map<string, number>();
  for (const course of courses) {
    if (course.seriesId)
      courseCounts.set(course.seriesId, (courseCounts.get(course.seriesId) ?? 0) + 1);
  }

  return {
    series: seriesResult.rows.map((row) => mapSeries(row, courseCounts.get(row.id) ?? 0)),
    courses,
    relations: relationResult.rows.map(mapRelation),
    knowledgePoints: knowledgeResult.rows.map(mapKnowledgePoint),
    courseKnowledgePoints: courseKnowledgeResult.rows.map(mapCourseKnowledgePoint),
    knowledgePointRelations: knowledgeRelationResult.rows.map(mapKnowledgePointRelation),
    generationJobs: generationJobResult.rows.map(mapGenerationJob),
    batches: batchResult.rows.map(mapBatch),
    batchItems: batchItemResult.rows.map(mapBatchItem),
    exportJobs: exportJobResult.rows.map(mapExportJob),
    programs: programResult.rows.map(mapProgram),
    programVersions: programVersionResult.rows.map(mapProgramVersion),
    graduationIndicators: graduationIndicatorResult.rows.map(mapGraduationIndicator),
    programCourses: programCourseResult.rows.map(mapProgramCourse),
    courseIndicatorSupports: courseIndicatorSupportResult.rows.map(mapCourseIndicatorSupport),
  };
}

/**
 * Focused snapshot for one course product page.
 *
 * The page still needs every series and course for its selects and relation
 * editor, plus all knowledge points of the course's series for binding. It does
 * not need other courses' links, other owners' data, the program-plan layer or
 * the full batch/export history, so this query set keeps the payload small and
 * the detail route from scanning the whole ledger.
 */
export async function getCurriculumCourseDetail(
  queryable: Queryable,
  ownerId: string,
  courseId: string,
): Promise<CurriculumSnapshot> {
  const courseResult = await queryable.query<CourseRow>(
    `SELECT ${COURSE_COLUMNS}
       FROM curriculum_course
      WHERE owner_id = $1
        AND id = $2`,
    [ownerId, courseId],
  );
  const courseRow = courseResult.rows[0];
  if (!courseRow) throw new CurriculumNotFoundError('课程不存在');
  const course = mapCourse(courseRow);

  const knowledgePointQuery = course.seriesId
    ? queryable.query<KnowledgePointRow>(
        `SELECT ${KNOWLEDGE_POINT_COLUMNS}
           FROM curriculum_knowledge_point
          WHERE owner_id = $1
            AND series_id = $2
          ORDER BY sort_order, lower(name), created_at`,
        [ownerId, course.seriesId],
      )
    : queryable.query<KnowledgePointRow>(
        `SELECT ${KNOWLEDGE_POINT_COLUMNS}
           FROM curriculum_knowledge_point
          WHERE owner_id = $1
          ORDER BY COALESCE(series_id, ''), sort_order, lower(name), created_at`,
        [ownerId],
      );

  const [
    seriesResult,
    allCoursesResult,
    relationResult,
    knowledgeResult,
    courseKnowledgeResult,
    generationJobResult,
    batchItemResult,
    exportJobResult,
  ] = await Promise.all([
    queryable.query<SeriesRow>(
      `SELECT ${SERIES_COLUMNS}
         FROM curriculum_series
        WHERE owner_id = $1
        ORDER BY lower(name), created_at`,
      [ownerId],
    ),
    queryable.query<CourseRow>(
      `SELECT ${COURSE_COLUMNS}
         FROM curriculum_course
        WHERE owner_id = $1
        ORDER BY COALESCE(series_id, ''), lesson_order, lower(title), created_at`,
      [ownerId],
    ),
    queryable.query<RelationRow>(
      `SELECT ${RELATION_COLUMNS}
         FROM curriculum_course_relation
        WHERE owner_id = $1
          AND (source_course_id = $2 OR target_course_id = $2)
        ORDER BY created_at`,
      [ownerId, courseId],
    ),
    knowledgePointQuery,
    queryable.query<CourseKnowledgePointRow>(
      `SELECT ${COURSE_KNOWLEDGE_POINT_COLUMNS}
         FROM curriculum_course_knowledge_point
        WHERE owner_id = $1
          AND course_id = $2
        ORDER BY sort_order, created_at`,
      [ownerId, courseId],
    ),
    queryable.query<GenerationJobRow>(
      `SELECT ${GENERATION_JOB_COLUMNS}
         FROM curriculum_generation_job
        WHERE owner_id = $1
          AND course_id = $2
        ORDER BY created_at DESC`,
      [ownerId, courseId],
    ),
    queryable.query<BatchItemRow>(
      `SELECT ${BATCH_ITEM_COLUMNS}
         FROM curriculum_batch_item
        WHERE owner_id = $1
          AND course_id = $2
        ORDER BY created_at DESC`,
      [ownerId, courseId],
    ),
    queryable.query<ExportJobRow>(
      `SELECT ${EXPORT_JOB_COLUMNS}
         FROM curriculum_export_job
        WHERE owner_id = $1
          AND course_id = $2
        ORDER BY created_at DESC`,
      [ownerId, courseId],
    ),
  ]);

  const courses = allCoursesResult.rows.map(mapCourse);
  const courseCounts = new Map<string, number>();
  for (const candidate of courses) {
    if (candidate.seriesId) {
      courseCounts.set(candidate.seriesId, (courseCounts.get(candidate.seriesId) ?? 0) + 1);
    }
  }

  return {
    series: seriesResult.rows.map((row) => mapSeries(row, courseCounts.get(row.id) ?? 0)),
    courses,
    relations: relationResult.rows.map(mapRelation),
    knowledgePoints: knowledgeResult.rows.map(mapKnowledgePoint),
    courseKnowledgePoints: courseKnowledgeResult.rows.map(mapCourseKnowledgePoint),
    knowledgePointRelations: [],
    generationJobs: generationJobResult.rows.map(mapGenerationJob),
    batches: [],
    batchItems: batchItemResult.rows.map(mapBatchItem),
    exportJobs: exportJobResult.rows.map(mapExportJob),
    programs: [],
    programVersions: [],
    graduationIndicators: [],
    programCourses: [],
    courseIndicatorSupports: [],
  };
}

/** Create a series, or update its description when the owner already has one by that name. */
export async function createCurriculumSeries(
  queryable: Queryable,
  ownerId: string,
  input: CurriculumSeriesInput,
): Promise<CurriculumSeriesRecord> {
  const name = optionalText(input.name);
  if (!name) throw new CurriculumValidationError('name 不能为空');
  if (name.length > 120) throw new CurriculumValidationError('name 过长');
  const result = await queryable.query<SeriesRow>(
    `INSERT INTO curriculum_series (id, owner_id, name, description, audience, default_hours)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (owner_id, name) DO UPDATE
       SET description = COALESCE(EXCLUDED.description, curriculum_series.description),
           audience = COALESCE(EXCLUDED.audience, curriculum_series.audience),
           default_hours = COALESCE(EXCLUDED.default_hours, curriculum_series.default_hours),
           updated_at = now()
     RETURNING ${SERIES_COLUMNS}`,
    [
      createId('series'),
      ownerId,
      name,
      optionalText(input.description),
      optionalText(input.audience),
      input.defaultHours ?? null,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new CurriculumValidationError('课程系列创建失败');
  return mapSeries(row, 0);
}

/** Patch a series. Omitted fields stay as they are; explicit null clears the field. */
export async function updateCurriculumSeries(
  queryable: Queryable,
  ownerId: string,
  seriesId: string,
  patch: CurriculumSeriesPatch,
): Promise<CurriculumSeriesRecord> {
  const existing = await readSeriesRow(queryable, ownerId, seriesId);
  if (!existing) throw new CurriculumNotFoundError('课程系列不存在');

  const nextName = patch.name !== undefined ? optionalText(patch.name) : existing.name;
  if (!nextName) throw new CurriculumValidationError('name 不能为空');
  if (nextName.length > 120) throw new CurriculumValidationError('name 过长');
  const nextDefaultHours =
    patch.defaultHours !== undefined ? patch.defaultHours : nullableNumeric(existing.default_hours);
  if (nextDefaultHours !== null && nextDefaultHours < 0) {
    throw new CurriculumValidationError('默认学时不能为负数');
  }

  try {
    const result = await queryable.query<SeriesRow>(
      `UPDATE curriculum_series
          SET name = $3,
              description = $4,
              audience = $5,
              default_hours = $6,
              updated_at = now()
        WHERE owner_id = $1 AND id = $2
        RETURNING ${SERIES_COLUMNS}`,
      [
        ownerId,
        seriesId,
        nextName,
        patch.description !== undefined ? optionalText(patch.description) : existing.description,
        patch.audience !== undefined ? optionalText(patch.audience) : existing.audience,
        nextDefaultHours,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new CurriculumNotFoundError('课程系列不存在');
    return mapSeries(row, 0);
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw new CurriculumConflictError('已存在同名课程系列');
    }
    throw error;
  }
}

/** Delete one owned series. Courses and knowledge points keep existing with series_id set to null. */
export async function deleteCurriculumSeries(
  queryable: Queryable,
  ownerId: string,
  seriesId: string,
): Promise<void> {
  const result = await queryable.query<{ id: string } & Record<string, unknown>>(
    'DELETE FROM curriculum_series WHERE owner_id = $1 AND id = $2 RETURNING id',
    [ownerId, seriesId],
  );
  if (!result.rows[0]) throw new CurriculumNotFoundError('课程系列不存在');
}

// ── 系列大纲（章 / 节） ──────────────────────────────────────────────────────

export interface SeriesOutlineNodeInput {
  nodeType: CurriculumOutlineNodeType;
  /** 章必须为空；节必须是同一系列的一章。 */
  parentId?: string | null;
  title: string;
  /** 留空则按父级与顺序自动编号（章 `3`、节 `3-2`）。 */
  code?: string | null;
  note?: string | null;
  orderIndex?: number | null;
}

/**
 * 章节可改的字段。
 *
 * 编号与父级**刻意不可改**：编号是目的前缀（`2-1` → `2-1-3`），改编号会让
 * 已经建好的目编号对不上；换个章挂则会让节的编号前缀说谎。这两件事的正确做法
 * 是删掉重建，而不是让一次 PATCH 留下半套不一致。
 */
export interface SeriesOutlineNodePatch {
  title?: string;
  note?: string | null;
  orderIndex?: number | null;
}

const OUTLINE_NODE_TITLE_LIMIT = 160;
const OUTLINE_NODE_NOTE_LIMIT = 2000;
const OUTLINE_NODE_CODE_LIMIT = 40;

function outlineNodeText(
  value: string | null | undefined,
  limit: number,
  field: string,
): string | null {
  const text = optionalText(value);
  if (text !== null && text.length > limit) {
    throw new CurriculumValidationError(`${field}过长`);
  }
  return text;
}

async function readOutlineNodeRow(
  queryable: Queryable,
  ownerId: string,
  seriesId: string,
  nodeId: string,
): Promise<OutlineNodeRow | null> {
  const result = await queryable.query<OutlineNodeRow>(
    `SELECT ${OUTLINE_NODE_COLUMNS}
       FROM curriculum_series_outline_node
      WHERE owner_id = $1 AND series_id = $2 AND id = $3`,
    [ownerId, seriesId, nodeId],
  );
  return result.rows[0] ?? null;
}

/** 一个系列的全部章节，按层级与顺序读出来交给调用方组树。 */
export async function listSeriesOutline(
  queryable: Queryable,
  ownerId: string,
  seriesId: string,
): Promise<CurriculumSeriesOutlineNodeRecord[]> {
  await assertSeriesOwned(queryable, ownerId, seriesId);
  const result = await queryable.query<OutlineNodeRow>(
    `SELECT ${OUTLINE_NODE_COLUMNS}
       FROM curriculum_series_outline_node
      WHERE owner_id = $1 AND series_id = $2
      ORDER BY (parent_id IS NOT NULL), order_index, created_at`,
    [ownerId, seriesId],
  );
  return result.rows.map(mapOutlineNode);
}

export async function createSeriesOutlineNode(
  queryable: Queryable,
  ownerId: string,
  seriesId: string,
  input: SeriesOutlineNodeInput,
): Promise<CurriculumSeriesOutlineNodeRecord> {
  await assertSeriesOwned(queryable, ownerId, seriesId);
  if (input.nodeType !== 'chapter' && input.nodeType !== 'section') {
    throw new CurriculumValidationError('nodeType 只能是 chapter 或 section');
  }
  const title = outlineNodeText(input.title, OUTLINE_NODE_TITLE_LIMIT, '标题');
  if (!title) throw new CurriculumValidationError('标题不能为空');
  const note = outlineNodeText(input.note, OUTLINE_NODE_NOTE_LIMIT, '说明');
  const explicitCode = outlineNodeText(input.code, OUTLINE_NODE_CODE_LIMIT, '编号');

  let parentId: string | null = null;
  if (input.nodeType === 'section') {
    const parent = optionalText(input.parentId ?? null);
    if (!parent) throw new CurriculumValidationError('节必须挂在某一章下面');
    const parentRow = await readOutlineNodeRow(queryable, ownerId, seriesId, parent);
    if (!parentRow) throw new CurriculumNotFoundError('所属章不存在');
    if (parentRow.node_type !== 'chapter') {
      throw new CurriculumValidationError('节只能挂在章下面，不能再套一节');
    }
    parentId = parent;
  } else if (optionalText(input.parentId ?? null)) {
    throw new CurriculumValidationError('章在顶层，不能再挂父级');
  }

  const nextOrder =
    input.orderIndex ?? (await nextOutlineOrderIndex(queryable, ownerId, seriesId, parentId));
  const code =
    explicitCode ?? (await nextOutlineCode(queryable, ownerId, seriesId, parentId, input.nodeType));

  try {
    const result = await queryable.query<OutlineNodeRow>(
      `INSERT INTO curriculum_series_outline_node
         (id, owner_id, series_id, parent_id, node_type, code, title, note, order_index)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${OUTLINE_NODE_COLUMNS}`,
      [createId('node'), ownerId, seriesId, parentId, input.nodeType, code, title, note, nextOrder],
    );
    const row = result.rows[0];
    if (!row) throw new CurriculumValidationError('章节创建失败');
    return mapOutlineNode(row);
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw new CurriculumConflictError('这个系列里已经有同编号的章节');
    }
    throw error;
  }
}

async function nextOutlineOrderIndex(
  queryable: Queryable,
  ownerId: string,
  seriesId: string,
  parentId: string | null,
): Promise<number> {
  const result = await queryable.query<{ next: number | string }>(
    `SELECT COALESCE(MAX(order_index) + 1, 1) AS next
       FROM curriculum_series_outline_node
      WHERE owner_id = $1 AND series_id = $2
        AND (($3::text IS NULL AND parent_id IS NULL) OR parent_id = $3)`,
    [ownerId, seriesId, parentId],
  );
  return numeric(result.rows[0]?.next ?? 1);
}

/**
 * 自动编号：章取同一系列里下一个序号（`7`），节取"父章编号-同层序号"（`2-3`）。
 *
 * 编号是给人核对的，不是主键，所以删除留下的空洞不回收：把 `2-4` 叫回 `2-2`
 * 会让用户手里那份打印出来的大纲在一夜之间对不上。
 */
async function nextOutlineCode(
  queryable: Queryable,
  ownerId: string,
  seriesId: string,
  parentId: string | null,
  nodeType: CurriculumOutlineNodeType,
): Promise<string> {
  if (nodeType === 'chapter') {
    const result = await queryable.query<{ next: number | string }>(
      `SELECT COALESCE(MAX(order_index) + 1, 1) AS next
         FROM curriculum_series_outline_node
        WHERE owner_id = $1 AND series_id = $2 AND node_type = 'chapter'`,
      [ownerId, seriesId],
    );
    return String(numeric(result.rows[0]?.next ?? 1));
  }
  const parent = parentId ? await readOutlineNodeRow(queryable, ownerId, seriesId, parentId) : null;
  if (!parent) throw new CurriculumValidationError('所属章不存在');
  const result = await queryable.query<{ count: number | string }>(
    `SELECT count(*)::text AS count
       FROM curriculum_series_outline_node
      WHERE owner_id = $1 AND series_id = $2 AND parent_id = $3`,
    [ownerId, seriesId, parentId],
  );
  const sequence = numeric(result.rows[0]?.count ?? 0) + 1;
  return parent.code ? `${parent.code}-${sequence}` : String(sequence);
}

export async function updateSeriesOutlineNode(
  queryable: Queryable,
  ownerId: string,
  seriesId: string,
  nodeId: string,
  patch: SeriesOutlineNodePatch,
): Promise<CurriculumSeriesOutlineNodeRecord> {
  const existing = await readOutlineNodeRow(queryable, ownerId, seriesId, nodeId);
  if (!existing) throw new CurriculumNotFoundError('章节不存在');
  const nextTitle =
    patch.title !== undefined
      ? outlineNodeText(patch.title, OUTLINE_NODE_TITLE_LIMIT, '标题')
      : existing.title;
  if (!nextTitle) throw new CurriculumValidationError('标题不能为空');
  const result = await queryable.query<OutlineNodeRow>(
    `UPDATE curriculum_series_outline_node
        SET title = $4,
            note = $5,
            order_index = $6,
            updated_at = now()
      WHERE owner_id = $1 AND series_id = $2 AND id = $3
      RETURNING ${OUTLINE_NODE_COLUMNS}`,
    [
      ownerId,
      seriesId,
      nodeId,
      nextTitle,
      patch.note !== undefined
        ? outlineNodeText(patch.note, OUTLINE_NODE_NOTE_LIMIT, '说明')
        : existing.note,
      patch.orderIndex ?? numeric(existing.order_index),
    ],
  );
  const row = result.rows[0];
  if (!row) throw new CurriculumNotFoundError('章节不存在');
  return mapOutlineNode(row);
}

/**
 * 删除一章或一节。
 *
 * 删节不删目：`curriculum_task.section_id` 是 `ON DELETE SET NULL`，那些目退回
 * "未归类"而不是跟着消失。分类可以改，教学单元不能因为改分类而被删掉。
 */
export async function deleteSeriesOutlineNode(
  queryable: Queryable,
  ownerId: string,
  seriesId: string,
  nodeId: string,
): Promise<void> {
  const result = await queryable.query<{ id: string } & Record<string, unknown>>(
    `DELETE FROM curriculum_series_outline_node
      WHERE owner_id = $1 AND series_id = $2 AND id = $3
      RETURNING id`,
    [ownerId, seriesId, nodeId],
  );
  if (!result.rows[0]) throw new CurriculumNotFoundError('章节不存在');
}

/** Create a course. `seriesId` and `stageId` are validated against the owner. */
export async function createCurriculumCourse(
  queryable: Queryable,
  ownerId: string,
  input: CurriculumCourseInput,
): Promise<CurriculumCourseRecord> {
  const title = optionalText(input.title);
  if (!title) throw new CurriculumValidationError('title 不能为空');
  if (title.length > 240) throw new CurriculumValidationError('title 过长');
  await assertSeriesOwned(queryable, ownerId, input.seriesId);
  try {
    const result = await queryable.query<CourseRow>(
      `INSERT INTO curriculum_course
         (id, owner_id, series_id, stage_id, title, code, description, chapter, section,
          lesson_order, credits, hours, semester, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING ${COURSE_COLUMNS}`,
      [
        createId('course'),
        ownerId,
        input.seriesId ?? null,
        optionalText(input.stageId),
        title,
        optionalText(input.code),
        optionalText(input.description),
        optionalText(input.chapter),
        optionalText(input.section),
        input.lessonOrder ?? 0,
        input.credits ?? null,
        input.hours ?? null,
        optionalText(input.semester),
        input.status ?? 'active',
      ],
    );
    const row = result.rows[0];
    if (!row) throw new CurriculumValidationError('课程创建失败');
    return mapCourse(row);
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw new CurriculumConflictError('该课堂已经关联了另一门课程');
    }
    throw error;
  }
}

/** Patch a course. Omitted fields stay as they are; explicit nulls clear them. */
export async function updateCurriculumCourse(
  queryable: Queryable,
  ownerId: string,
  courseId: string,
  patch: CurriculumCoursePatch,
): Promise<CurriculumCourseRecord> {
  const existing = await readCourseRow(queryable, ownerId, courseId);
  if (!existing) throw new CurriculumNotFoundError('课程不存在');

  const nextTitle = patch.title !== undefined ? optionalText(patch.title) : existing.title;
  if (!nextTitle) throw new CurriculumValidationError('title 不能为空');
  const nextSeriesId = patch.seriesId !== undefined ? patch.seriesId : existing.series_id;
  await assertSeriesOwned(queryable, ownerId, nextSeriesId);

  try {
    const result = await queryable.query<CourseRow>(
      `UPDATE curriculum_course
          SET series_id = $3,
              stage_id = $4,
              title = $5,
              code = $6,
              description = $7,
              chapter = $8,
              section = $9,
              lesson_order = $10,
              credits = $11,
              hours = $12,
              semester = $13,
              status = $14,
              updated_at = now()
        WHERE owner_id = $1 AND id = $2
        RETURNING ${COURSE_COLUMNS}`,
      [
        ownerId,
        courseId,
        nextSeriesId ?? null,
        patch.stageId !== undefined ? optionalText(patch.stageId) : existing.stage_id,
        nextTitle,
        patch.code !== undefined ? optionalText(patch.code) : existing.code,
        patch.description !== undefined ? optionalText(patch.description) : existing.description,
        patch.chapter !== undefined ? optionalText(patch.chapter) : existing.chapter,
        patch.section !== undefined ? optionalText(patch.section) : existing.section,
        patch.lessonOrder !== undefined ? patch.lessonOrder : numeric(existing.lesson_order),
        patch.credits !== undefined ? patch.credits : existing.credits,
        patch.hours !== undefined ? patch.hours : existing.hours,
        patch.semester !== undefined ? optionalText(patch.semester) : existing.semester,
        patch.status !== undefined ? patch.status : existing.status,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new CurriculumNotFoundError('课程不存在');
    return mapCourse(row);
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw new CurriculumConflictError('该课堂已经关联了另一门课程');
    }
    throw error;
  }
}

export async function deleteCurriculumCourse(
  queryable: Queryable,
  ownerId: string,
  courseId: string,
): Promise<void> {
  const result = await queryable.query<{ id: string } & Record<string, unknown>>(
    'DELETE FROM curriculum_course WHERE owner_id = $1 AND id = $2 RETURNING id',
    [ownerId, courseId],
  );
  if (!result.rows[0]) throw new CurriculumNotFoundError('课程不存在');
}

/** Create (or update the note of) one relation between two owner courses. */
export async function createCurriculumRelation(
  queryable: Queryable,
  ownerId: string,
  input: CurriculumRelationInput,
): Promise<CurriculumRelationRecord> {
  if (input.sourceCourseId === input.targetCourseId) {
    throw new CurriculumValidationError('课程不能与自身建立关系');
  }
  await assertCourseOwned(queryable, ownerId, input.sourceCourseId);
  await assertCourseOwned(queryable, ownerId, input.targetCourseId);
  const result = await queryable.query<RelationRow>(
    `INSERT INTO curriculum_course_relation
       (id, owner_id, source_course_id, target_course_id, relation_type, note)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (owner_id, source_course_id, target_course_id, relation_type) DO UPDATE
       SET note = EXCLUDED.note, updated_at = now()
     RETURNING ${RELATION_COLUMNS}`,
    [
      createId('rel'),
      ownerId,
      input.sourceCourseId,
      input.targetCourseId,
      input.relationType,
      optionalText(input.note),
    ],
  );
  const row = result.rows[0];
  if (!row) throw new CurriculumValidationError('关系创建失败');
  return mapRelation(row);
}

export async function deleteCurriculumRelation(
  queryable: Queryable,
  ownerId: string,
  relationId: string,
): Promise<void> {
  const result = await queryable.query<{ id: string } & Record<string, unknown>>(
    'DELETE FROM curriculum_course_relation WHERE owner_id = $1 AND id = $2 RETURNING id',
    [ownerId, relationId],
  );
  if (!result.rows[0]) throw new CurriculumNotFoundError('关系不存在');
}

/** Create one knowledge point. `seriesId` and `parentId` are owner-validated. */
export async function createKnowledgePoint(
  queryable: Queryable,
  ownerId: string,
  input: KnowledgePointInput,
): Promise<KnowledgePointRecord> {
  const name = optionalText(input.name);
  if (!name) throw new CurriculumValidationError('name 不能为空');
  if (name.length > 240) throw new CurriculumValidationError('name 过长');
  await assertSeriesOwned(queryable, ownerId, input.seriesId);
  await assertKnowledgePointParent(queryable, ownerId, null, optionalText(input.parentId));

  const result = await queryable.query<KnowledgePointRow>(
    `INSERT INTO curriculum_knowledge_point
       (id, owner_id, series_id, parent_id, name, code, type, difficulty, summary, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING ${KNOWLEDGE_POINT_COLUMNS}`,
    [
      createId('kp'),
      ownerId,
      input.seriesId ?? null,
      optionalText(input.parentId),
      name,
      optionalText(input.code),
      input.type ?? 'knowledge',
      input.difficulty ?? null,
      optionalText(input.summary),
      input.sortOrder ?? 0,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new CurriculumValidationError('知识点创建失败');
  return mapKnowledgePoint(row);
}

/** Patch a knowledge point. Omitted fields stay; explicit nulls clear them. */
export async function updateKnowledgePoint(
  queryable: Queryable,
  ownerId: string,
  knowledgePointId: string,
  patch: KnowledgePointPatch,
): Promise<KnowledgePointRecord> {
  const existing = await readKnowledgePointRow(queryable, ownerId, knowledgePointId);
  if (!existing) throw new CurriculumNotFoundError('知识点不存在');

  const nextName = patch.name !== undefined ? optionalText(patch.name) : existing.name;
  if (!nextName) throw new CurriculumValidationError('name 不能为空');
  const nextSeriesId = patch.seriesId !== undefined ? patch.seriesId : existing.series_id;
  const nextParentId = patch.parentId !== undefined ? patch.parentId : existing.parent_id;
  await assertSeriesOwned(queryable, ownerId, nextSeriesId);
  await assertKnowledgePointParent(
    queryable,
    ownerId,
    knowledgePointId,
    optionalText(nextParentId),
  );

  const result = await queryable.query<KnowledgePointRow>(
    `UPDATE curriculum_knowledge_point
        SET series_id = $3,
            parent_id = $4,
            name = $5,
            code = $6,
            type = $7,
            difficulty = $8,
            summary = $9,
            sort_order = $10,
            updated_at = now()
      WHERE owner_id = $1 AND id = $2
      RETURNING ${KNOWLEDGE_POINT_COLUMNS}`,
    [
      ownerId,
      knowledgePointId,
      nextSeriesId ?? null,
      optionalText(nextParentId),
      nextName,
      patch.code !== undefined ? optionalText(patch.code) : existing.code,
      patch.type !== undefined ? patch.type : existing.type,
      patch.difficulty !== undefined ? patch.difficulty : existing.difficulty,
      patch.summary !== undefined ? optionalText(patch.summary) : existing.summary,
      patch.sortOrder !== undefined ? patch.sortOrder : numeric(existing.sort_order),
    ],
  );
  const row = result.rows[0];
  if (!row) throw new CurriculumNotFoundError('知识点不存在');
  return mapKnowledgePoint(row);
}

export async function deleteKnowledgePoint(
  queryable: Queryable,
  ownerId: string,
  knowledgePointId: string,
): Promise<void> {
  const result = await queryable.query<{ id: string } & Record<string, unknown>>(
    'DELETE FROM curriculum_knowledge_point WHERE owner_id = $1 AND id = $2 RETURNING id',
    [ownerId, knowledgePointId],
  );
  if (!result.rows[0]) throw new CurriculumNotFoundError('知识点不存在');
}

/**
 * Replace all knowledge-point links of one course. The whole set is written
 * inside the caller's transaction so a course never exposes a half-updated
 * knowledge map.
 */
export async function setCourseKnowledgePoints(
  queryable: Queryable,
  ownerId: string,
  courseId: string,
  input: CourseKnowledgePointInput[],
): Promise<void> {
  await assertCourseOwned(queryable, ownerId, courseId);

  const unique = new Map<string, CourseKnowledgePointInput>();
  for (const link of input) {
    if (!unique.has(link.knowledgePointId)) unique.set(link.knowledgePointId, link);
  }

  if (unique.size > 0) {
    const ids = [...unique.keys()];
    const result = await queryable.query<{ id: string } & Record<string, unknown>>(
      'SELECT id FROM curriculum_knowledge_point WHERE owner_id = $1 AND id = ANY($2::text[])',
      [ownerId, ids],
    );
    const found = new Set(result.rows.map((row) => row.id));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw new CurriculumNotFoundError(`知识点不存在：${missing.join(', ')}`);
    }
  }

  await queryable.query(
    'DELETE FROM curriculum_course_knowledge_point WHERE owner_id = $1 AND course_id = $2',
    [ownerId, courseId],
  );

  let sortOrder = 0;
  for (const link of unique.values()) {
    await queryable.query(
      `INSERT INTO curriculum_course_knowledge_point
         (course_id, knowledge_point_id, owner_id, coverage_level, sort_order, note)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        courseId,
        link.knowledgePointId,
        ownerId,
        link.coverageLevel ?? 'introduced',
        link.sortOrder ?? sortOrder,
        optionalText(link.note),
      ],
    );
    sortOrder += 1;
  }
}

/** Create (or update the note of) one direction-aware knowledge-point relation. */
export async function createKnowledgePointRelation(
  queryable: Queryable,
  ownerId: string,
  input: KnowledgePointRelationInput,
): Promise<KnowledgePointRelationRecord> {
  if (input.sourceKnowledgePointId === input.targetKnowledgePointId) {
    throw new CurriculumValidationError('知识点不能与自身建立关系');
  }
  await assertKnowledgePointOwned(queryable, ownerId, input.sourceKnowledgePointId);
  await assertKnowledgePointOwned(queryable, ownerId, input.targetKnowledgePointId);
  await assertKnowledgePointRelationAcyclic(
    queryable,
    ownerId,
    input.sourceKnowledgePointId,
    input.targetKnowledgePointId,
    input.relationType,
  );

  const result = await queryable.query<KnowledgePointRelationRow>(
    `INSERT INTO curriculum_knowledge_point_relation
       (id, owner_id, source_knowledge_point_id, target_knowledge_point_id, relation_type, note)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (owner_id, source_knowledge_point_id, target_knowledge_point_id, relation_type)
     DO UPDATE SET note = EXCLUDED.note, updated_at = now()
     RETURNING ${KNOWLEDGE_POINT_RELATION_COLUMNS}`,
    [
      createId('kprel'),
      ownerId,
      input.sourceKnowledgePointId,
      input.targetKnowledgePointId,
      input.relationType,
      optionalText(input.note),
    ],
  );
  const row = result.rows[0];
  if (!row) throw new CurriculumValidationError('知识点关系创建失败');
  return mapKnowledgePointRelation(row);
}

export async function deleteKnowledgePointRelation(
  queryable: Queryable,
  ownerId: string,
  relationId: string,
): Promise<void> {
  const result = await queryable.query<{ id: string } & Record<string, unknown>>(
    'DELETE FROM curriculum_knowledge_point_relation WHERE owner_id = $1 AND id = $2 RETURNING id',
    [ownerId, relationId],
  );
  if (!result.rows[0]) throw new CurriculumNotFoundError('知识点关系不存在');
}

export async function createCurriculumGenerationJob(
  queryable: Queryable,
  ownerId: string,
  input: CurriculumGenerationJobInput,
): Promise<CurriculumGenerationJobRecord> {
  await assertCourseOwned(queryable, ownerId, input.courseId);
  const result = await queryable.query<GenerationJobRow>(
    `INSERT INTO curriculum_generation_job
       (id, owner_id, course_id, status, outline_review, request)
     VALUES ($1, $2, $3, 'queued', $4, $5::jsonb)
     RETURNING ${GENERATION_JOB_COLUMNS}`,
    [
      createId('cjob'),
      ownerId,
      input.courseId,
      input.outlineReview,
      JSON.stringify(input.request ?? {}),
    ],
  );
  const row = result.rows[0];
  if (!row) throw new CurriculumValidationError('生成任务创建失败');
  return mapGenerationJob(row);
}

/** Attach the server-side generation run created for a curriculum job. */
export async function attachGenerationRunToCurriculumJob(
  queryable: Queryable,
  ownerId: string,
  jobId: string,
  runId: string,
): Promise<CurriculumGenerationJobRecord> {
  const result = await queryable.query<GenerationJobRow>(
    `UPDATE curriculum_generation_job
        SET run_id = $3,
            status = 'running',
            error = NULL,
            started_at = COALESCE(started_at, now()),
            updated_at = now()
      WHERE owner_id = $1 AND id = $2
      RETURNING ${GENERATION_JOB_COLUMNS}`,
    [ownerId, jobId, runId],
  );
  const row = result.rows[0];
  if (!row) throw new CurriculumNotFoundError('生成任务不存在');
  return mapGenerationJob(row);
}

export interface CurriculumGenerationRunUpdate {
  stageId?: string | null;
  status: CurriculumGenerationJobStatus;
  error?: CurriculumGenerationJobError | null;
}

/**
 * Apply one committed generation-run event to its curriculum job. Best
 * effort by design: the hook that calls this must not fail the run. A stage
 * already claimed by another course leaves the job unlinked and records the
 * conflict instead of failing the hook.
 */
export async function bindCurriculumGenerationRunStage(
  queryable: Queryable,
  ownerId: string,
  runId: string,
  update: CurriculumGenerationRunUpdate,
): Promise<CurriculumGenerationJobRecord | null> {
  const jobResult = await queryable.query<GenerationJobRow>(
    `SELECT ${GENERATION_JOB_COLUMNS}
       FROM curriculum_generation_job
      WHERE owner_id = $1 AND run_id = $2
      FOR UPDATE`,
    [ownerId, runId],
  );
  const job = jobResult.rows[0];
  if (!job) return null;

  let stageId = update.stageId ?? null;
  let error = update.error ?? null;

  if (stageId) {
    const existing = await queryable.query<{ id: string } & Record<string, unknown>>(
      `SELECT id
         FROM curriculum_course
        WHERE owner_id = $1 AND stage_id = $2 AND id <> $3
        LIMIT 1`,
      [ownerId, stageId, job.course_id],
    );
    if (existing.rows[0]) {
      stageId = null;
      error = {
        code: 'STAGE_ALREADY_LINKED',
        message: '该课堂已经关联了课程台账中的另一门课程',
      };
    } else {
      await queryable.query(
        `UPDATE curriculum_course
            SET stage_id = $3,
                status = CASE WHEN status = 'draft' THEN 'active' ELSE status END,
                updated_at = now()
          WHERE owner_id = $1 AND id = $2`,
        [ownerId, job.course_id, stageId],
      );
    }
  }

  const result = await queryable.query<GenerationJobRow>(
    `UPDATE curriculum_generation_job
        SET run_id = COALESCE(run_id, $3),
            stage_id = COALESCE($4, stage_id),
            status = $5,
            error = COALESCE($6::jsonb, error),
            started_at = CASE
              WHEN started_at IS NULL AND ($4 IS NOT NULL OR $5 = 'running') THEN now()
              ELSE started_at
            END,
            completed_at = CASE
              WHEN $5 IN ('completed', 'failed', 'ended') THEN COALESCE(completed_at, now())
              ELSE completed_at
            END,
            updated_at = now()
      WHERE owner_id = $1 AND run_id = $2
      RETURNING ${GENERATION_JOB_COLUMNS}`,
    [ownerId, runId, runId, stageId, update.status, error === null ? null : JSON.stringify(error)],
  );
  const row = result.rows[0];
  return row ? mapGenerationJob(row) : null;
}

/**
 * Write a produced stage back to the design unit a run was started from.
 *
 * Design-unit generation (`POST .../units/[unitId]/generate`) does not create a
 * `curriculum_generation_job` — it starts the run directly with
 * `curriculumUnitId` in the run input. That id rides the persisted run row, so
 * the write-back resolves the unit from `generation_runs.input` rather than
 * from a browser callback: a refresh or a restart loses nothing, and a hook
 * notification that arrives late still finds the unit.
 *
 * Guards mirror `bindCurriculumGenerationRunStage`: the unit is owner-scoped
 * and a stage already held by a *different* unit or course is refused instead
 * of silently stealing the link. Regenerating a unit replaces its stage — the
 * same semantics the course ledger path has, where re-running a course
 * overwrites `stage_id`.
 */
export async function bindCurriculumUnitStageByRun(
  queryable: Queryable,
  ownerId: string,
  runId: string,
  stageId: string,
): Promise<'bound' | 'unchanged' | 'no-unit' | 'stage-taken'> {
  const unitResult = await queryable.query<{ id: string; stage_id: string | null }>(
    `SELECT u.id, u.stage_id
       FROM curriculum_unit u
       JOIN generation_runs r ON r.owner_id = $1 AND r.id = $2
      WHERE u.owner_id = $1 AND u.id = r.input->>'curriculumUnitId'
      FOR UPDATE OF u`,
    [ownerId, runId],
  );
  const unit = unitResult.rows[0];
  if (!unit) return 'no-unit';

  if (unit.stage_id === stageId) return 'unchanged';

  const taken = await queryable.query<{ kind: 'unit' | 'course'; id: string }>(
    `SELECT 'unit' AS kind, id FROM curriculum_unit
      WHERE owner_id = $1 AND stage_id = $2 AND id <> $3
      UNION ALL
      SELECT 'course' AS kind, id FROM curriculum_course
      WHERE owner_id = $1 AND stage_id = $2
      LIMIT 1`,
    [ownerId, stageId, unit.id],
  );
  if (taken.rows[0]) return 'stage-taken';

  await queryable.query(
    `UPDATE curriculum_unit
        SET stage_id = $3, updated_at = now()
      WHERE owner_id = $1 AND id = $2`,
    [ownerId, unit.id, stageId],
  );
  return 'bound';
}

export interface ClaimedCurriculumBatchItem {
  record: CurriculumBatchItemRecord;
  request: Record<string, unknown>;
}

export interface CurriculumBatchRunUpdate {
  status: CurriculumBatchItemStatus;
  stageId?: string | null;
  error?: CurriculumGenerationJobError | null;
}

/** Recompute one batch from its item states; a user pause/cancel is sticky. */
async function recalculateBatchStatus(
  queryable: Queryable,
  ownerId: string,
  batchId: string,
): Promise<CurriculumBatchRecord | null> {
  const result = await queryable.query<BatchRow>(
    `WITH counts AS (
       SELECT
         count(*) FILTER (WHERE status IN
           ('queued','starting','running','awaiting_outline')) AS active,
         count(*) FILTER (WHERE status = 'completed') AS completed,
         count(*) FILTER (WHERE status IN ('failed','ended')) AS failed,
         count(*) FILTER (WHERE status = 'paused') AS paused,
         count(*) AS total
       FROM curriculum_batch_item
       WHERE owner_id = $1 AND batch_id = $2
     )
     UPDATE curriculum_batch b
        SET status = CASE
              WHEN b.status = 'cancelled' THEN 'cancelled'
              WHEN b.status = 'paused' THEN 'paused'
              WHEN counts.active > 0 THEN 'running'
              WHEN counts.paused > 0 THEN 'paused'
              WHEN counts.completed = counts.total THEN 'completed'
              WHEN counts.failed > 0 THEN 'failed'
              ELSE b.status
            END,
            started_at = CASE
              WHEN b.started_at IS NULL AND counts.active > 0 THEN now()
              ELSE b.started_at
            END,
            completed_at = CASE
              WHEN counts.active = 0
               AND counts.paused = 0
               AND (counts.failed > 0 OR counts.completed = counts.total)
              THEN COALESCE(b.completed_at, now())
              ELSE b.completed_at
            END,
            updated_at = now()
       FROM counts
      WHERE b.owner_id = $1 AND b.id = $2
      RETURNING ${BATCH_COLUMNS}`,
    [ownerId, batchId],
  );
  const row = result.rows[0];
  return row ? mapBatch(row) : null;
}

/** Create a durable batch and its assembled course items in one owner write. */
export async function createCurriculumBatch(
  queryable: Queryable,
  ownerId: string,
  input: CurriculumBatchInput,
): Promise<{ batch: CurriculumBatchRecord; items: CurriculumBatchItemRecord[] }> {
  const name = optionalText(input.name);
  if (!name) throw new CurriculumValidationError('name 不能为空');
  if (name.length > 160) throw new CurriculumValidationError('name 过长');
  if (input.items.length === 0) throw new CurriculumValidationError('items 不能为空');
  if (input.items.length > 50) throw new CurriculumValidationError('items 数量过多');

  const batchId = createId('batch');
  const batchResult = await queryable.query<BatchRow>(
    `INSERT INTO curriculum_batch (id, owner_id, name)
     VALUES ($1, $2, $3)
     RETURNING ${BATCH_COLUMNS}`,
    [batchId, ownerId, name],
  );
  const batchRow = batchResult.rows[0];
  if (!batchRow) throw new CurriculumValidationError('批次创建失败');

  const items: CurriculumBatchItemRecord[] = [];
  for (const [index, item] of input.items.entries()) {
    const title = optionalText(item.title);
    if (!title) throw new CurriculumValidationError(`items[${index}].title 不能为空`);
    if (item.courseId) await assertCourseOwned(queryable, ownerId, item.courseId);
    const maxAttempts = Math.max(1, Math.min(10, Math.round(item.maxAttempts ?? 1)));
    const result = await queryable.query<BatchItemRow>(
      `INSERT INTO curriculum_batch_item
         (id, owner_id, batch_id, position, course_id, title, request, max_attempts)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
       RETURNING ${BATCH_ITEM_COLUMNS}`,
      [
        createId('citem'),
        ownerId,
        batchId,
        index,
        item.courseId ?? null,
        title,
        JSON.stringify(item.request ?? {}),
        maxAttempts,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new CurriculumValidationError(`items[${index}] 创建失败`);
    items.push(mapBatchItem(row));
  }

  return { batch: mapBatch(batchRow), items };
}

/** The owner ids that have a runnable batch item, oldest batch first. */
export async function listOwnersWithRunnableCurriculumBatchItems(
  queryable: Queryable,
  limit = 100,
): Promise<string[]> {
  const result = await queryable.query<{ owner_id: string }>(
    `SELECT b.owner_id
       FROM curriculum_batch_item i
       JOIN curriculum_batch b ON b.id = i.batch_id
      WHERE i.status = 'queued' AND b.status IN ('queued','running')
      GROUP BY b.owner_id
      ORDER BY min(b.created_at), b.owner_id
      LIMIT $1`,
    [Math.max(1, Math.min(1000, Math.round(limit)))],
  );
  return result.rows.map((row) => row.owner_id);
}

/**
 * Claim the oldest runnable item for one owner. A `starting` item that stayed
 * untouched for 15 minutes is treated as an interrupted start and queued
 * again; the start path itself only parks an item in `starting` for the
 * duration of one local function call.
 */
export async function claimNextCurriculumBatchItem(
  queryable: Queryable,
  ownerId: string,
): Promise<ClaimedCurriculumBatchItem | null> {
  await queryable.query(
    `UPDATE curriculum_batch_item
        SET status = 'queued',
            error = $2::jsonb,
            updated_at = now()
      WHERE owner_id = $1
        AND status = 'starting'
        AND updated_at < now() - interval '15 minutes'`,
    [
      ownerId,
      JSON.stringify({
        code: 'BATCH_START_INTERRUPTED',
        message: '上一次启动被中断，已重新排队',
      }),
    ],
  );

  const result = await queryable.query<BatchItemRow>(
    `WITH next AS (
       SELECT i.id
         FROM curriculum_batch_item i
         JOIN curriculum_batch b ON b.id = i.batch_id
        WHERE i.owner_id = $1
          AND i.status = 'queued'
          AND b.status IN ('queued','running')
        ORDER BY b.created_at, i.position
        FOR UPDATE OF i SKIP LOCKED
        LIMIT 1
     )
     UPDATE curriculum_batch_item item
        SET status = 'starting',
            attempts = item.attempts + 1,
            started_at = COALESCE(item.started_at, now()),
            error = NULL,
            updated_at = now()
       FROM next
      WHERE item.id = next.id
      RETURNING item.id, item.batch_id, item.position, item.course_id, item.title,
                item.status, item.attempts, item.max_attempts, item.request,
                item.generation_job_id, item.run_id, item.stage_id, item.error,
                item.started_at, item.completed_at, item.created_at, item.updated_at`,
    [ownerId],
  );
  const row = result.rows[0];
  if (!row) return null;
  await recalculateBatchStatus(queryable, ownerId, row.batch_id);
  return { record: mapBatchItem(row), request: row.request };
}

/** Put a claimed item back after capacity refused the start; attempts are kept. */
export async function requeueCurriculumBatchItem(
  queryable: Queryable,
  ownerId: string,
  itemId: string,
  error?: CurriculumGenerationJobError | null,
): Promise<CurriculumBatchItemRecord> {
  const result = await queryable.query<BatchItemRow>(
    `UPDATE curriculum_batch_item
        SET status = 'queued',
            error = $3::jsonb,
            updated_at = now()
      WHERE owner_id = $1 AND id = $2
      RETURNING ${BATCH_ITEM_COLUMNS}`,
    [ownerId, itemId, error === null || error === undefined ? null : JSON.stringify(error)],
  );
  const row = result.rows[0];
  if (!row) throw new CurriculumNotFoundError('批次条目不存在');
  await recalculateBatchStatus(queryable, ownerId, row.batch_id);
  return mapBatchItem(row);
}

/** The generation run now exists: link it to the batch item. */
export async function markCurriculumBatchItemRunning(
  queryable: Queryable,
  ownerId: string,
  itemId: string,
  jobId: string,
  runId: string,
): Promise<CurriculumBatchItemRecord> {
  const result = await queryable.query<BatchItemRow>(
    `UPDATE curriculum_batch_item
        SET status = 'running',
            generation_job_id = $3,
            run_id = $4,
            error = NULL,
            updated_at = now()
      WHERE owner_id = $1 AND id = $2
      RETURNING ${BATCH_ITEM_COLUMNS}`,
    [ownerId, itemId, jobId, runId],
  );
  const row = result.rows[0];
  if (!row) throw new CurriculumNotFoundError('批次条目不存在');
  await recalculateBatchStatus(queryable, ownerId, row.batch_id);
  return mapBatchItem(row);
}

/** A start failure before a run exists. */
export async function failCurriculumBatchItem(
  queryable: Queryable,
  ownerId: string,
  itemId: string,
  error: CurriculumGenerationJobError,
): Promise<CurriculumBatchItemRecord> {
  const result = await queryable.query<BatchItemRow>(
    `UPDATE curriculum_batch_item
        SET status = 'failed',
            error = $3::jsonb,
            completed_at = COALESCE(completed_at, now()),
            updated_at = now()
      WHERE owner_id = $1 AND id = $2
      RETURNING ${BATCH_ITEM_COLUMNS}`,
    [ownerId, itemId, JSON.stringify(error)],
  );
  const row = result.rows[0];
  if (!row) throw new CurriculumNotFoundError('批次条目不存在');
  await recalculateBatchStatus(queryable, ownerId, row.batch_id);
  return mapBatchItem(row);
}

/**
 * Apply one committed generation-run event to the batch item that owns the
 * run. The generation job is updated first by the hook, so this mirrors the
 * job's final stage/error (the job resolves the one-course-per-stage case).
 */
export async function bindCurriculumBatchItemByRun(
  queryable: Queryable,
  ownerId: string,
  runId: string,
  update: CurriculumBatchRunUpdate,
): Promise<CurriculumBatchItemRecord | null> {
  const itemResult = await queryable.query<BatchItemRow>(
    `SELECT ${BATCH_ITEM_COLUMNS}
       FROM curriculum_batch_item
      WHERE owner_id = $1 AND run_id = $2
      FOR UPDATE`,
    [ownerId, runId],
  );
  const item = itemResult.rows[0];
  if (!item) return null;

  const jobResult = await queryable.query<GenerationJobRow>(
    `SELECT ${GENERATION_JOB_COLUMNS}
       FROM curriculum_generation_job
      WHERE owner_id = $1 AND run_id = $2`,
    [ownerId, runId],
  );
  const job = jobResult.rows[0] ?? null;
  const stageId = job?.stage_id ?? update.stageId ?? null;
  const error =
    job?.error && typeof job.error.code === 'string'
      ? (job.error as unknown as CurriculumGenerationJobError)
      : (update.error ?? null);

  const result = await queryable.query<BatchItemRow>(
    `UPDATE curriculum_batch_item
        SET stage_id = COALESCE($3, stage_id),
            status = $4,
            error = COALESCE($5::jsonb, error),
            started_at = CASE
              WHEN started_at IS NULL AND $3 IS NOT NULL THEN now()
              ELSE started_at
            END,
            completed_at = CASE
              WHEN $4 IN ('completed','failed','ended','cancelled')
              THEN COALESCE(completed_at, now())
              ELSE completed_at
            END,
            updated_at = now()
      WHERE owner_id = $1 AND run_id = $2
      RETURNING ${BATCH_ITEM_COLUMNS}`,
    [ownerId, runId, stageId, update.status, error === null ? null : JSON.stringify(error)],
  );
  const row = result.rows[0];
  if (!row) return null;
  await recalculateBatchStatus(queryable, ownerId, row.batch_id);
  return mapBatchItem(row);
}

export type CurriculumBatchAction = 'pause' | 'resume' | 'cancel' | 'retry';

/** Apply a user batch action and answer the updated batch. */
export async function applyCurriculumBatchAction(
  queryable: Queryable,
  ownerId: string,
  batchId: string,
  action: CurriculumBatchAction,
): Promise<CurriculumBatchRecord> {
  const batchResult = await queryable.query<BatchRow>(
    `SELECT ${BATCH_COLUMNS}
       FROM curriculum_batch
      WHERE owner_id = $1 AND id = $2
      FOR UPDATE`,
    [ownerId, batchId],
  );
  const batch = batchResult.rows[0];
  if (!batch) throw new CurriculumNotFoundError('批次不存在');
  if (batch.status === 'cancelled' && action !== 'retry') {
    throw new CurriculumConflictError('已取消的批次不能再修改');
  }

  if (action === 'pause') {
    await queryable.query(
      `UPDATE curriculum_batch
          SET status = 'paused', updated_at = now()
        WHERE owner_id = $1 AND id = $2`,
      [ownerId, batchId],
    );
  } else if (action === 'resume') {
    await queryable.query(
      `UPDATE curriculum_batch
          SET status = 'running',
              completed_at = NULL,
              updated_at = now()
        WHERE owner_id = $1 AND id = $2`,
      [ownerId, batchId],
    );
    await recalculateBatchStatus(queryable, ownerId, batchId);
  } else if (action === 'cancel') {
    await queryable.query(
      `UPDATE curriculum_batch_item
          SET status = 'cancelled',
              completed_at = COALESCE(completed_at, now()),
              updated_at = now()
        WHERE owner_id = $1 AND batch_id = $2
          AND status IN ('queued','starting')`,
      [ownerId, batchId],
    );
    await queryable.query(
      `UPDATE curriculum_batch
          SET status = 'cancelled',
              completed_at = COALESCE(completed_at, now()),
              updated_at = now()
        WHERE owner_id = $1 AND id = $2`,
      [ownerId, batchId],
    );
  } else {
    // retry: requeue every failed/paused/ended item; running items are kept.
    await queryable.query(
      `UPDATE curriculum_batch_item
          SET status = 'queued',
              attempts = 0,
              generation_job_id = NULL,
              run_id = NULL,
              stage_id = NULL,
              error = NULL,
              started_at = NULL,
              completed_at = NULL,
              updated_at = now()
        WHERE owner_id = $1 AND batch_id = $2
          AND status IN ('failed','paused','ended','cancelled')`,
      [ownerId, batchId],
    );
    await queryable.query(
      `UPDATE curriculum_batch
          SET status = 'queued',
              completed_at = NULL,
              updated_at = now()
        WHERE owner_id = $1 AND id = $2`,
      [ownerId, batchId],
    );
    await recalculateBatchStatus(queryable, ownerId, batchId);
  }

  const result = await queryable.query<BatchRow>(
    `SELECT ${BATCH_COLUMNS} FROM curriculum_batch WHERE owner_id = $1 AND id = $2`,
    [ownerId, batchId],
  );
  const row = result.rows[0];
  if (!row) throw new CurriculumNotFoundError('批次不存在');
  return mapBatch(row);
}

/**
 * Read one export job with the owner's write lock, for an action update.
 */
async function readExportJobRowForUpdate(
  queryable: Queryable,
  ownerId: string,
  exportJobId: string,
): Promise<ExportJobRow | null> {
  const result = await queryable.query<ExportJobRow>(
    `SELECT ${EXPORT_JOB_COLUMNS}
       FROM curriculum_export_job
      WHERE owner_id = $1 AND id = $2
      FOR UPDATE`,
    [ownerId, exportJobId],
  );
  return result.rows[0] ?? null;
}

/**
 * Read export jobs for one owner, optionally narrowed to a set of stages.
 *
 * The 目工作台 needs only the jobs belonging to the classrooms this design
 * produced. Reading the whole snapshot (`GET /api/curriculum`) would work but
 * ships every series, course, knowledge point and program on a page that wants
 * six rows — and it would make the panel's read depend on tables it never
 * displays.
 */
export async function listCurriculumExportJobs(
  queryable: Queryable,
  ownerId: string,
  stageIds?: string[],
): Promise<CurriculumExportJobRecord[]> {
  const result = await queryable.query<ExportJobRow>(
    `SELECT ${EXPORT_JOB_COLUMNS}
       FROM curriculum_export_job
      WHERE owner_id = $1
        AND ($2::text[] IS NULL OR stage_id = ANY($2::text[]))
      ORDER BY created_at DESC`,
    [ownerId, stageIds && stageIds.length > 0 ? stageIds : null],
  );
  return result.rows.map(mapExportJob);
}

/**
 * Queue exports for stage ids that have no batch item behind them.
 *
 * The 目工作台 produces a classroom straight from a design (`units/[id]/generate`),
 * so there is no `curriculum_batch_item` row to name — but the export worker only
 * ever reads `stage_id`, so a job with `batch_item_id = NULL` is an ordinary job.
 *
 * Idempotent per stage the same way the batch path is: a stage that already has a
 * live job (anything but failed/cancelled) is returned as-is instead of queued a
 * second time. Ownership of the stage is deliberately **not** re-checked here:
 * the stage id is only written into a row, and the browser worker's
 * `accessDocument` is owner-scoped, so a stranger's id produces a job that fails
 * with "找不到课程文档" rather than one that reads or renders someone else's
 * classroom. Rejecting it earlier would mean teaching this store about document
 * ownership, which it does not otherwise know about — and the id would have to be
 * resolvable server-side for the check to be worth anything.
 */
async function createStageExportJobs(
  queryable: Queryable,
  ownerId: string,
  stageIds: string[],
  input: CurriculumExportJobsInput,
): Promise<CurriculumExportJobRecord[]> {
  // Dedupe before the query: a caller that sends the same stage twice (two units
  // sharing one generated classroom) would otherwise get two jobs for one MP4.
  const unique = [...new Set(stageIds)];

  const live = await queryable.query<ExportJobRow>(
    `SELECT ${EXPORT_JOB_COLUMNS}
       FROM curriculum_export_job
      WHERE owner_id = $1
        AND stage_id = ANY($2::text[])
        AND status NOT IN ('failed','cancelled')
      ORDER BY created_at DESC`,
    [ownerId, unique],
  );
  const queued = new Map<string, CurriculumExportJobRecord>();
  for (const row of live.rows) {
    const job = mapExportJob(row);
    if (!queued.has(job.stageId)) queued.set(job.stageId, job);
  }

  const created: CurriculumExportJobRecord[] = [];
  for (const stageId of unique) {
    const existing = queued.get(stageId);
    if (existing) {
      created.push(existing);
      continue;
    }
    const result = await queryable.query<ExportJobRow>(
      `INSERT INTO curriculum_export_job
         (id, owner_id, course_id, batch_item_id, stage_id, title,
          resolution, fps, quality, burn_in_subtitles)
       VALUES ($1, $2, NULL, NULL, $3, $4, $5, $6, $7, $8)
       RETURNING ${EXPORT_JOB_COLUMNS}`,
      [
        createId('export'),
        ownerId,
        stageId,
        input.stageTitle ?? '课堂',
        input.resolution,
        input.fps,
        input.quality,
        input.burnInSubtitles,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new CurriculumValidationError('导出任务创建失败');
    created.push(mapExportJob(row));
  }
  return created;
}

/**
 * Enqueue MP4 exports for completed, staged batch items. The request names
 * either one batch or explicit completed item ids. Jobs already present for an
 * item are returned as-is, so clicking "export" twice is idempotent; failed or
 * cancelled jobs are replaced by a fresh queued row.
 *
 * Two entry shapes share this function because they produce the same kind of
 * job: batch items (the 旧台账 path) and bare stage ids (the 目工作台 path,
 * where a design was generated into a classroom without ever passing through a
 * batch). The difference is only which column identifies the source — and for a
 * stage-sourced job `batch_item_id` is NULL, which the claim route and the
 * worker do not care about: both read `stage_id`.
 */
export async function createCurriculumExportJobs(
  queryable: Queryable,
  ownerId: string,
  input: CurriculumExportJobsInput,
): Promise<CurriculumExportJobRecord[]> {
  if (input.stageIds && input.stageIds.length > 0) {
    return createStageExportJobs(queryable, ownerId, input.stageIds, input);
  }

  const candidateResult = await queryable.query<ExportCandidateRow>(
    `SELECT item.id AS batch_item_id,
            item.course_id,
            item.title,
            item.stage_id,
            course.title AS course_title
       FROM curriculum_batch_item item
       JOIN curriculum_batch batch ON batch.id = item.batch_id
       LEFT JOIN curriculum_course course ON course.id = item.course_id
      WHERE item.owner_id = $1
        AND item.status = 'completed'
        AND item.stage_id IS NOT NULL
        AND ($2::text IS NULL OR item.batch_id = $2)
        AND (COALESCE(array_length($3::text[], 1), 0) = 0 OR item.id = ANY($3::text[]))
        AND NOT EXISTS (
          SELECT 1
            FROM curriculum_export_job existing
           WHERE existing.owner_id = item.owner_id
             AND existing.batch_item_id = item.id
             AND existing.status NOT IN ('failed','cancelled')
        )
      ORDER BY batch.created_at, item.position
      LIMIT 50`,
    [ownerId, input.batchId ?? null, input.batchItemIds.length > 0 ? input.batchItemIds : null],
  );

  const candidates = candidateResult.rows;
  if (candidates.length === 0) {
    if (input.batchItemIds.length > 0) {
      const existing = await queryable.query<ExportJobRow>(
        `SELECT ${EXPORT_JOB_COLUMNS}
           FROM curriculum_export_job
          WHERE owner_id = $1 AND batch_item_id = ANY($2::text[])
          ORDER BY created_at`,
        [ownerId, input.batchItemIds],
      );
      if (existing.rows.length > 0) return existing.rows.map(mapExportJob);
    }
    throw new CurriculumValidationError('没有已完成且已关联课堂的批次条目可供导出');
  }

  const created: CurriculumExportJobRecord[] = [];
  for (const candidate of candidates) {
    const title = optionalText(candidate.course_title) ?? optionalText(candidate.title) ?? '课堂';
    const result = await queryable.query<ExportJobRow>(
      `INSERT INTO curriculum_export_job
         (id, owner_id, course_id, batch_item_id, stage_id, title,
          resolution, fps, quality, burn_in_subtitles)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING ${EXPORT_JOB_COLUMNS}`,
      [
        createId('export'),
        ownerId,
        candidate.course_id,
        candidate.batch_item_id,
        candidate.stage_id,
        title,
        input.resolution,
        input.fps,
        input.quality,
        input.burnInSubtitles,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new CurriculumValidationError('导出任务创建失败');
    created.push(mapExportJob(row));
  }

  const ids = candidates.map((candidate) => candidate.batch_item_id);
  const allResult = await queryable.query<ExportJobRow>(
    `SELECT ${EXPORT_JOB_COLUMNS}
       FROM curriculum_export_job
      WHERE owner_id = $1 AND batch_item_id = ANY($2::text[])
      ORDER BY created_at`,
    [ownerId, ids],
  );
  const byId = new Map(created.map((job) => [job.id, job]));
  for (const row of allResult.rows) {
    const job = mapExportJob(row);
    byId.set(job.id, job);
  }
  return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Claim the oldest queued export for one owner. A `building`/`submitting` job
 * untouched for 15 minutes is treated as an interrupted browser worker and
 * queued again, so closing the laptop mid-build does not wedge the queue.
 */
export async function claimNextCurriculumExportJob(
  queryable: Queryable,
  ownerId: string,
): Promise<CurriculumExportJobRecord | null> {
  await queryable.query(
    `UPDATE curriculum_export_job
        SET status = 'queued',
            error = $2::jsonb,
            updated_at = now()
      WHERE owner_id = $1
        AND status IN ('building','submitting')
        AND updated_at < now() - interval '15 minutes'`,
    [
      ownerId,
      JSON.stringify({
        code: 'EXPORT_WORKER_INTERRUPTED',
        message: '上一次浏览器导出被中断，已重新排队',
      }),
    ],
  );

  const result = await queryable.query<ExportJobRow>(
    `WITH next AS (
       SELECT id
         FROM curriculum_export_job
        WHERE owner_id = $1 AND status = 'queued'
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
     UPDATE curriculum_export_job job
        SET status = 'building',
            attempts = job.attempts + 1,
            started_at = COALESCE(job.started_at, now()),
            error = NULL,
            updated_at = now()
       FROM next
      WHERE job.id = next.id
      RETURNING ${EXPORT_JOB_RETURNING}`,
    [ownerId],
  );
  const row = result.rows[0];
  return row ? mapExportJob(row) : null;
}

/**
 * Apply one browser-worker update. Every action is owner-scoped and guarded by
 * the current state so a stale tab cannot complete or cancel a job another
 * worker has already advanced.
 */
export async function applyCurriculumExportJobAction(
  queryable: Queryable,
  ownerId: string,
  exportJobId: string,
  action: CurriculumExportJobAction,
): Promise<CurriculumExportJobRecord> {
  const current = await readExportJobRowForUpdate(queryable, ownerId, exportJobId);
  if (!current) throw new CurriculumNotFoundError('导出任务不存在');
  const status = current.status as CurriculumExportJobStatus;

  if (action.action === 'attach-render') {
    if (status !== 'building' && status !== 'submitting') {
      throw new CurriculumConflictError('只有构建中的导出任务才能关联渲染任务');
    }
    const result = await queryable.query<ExportJobRow>(
      `UPDATE curriculum_export_job
          SET status = 'rendering',
              render_job_id = $3,
              error = NULL,
              updated_at = now()
        WHERE owner_id = $1 AND id = $2
        RETURNING ${EXPORT_JOB_COLUMNS}`,
      [ownerId, exportJobId, action.renderJobId],
    );
    const row = result.rows[0];
    if (!row) throw new CurriculumNotFoundError('导出任务不存在');
    return mapExportJob(row);
  }

  if (action.action === 'progress') {
    const result = await queryable.query<ExportJobRow>(
      `UPDATE curriculum_export_job
          SET progress = GREATEST(progress, $3),
              updated_at = now()
        WHERE owner_id = $1 AND id = $2
        RETURNING ${EXPORT_JOB_COLUMNS}`,
      [ownerId, exportJobId, action.progress],
    );
    const row = result.rows[0];
    if (!row) throw new CurriculumNotFoundError('导出任务不存在');
    return mapExportJob(row);
  }

  if (action.action === 'complete') {
    const result = await queryable.query<ExportJobRow>(
      `UPDATE curriculum_export_job
          SET status = 'succeeded',
              progress = 1,
              error = NULL,
              completed_at = COALESCE(completed_at, now()),
              updated_at = now()
        WHERE owner_id = $1 AND id = $2
        RETURNING ${EXPORT_JOB_COLUMNS}`,
      [ownerId, exportJobId],
    );
    const row = result.rows[0];
    if (!row) throw new CurriculumNotFoundError('导出任务不存在');
    return mapExportJob(row);
  }

  if (action.action === 'fail') {
    const result = await queryable.query<ExportJobRow>(
      `UPDATE curriculum_export_job
          SET status = 'failed',
              error = $3::jsonb,
              completed_at = COALESCE(completed_at, now()),
              updated_at = now()
        WHERE owner_id = $1 AND id = $2
        RETURNING ${EXPORT_JOB_COLUMNS}`,
      [ownerId, exportJobId, JSON.stringify(action.error)],
    );
    const row = result.rows[0];
    if (!row) throw new CurriculumNotFoundError('导出任务不存在');
    return mapExportJob(row);
  }

  if (action.action === 'retry') {
    const result = await queryable.query<ExportJobRow>(
      `UPDATE curriculum_export_job
          SET status = 'queued',
              progress = 0,
              render_job_id = NULL,
              error = NULL,
              completed_at = NULL,
              updated_at = now()
        WHERE owner_id = $1 AND id = $2
        RETURNING ${EXPORT_JOB_COLUMNS}`,
      [ownerId, exportJobId],
    );
    const row = result.rows[0];
    if (!row) throw new CurriculumNotFoundError('导出任务不存在');
    return mapExportJob(row);
  }

  const result = await queryable.query<ExportJobRow>(
    `UPDATE curriculum_export_job
        SET status = 'cancelled',
            completed_at = COALESCE(completed_at, now()),
            updated_at = now()
      WHERE owner_id = $1 AND id = $2
      RETURNING ${EXPORT_JOB_COLUMNS}`,
    [ownerId, exportJobId],
  );
  const row = result.rows[0];
  if (!row) throw new CurriculumNotFoundError('导出任务不存在');
  return mapExportJob(row);
}

interface ProgramRow extends Record<string, unknown> {
  id: string;
  name: string;
  code: string | null;
  description: string | null;
  status: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ProgramVersionRow extends Record<string, unknown> {
  id: string;
  program_id: string;
  name: string;
  version: string | null;
  grade_year: string | null;
  description: string | null;
  status: string;
  target_credits: number | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface GraduationIndicatorRow extends Record<string, unknown> {
  id: string;
  program_version_id: string;
  code: string;
  title: string;
  description: string | null;
  target_weight: number | string;
  sort_order: number | string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ProgramCourseRow extends Record<string, unknown> {
  id: string;
  program_version_id: string;
  course_id: string | null;
  title: string;
  code: string | null;
  semester: string | null;
  category: string;
  credits: number | string | null;
  hours: number | string | null;
  sort_order: number | string;
  note: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface CourseIndicatorSupportRow extends Record<string, unknown> {
  id: string;
  program_version_id: string;
  program_course_id: string;
  indicator_id: string;
  weight: number | string;
  note: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const PROGRAM_COLUMNS = `id, name, code, description, status, created_at, updated_at`;

const PROGRAM_VERSION_COLUMNS = `id, program_id, name, version, grade_year, description,
       status, target_credits, created_at, updated_at`;

const GRADUATION_INDICATOR_COLUMNS = `id, program_version_id, code, title, description,
       target_weight, sort_order, created_at, updated_at`;

const PROGRAM_COURSE_COLUMNS = `id, program_version_id, course_id, title, code, semester,
       category, credits, hours, sort_order, note, created_at, updated_at`;

const COURSE_INDICATOR_SUPPORT_COLUMNS = `id, program_version_id, program_course_id,
       indicator_id, weight, note, created_at, updated_at`;

function mapProgram(row: ProgramRow): CurriculumProgramRecord {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    description: row.description,
    status: row.status as CurriculumProgramStatus,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapProgramVersion(row: ProgramVersionRow): CurriculumProgramVersionRecord {
  return {
    id: row.id,
    programId: row.program_id,
    name: row.name,
    version: row.version,
    gradeYear: row.grade_year,
    description: row.description,
    status: row.status as CurriculumProgramStatus,
    targetCredits: nullableNumeric(row.target_credits),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapGraduationIndicator(row: GraduationIndicatorRow): CurriculumGraduationIndicatorRecord {
  return {
    id: row.id,
    programVersionId: row.program_version_id,
    code: row.code,
    title: row.title,
    description: row.description,
    targetWeight: numeric(row.target_weight),
    sortOrder: numeric(row.sort_order),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapProgramCourse(row: ProgramCourseRow): CurriculumProgramCourseRecord {
  return {
    id: row.id,
    programVersionId: row.program_version_id,
    courseId: row.course_id,
    title: row.title,
    code: row.code,
    semester: row.semester,
    category: row.category as CurriculumProgramCourseCategory,
    credits: nullableNumeric(row.credits),
    hours: nullableNumeric(row.hours),
    sortOrder: numeric(row.sort_order),
    note: row.note,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapCourseIndicatorSupport(row: CourseIndicatorSupportRow): CourseIndicatorSupportRecord {
  return {
    id: row.id,
    programVersionId: row.program_version_id,
    programCourseId: row.program_course_id,
    indicatorId: row.indicator_id,
    weight: numeric(row.weight),
    note: row.note,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export interface CurriculumProgramInput {
  name: string;
  code?: string | null;
  description?: string | null;
  status?: CurriculumProgramStatus;
}

export type CurriculumProgramPatch = Partial<CurriculumProgramInput>;

export interface CurriculumProgramVersionInput {
  programId: string;
  name: string;
  version?: string | null;
  gradeYear?: string | null;
  description?: string | null;
  status?: CurriculumProgramStatus;
  targetCredits?: number | null;
}

export type CurriculumProgramVersionPatch = Partial<
  Omit<CurriculumProgramVersionInput, 'programId'>
>;

export interface CurriculumGraduationIndicatorInput {
  programVersionId: string;
  code: string;
  title: string;
  description?: string | null;
  targetWeight?: number;
  sortOrder?: number;
}

export type CurriculumGraduationIndicatorPatch = Partial<
  Omit<CurriculumGraduationIndicatorInput, 'programVersionId'>
>;

export interface CurriculumProgramCourseInput {
  programVersionId: string;
  courseId?: string | null;
  title: string;
  code?: string | null;
  semester?: string | null;
  category?: CurriculumProgramCourseCategory;
  credits?: number | null;
  hours?: number | null;
  sortOrder?: number;
  note?: string | null;
}

export type CurriculumProgramCoursePatch = Partial<
  Omit<CurriculumProgramCourseInput, 'programVersionId'>
>;

export interface CourseIndicatorSupportInput {
  indicatorId: string;
  weight: number;
  note?: string | null;
}

async function readProgramRow(
  queryable: Queryable,
  ownerId: string,
  programId: string,
): Promise<ProgramRow | null> {
  const result = await queryable.query<ProgramRow>(
    `SELECT ${PROGRAM_COLUMNS} FROM curriculum_program WHERE owner_id = $1 AND id = $2`,
    [ownerId, programId],
  );
  return result.rows[0] ?? null;
}

async function assertProgramOwned(
  queryable: Queryable,
  ownerId: string,
  programId: string | null | undefined,
): Promise<void> {
  if (!programId) return;
  const row = await readProgramRow(queryable, ownerId, programId);
  if (!row) throw new CurriculumNotFoundError('培养方案不存在');
}

async function readProgramVersionRow(
  queryable: Queryable,
  ownerId: string,
  programVersionId: string,
): Promise<ProgramVersionRow | null> {
  const result = await queryable.query<ProgramVersionRow>(
    `SELECT ${PROGRAM_VERSION_COLUMNS}
       FROM curriculum_program_version
      WHERE owner_id = $1 AND id = $2`,
    [ownerId, programVersionId],
  );
  return result.rows[0] ?? null;
}

async function assertProgramVersionOwned(
  queryable: Queryable,
  ownerId: string,
  programVersionId: string | null | undefined,
): Promise<void> {
  if (!programVersionId) return;
  const row = await readProgramVersionRow(queryable, ownerId, programVersionId);
  if (!row) throw new CurriculumNotFoundError('培养方案版本不存在');
}

async function readProgramCourseRow(
  queryable: Queryable,
  ownerId: string,
  programCourseId: string,
): Promise<ProgramCourseRow | null> {
  const result = await queryable.query<ProgramCourseRow>(
    `SELECT ${PROGRAM_COURSE_COLUMNS}
       FROM curriculum_program_course
      WHERE owner_id = $1 AND id = $2`,
    [ownerId, programCourseId],
  );
  return result.rows[0] ?? null;
}

async function assertIndicatorOwned(
  queryable: Queryable,
  ownerId: string,
  indicatorId: string,
): Promise<void> {
  const result = await queryable.query<{ id: string } & Record<string, unknown>>(
    'SELECT id FROM curriculum_graduation_indicator WHERE owner_id = $1 AND id = $2',
    [ownerId, indicatorId],
  );
  if (!result.rows[0]) throw new CurriculumNotFoundError('毕业要求指标点不存在');
}

/** Create a program, or update its metadata when the owner already has one by that name. */
export async function createCurriculumProgram(
  queryable: Queryable,
  ownerId: string,
  input: CurriculumProgramInput,
): Promise<CurriculumProgramRecord> {
  const name = optionalText(input.name);
  if (!name) throw new CurriculumValidationError('name 不能为空');
  if (name.length > 240) throw new CurriculumValidationError('name 过长');
  const result = await queryable.query<ProgramRow>(
    `INSERT INTO curriculum_program
       (id, owner_id, name, code, description, status)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (owner_id, name) DO UPDATE
       SET code = EXCLUDED.code,
           description = EXCLUDED.description,
           status = EXCLUDED.status,
           updated_at = now()
     RETURNING ${PROGRAM_COLUMNS}`,
    [
      createId('program'),
      ownerId,
      name,
      optionalText(input.code),
      optionalText(input.description),
      input.status ?? 'active',
    ],
  );
  const row = result.rows[0];
  if (!row) throw new CurriculumValidationError('培养方案创建失败');
  return mapProgram(row);
}

export async function updateCurriculumProgram(
  queryable: Queryable,
  ownerId: string,
  programId: string,
  patch: CurriculumProgramPatch,
): Promise<CurriculumProgramRecord> {
  const existing = await readProgramRow(queryable, ownerId, programId);
  if (!existing) throw new CurriculumNotFoundError('培养方案不存在');
  const nextName = patch.name !== undefined ? optionalText(patch.name) : existing.name;
  if (!nextName) throw new CurriculumValidationError('name 不能为空');
  try {
    const result = await queryable.query<ProgramRow>(
      `UPDATE curriculum_program
          SET name = $3,
              code = $4,
              description = $5,
              status = $6,
              updated_at = now()
        WHERE owner_id = $1 AND id = $2
        RETURNING ${PROGRAM_COLUMNS}`,
      [
        ownerId,
        programId,
        nextName,
        patch.code !== undefined ? optionalText(patch.code) : existing.code,
        patch.description !== undefined ? optionalText(patch.description) : existing.description,
        patch.status !== undefined ? patch.status : existing.status,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new CurriculumNotFoundError('培养方案不存在');
    return mapProgram(row);
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw new CurriculumConflictError('该所有者已存在同名培养方案');
    }
    throw error;
  }
}

export async function deleteCurriculumProgram(
  queryable: Queryable,
  ownerId: string,
  programId: string,
): Promise<void> {
  const result = await queryable.query<{ id: string } & Record<string, unknown>>(
    'DELETE FROM curriculum_program WHERE owner_id = $1 AND id = $2 RETURNING id',
    [ownerId, programId],
  );
  if (!result.rows[0]) throw new CurriculumNotFoundError('培养方案不存在');
}

export async function createCurriculumProgramVersion(
  queryable: Queryable,
  ownerId: string,
  input: CurriculumProgramVersionInput,
): Promise<CurriculumProgramVersionRecord> {
  const name = optionalText(input.name);
  if (!name) throw new CurriculumValidationError('name 不能为空');
  await assertProgramOwned(queryable, ownerId, input.programId);
  try {
    const result = await queryable.query<ProgramVersionRow>(
      `INSERT INTO curriculum_program_version
         (id, owner_id, program_id, name, version, grade_year, description, status, target_credits)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${PROGRAM_VERSION_COLUMNS}`,
      [
        createId('program-version'),
        ownerId,
        input.programId,
        name,
        optionalText(input.version),
        optionalText(input.gradeYear),
        optionalText(input.description),
        input.status ?? 'draft',
        input.targetCredits ?? null,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new CurriculumValidationError('培养方案版本创建失败');
    return mapProgramVersion(row);
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw new CurriculumConflictError('该培养方案已存在同名版本');
    }
    throw error;
  }
}

export async function updateCurriculumProgramVersion(
  queryable: Queryable,
  ownerId: string,
  programVersionId: string,
  patch: CurriculumProgramVersionPatch,
): Promise<CurriculumProgramVersionRecord> {
  const existing = await readProgramVersionRow(queryable, ownerId, programVersionId);
  if (!existing) throw new CurriculumNotFoundError('培养方案版本不存在');
  const nextName = patch.name !== undefined ? optionalText(patch.name) : existing.name;
  if (!nextName) throw new CurriculumValidationError('name 不能为空');
  try {
    const result = await queryable.query<ProgramVersionRow>(
      `UPDATE curriculum_program_version
          SET name = $3,
              version = $4,
              grade_year = $5,
              description = $6,
              status = $7,
              target_credits = $8,
              updated_at = now()
        WHERE owner_id = $1 AND id = $2
        RETURNING ${PROGRAM_VERSION_COLUMNS}`,
      [
        ownerId,
        programVersionId,
        nextName,
        patch.version !== undefined ? optionalText(patch.version) : existing.version,
        patch.gradeYear !== undefined ? optionalText(patch.gradeYear) : existing.grade_year,
        patch.description !== undefined ? optionalText(patch.description) : existing.description,
        patch.status !== undefined ? patch.status : existing.status,
        patch.targetCredits !== undefined
          ? patch.targetCredits
          : nullableNumeric(existing.target_credits),
      ],
    );
    const row = result.rows[0];
    if (!row) throw new CurriculumNotFoundError('培养方案版本不存在');
    return mapProgramVersion(row);
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw new CurriculumConflictError('该培养方案已存在同名版本');
    }
    throw error;
  }
}

export async function deleteCurriculumProgramVersion(
  queryable: Queryable,
  ownerId: string,
  programVersionId: string,
): Promise<void> {
  const result = await queryable.query<{ id: string } & Record<string, unknown>>(
    'DELETE FROM curriculum_program_version WHERE owner_id = $1 AND id = $2 RETURNING id',
    [ownerId, programVersionId],
  );
  if (!result.rows[0]) throw new CurriculumNotFoundError('培养方案版本不存在');
}

export async function createGraduationIndicator(
  queryable: Queryable,
  ownerId: string,
  input: CurriculumGraduationIndicatorInput,
): Promise<CurriculumGraduationIndicatorRecord> {
  const code = optionalText(input.code);
  const title = optionalText(input.title);
  if (!code) throw new CurriculumValidationError('code 不能为空');
  if (!title) throw new CurriculumValidationError('title 不能为空');
  await assertProgramVersionOwned(queryable, ownerId, input.programVersionId);
  try {
    const result = await queryable.query<GraduationIndicatorRow>(
      `INSERT INTO curriculum_graduation_indicator
         (id, owner_id, program_version_id, code, title, description, target_weight, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${GRADUATION_INDICATOR_COLUMNS}`,
      [
        createId('indicator'),
        ownerId,
        input.programVersionId,
        code,
        title,
        optionalText(input.description),
        input.targetWeight ?? 3,
        input.sortOrder ?? 0,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new CurriculumValidationError('毕业要求指标点创建失败');
    return mapGraduationIndicator(row);
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw new CurriculumConflictError('该培养方案版本已存在相同 code 的毕业要求指标点');
    }
    throw error;
  }
}

export async function updateGraduationIndicator(
  queryable: Queryable,
  ownerId: string,
  indicatorId: string,
  patch: CurriculumGraduationIndicatorPatch,
): Promise<CurriculumGraduationIndicatorRecord> {
  const existingResult = await queryable.query<GraduationIndicatorRow>(
    `SELECT ${GRADUATION_INDICATOR_COLUMNS}
       FROM curriculum_graduation_indicator
      WHERE owner_id = $1 AND id = $2`,
    [ownerId, indicatorId],
  );
  const existing = existingResult.rows[0];
  if (!existing) throw new CurriculumNotFoundError('毕业要求指标点不存在');
  const code = patch.code !== undefined ? optionalText(patch.code) : existing.code;
  const title = patch.title !== undefined ? optionalText(patch.title) : existing.title;
  if (!code) throw new CurriculumValidationError('code 不能为空');
  if (!title) throw new CurriculumValidationError('title 不能为空');
  try {
    const result = await queryable.query<GraduationIndicatorRow>(
      `UPDATE curriculum_graduation_indicator
          SET code = $3,
              title = $4,
              description = $5,
              target_weight = $6,
              sort_order = $7,
              updated_at = now()
        WHERE owner_id = $1 AND id = $2
        RETURNING ${GRADUATION_INDICATOR_COLUMNS}`,
      [
        ownerId,
        indicatorId,
        code,
        title,
        patch.description !== undefined ? optionalText(patch.description) : existing.description,
        patch.targetWeight !== undefined ? patch.targetWeight : numeric(existing.target_weight),
        patch.sortOrder !== undefined ? patch.sortOrder : numeric(existing.sort_order),
      ],
    );
    const row = result.rows[0];
    if (!row) throw new CurriculumNotFoundError('毕业要求指标点不存在');
    return mapGraduationIndicator(row);
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw new CurriculumConflictError('该培养方案版本已存在相同 code 的毕业要求指标点');
    }
    throw error;
  }
}

export async function deleteGraduationIndicator(
  queryable: Queryable,
  ownerId: string,
  indicatorId: string,
): Promise<void> {
  const result = await queryable.query<{ id: string } & Record<string, unknown>>(
    'DELETE FROM curriculum_graduation_indicator WHERE owner_id = $1 AND id = $2 RETURNING id',
    [ownerId, indicatorId],
  );
  if (!result.rows[0]) throw new CurriculumNotFoundError('毕业要求指标点不存在');
}

export async function createCurriculumProgramCourse(
  queryable: Queryable,
  ownerId: string,
  input: CurriculumProgramCourseInput,
): Promise<CurriculumProgramCourseRecord> {
  await assertProgramVersionOwned(queryable, ownerId, input.programVersionId);
  if (input.courseId) await assertCourseOwned(queryable, ownerId, input.courseId);
  let title = optionalText(input.title);
  if (!title && input.courseId) {
    const course = await readCourseRow(queryable, ownerId, input.courseId);
    title = course?.title ?? null;
  }
  if (!title) throw new CurriculumValidationError('title 不能为空');
  try {
    const result = await queryable.query<ProgramCourseRow>(
      `INSERT INTO curriculum_program_course
         (id, owner_id, program_version_id, course_id, title, code, semester, category,
          credits, hours, sort_order, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING ${PROGRAM_COURSE_COLUMNS}`,
      [
        createId('program-course'),
        ownerId,
        input.programVersionId,
        input.courseId ?? null,
        title,
        optionalText(input.code),
        optionalText(input.semester),
        input.category ?? 'required',
        input.credits ?? null,
        input.hours ?? null,
        input.sortOrder ?? 0,
        optionalText(input.note),
      ],
    );
    const row = result.rows[0];
    if (!row) throw new CurriculumValidationError('计划课程创建失败');
    return mapProgramCourse(row);
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw new CurriculumConflictError('该课程已存在于培养方案版本中');
    }
    throw error;
  }
}

export async function updateCurriculumProgramCourse(
  queryable: Queryable,
  ownerId: string,
  programCourseId: string,
  patch: CurriculumProgramCoursePatch,
): Promise<CurriculumProgramCourseRecord> {
  const existing = await readProgramCourseRow(queryable, ownerId, programCourseId);
  if (!existing) throw new CurriculumNotFoundError('计划课程不存在');
  const nextCourseId = patch.courseId !== undefined ? patch.courseId : existing.course_id;
  if (nextCourseId) await assertCourseOwned(queryable, ownerId, nextCourseId);
  let nextTitle = patch.title !== undefined ? optionalText(patch.title) : existing.title;
  if (!nextTitle && nextCourseId) {
    const course = await readCourseRow(queryable, ownerId, nextCourseId);
    nextTitle = course?.title ?? null;
  }
  if (!nextTitle) throw new CurriculumValidationError('title 不能为空');
  try {
    const result = await queryable.query<ProgramCourseRow>(
      `UPDATE curriculum_program_course
          SET course_id = $3,
              title = $4,
              code = $5,
              semester = $6,
              category = $7,
              credits = $8,
              hours = $9,
              sort_order = $10,
              note = $11,
              updated_at = now()
        WHERE owner_id = $1 AND id = $2
        RETURNING ${PROGRAM_COURSE_COLUMNS}`,
      [
        ownerId,
        programCourseId,
        nextCourseId ?? null,
        nextTitle,
        patch.code !== undefined ? optionalText(patch.code) : existing.code,
        patch.semester !== undefined ? optionalText(patch.semester) : existing.semester,
        patch.category !== undefined ? patch.category : existing.category,
        patch.credits !== undefined ? patch.credits : nullableNumeric(existing.credits),
        patch.hours !== undefined ? patch.hours : nullableNumeric(existing.hours),
        patch.sortOrder !== undefined ? patch.sortOrder : numeric(existing.sort_order),
        patch.note !== undefined ? optionalText(patch.note) : existing.note,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new CurriculumNotFoundError('计划课程不存在');
    return mapProgramCourse(row);
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw new CurriculumConflictError('该课程已存在于培养方案版本中');
    }
    throw error;
  }
}

export async function deleteCurriculumProgramCourse(
  queryable: Queryable,
  ownerId: string,
  programCourseId: string,
): Promise<void> {
  const result = await queryable.query<{ id: string } & Record<string, unknown>>(
    'DELETE FROM curriculum_program_course WHERE owner_id = $1 AND id = $2 RETURNING id',
    [ownerId, programCourseId],
  );
  if (!result.rows[0]) throw new CurriculumNotFoundError('计划课程不存在');
}

/**
 * Replace all graduation-indicator support rows for one planned course. Each
 * indicator must belong to the same program version as the planned course.
 */
export async function setCourseIndicatorSupports(
  queryable: Queryable,
  ownerId: string,
  programCourseId: string,
  supports: CourseIndicatorSupportInput[],
): Promise<CourseIndicatorSupportRecord[]> {
  const programCourse = await readProgramCourseRow(queryable, ownerId, programCourseId);
  if (!programCourse) throw new CurriculumNotFoundError('计划课程不存在');
  for (const support of supports) {
    await assertIndicatorOwned(queryable, ownerId, support.indicatorId);
  }
  const indicatorIds = supports.map((support) => support.indicatorId);
  if (indicatorIds.length > 0) {
    const mismatched = await queryable.query<{ id: string } & Record<string, unknown>>(
      `SELECT id
         FROM curriculum_graduation_indicator
        WHERE owner_id = $1
          AND id = ANY($2::text[])
          AND program_version_id <> $3`,
      [ownerId, indicatorIds, programCourse.program_version_id],
    );
    if (mismatched.rows.length > 0) {
      throw new CurriculumValidationError('毕业要求指标点不属于该培养方案版本');
    }
  }
  await queryable.query(
    'DELETE FROM curriculum_course_indicator_support WHERE owner_id = $1 AND program_course_id = $2',
    [ownerId, programCourseId],
  );
  const inserted: CourseIndicatorSupportRecord[] = [];
  for (const support of supports) {
    const result = await queryable.query<CourseIndicatorSupportRow>(
      `INSERT INTO curriculum_course_indicator_support
         (id, owner_id, program_version_id, program_course_id, indicator_id, weight, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${COURSE_INDICATOR_SUPPORT_COLUMNS}`,
      [
        createId('support'),
        ownerId,
        programCourse.program_version_id,
        programCourseId,
        support.indicatorId,
        support.weight,
        optionalText(support.note),
      ],
    );
    const row = result.rows[0];
    if (!row) throw new CurriculumValidationError('指标点支撑创建失败');
    inserted.push(mapCourseIndicatorSupport(row));
  }
  return inserted;
}

export type CurriculumProgramPlanImportMode = 'create' | 'replace';

export interface CurriculumProgramPlanImportInput {
  mode: CurriculumProgramPlanImportMode;
  document: ProgramPlanExportFile;
  programId?: string | null;
  programVersionId?: string | null;
  /**
   * Sync mode uses `replace` to rewrite a target version's content from
   * another version but keeps the target's own name, version number, grade
   * year, status and target credits.
   */
  preserveVersionMetadata?: boolean;
}

export interface CurriculumProgramPlanImportResult {
  mode: CurriculumProgramPlanImportMode;
  program: CurriculumProgramRecord;
  programVersion: CurriculumProgramVersionRecord;
  indicators: CurriculumGraduationIndicatorRecord[];
  programCourses: CurriculumProgramCourseRecord[];
  supports: CourseIndicatorSupportRecord[];
}

async function resolveImportedCourseId(
  queryable: Queryable,
  ownerId: string,
  course: ProgramPlanExportCourse,
): Promise<string | null> {
  if (course.courseId) {
    const owned = await readCourseRow(queryable, ownerId, course.courseId);
    if (owned) return owned.id;
  }
  if (course.courseCode) {
    const byCode = await queryable.query<{ id: string } & Record<string, unknown>>(
      `SELECT id
         FROM curriculum_course
        WHERE owner_id = $1 AND lower(code) = lower($2)
        ORDER BY created_at, id
        LIMIT 1`,
      [ownerId, course.courseCode],
    );
    if (byCode.rows[0]) return byCode.rows[0].id;
  }
  const byTitle = await queryable.query<{ id: string } & Record<string, unknown>>(
    `SELECT id
       FROM curriculum_course
      WHERE owner_id = $1 AND lower(title) = lower($2)
      ORDER BY created_at, id
      LIMIT 1`,
    [ownerId, course.title],
  );
  return byTitle.rows[0]?.id ?? null;
}

/**
 * Import one validated program-plan document. `create` always adds a version;
 * `replace` rewrites an existing version. The caller owns request identity and
 * wraps this in a transaction with `fenceOwnerWrite`, so the whole import
 * either commits as one plan or leaves the previous plan untouched.
 */
export async function importCurriculumProgramPlan(
  queryable: Queryable,
  ownerId: string,
  input: CurriculumProgramPlanImportInput,
): Promise<CurriculumProgramPlanImportResult> {
  const { document, mode } = input;
  let programRow: ProgramRow | null = null;
  let versionRow: ProgramVersionRow | null = null;

  if (mode === 'replace') {
    if (!input.programVersionId) {
      throw new CurriculumValidationError('mode 为 replace 时 programVersionId 不能为空');
    }
    versionRow = await readProgramVersionRow(queryable, ownerId, input.programVersionId);
    if (!versionRow) throw new CurriculumNotFoundError('培养方案版本不存在');
    programRow = await readProgramRow(queryable, ownerId, versionRow.program_id);
    if (!programRow) throw new CurriculumNotFoundError('培养方案不存在');
  } else {
    if (input.programVersionId) {
      throw new CurriculumValidationError('programVersionId 仅在 replace 模式下使用');
    }
    if (input.programId) {
      programRow = await readProgramRow(queryable, ownerId, input.programId);
      if (!programRow) throw new CurriculumNotFoundError('培养方案不存在');
    } else {
      const createdProgram = await createCurriculumProgram(queryable, ownerId, {
        name: document.program.name,
        code: document.program.code,
        description: document.program.description,
        status: document.program.status,
      });
      programRow = await readProgramRow(queryable, ownerId, createdProgram.id);
      if (!programRow) throw new CurriculumValidationError('培养方案创建失败');
    }
    const createdVersion = await createCurriculumProgramVersion(queryable, ownerId, {
      programId: programRow.id,
      name: document.programVersion.name,
      version: document.programVersion.version,
      gradeYear: document.programVersion.gradeYear,
      description: document.programVersion.description,
      status: document.programVersion.status,
      targetCredits: document.programVersion.targetCredits,
    });
    versionRow = await readProgramVersionRow(queryable, ownerId, createdVersion.id);
    if (!versionRow) throw new CurriculumValidationError('培养方案版本创建失败');
  }

  if (mode === 'replace') {
    if (!input.preserveVersionMetadata) {
      await updateCurriculumProgramVersion(queryable, ownerId, versionRow.id, {
        name: document.programVersion.name,
        version: document.programVersion.version,
        gradeYear: document.programVersion.gradeYear,
        description: document.programVersion.description,
        status: document.programVersion.status,
        targetCredits: document.programVersion.targetCredits,
      });
    }
    await queryable.query(
      'DELETE FROM curriculum_course_indicator_support WHERE owner_id = $1 AND program_version_id = $2',
      [ownerId, versionRow.id],
    );
    await queryable.query(
      'DELETE FROM curriculum_graduation_indicator WHERE owner_id = $1 AND program_version_id = $2',
      [ownerId, versionRow.id],
    );
    await queryable.query(
      'DELETE FROM curriculum_program_course WHERE owner_id = $1 AND program_version_id = $2',
      [ownerId, versionRow.id],
    );
    // The version row was read before the updates; refresh the metadata so the
    // response reflects the values that were just written.
    versionRow = await readProgramVersionRow(queryable, ownerId, versionRow.id);
    if (!versionRow) throw new CurriculumNotFoundError('培养方案版本不存在');
  }

  const indicators: CurriculumGraduationIndicatorRecord[] = [];
  const indicatorByCode = new Map<string, CurriculumGraduationIndicatorRecord>();
  for (const indicator of document.indicators) {
    const created = await createGraduationIndicator(queryable, ownerId, {
      programVersionId: versionRow.id,
      code: indicator.code,
      title: indicator.title,
      description: indicator.description,
      targetWeight: indicator.targetWeight,
      sortOrder: indicator.sortOrder,
    });
    indicators.push(created);
    indicatorByCode.set(created.code, created);
  }

  const programCourses: CurriculumProgramCourseRecord[] = [];
  const supports: CourseIndicatorSupportRecord[] = [];
  for (const course of document.courses) {
    const courseId = await resolveImportedCourseId(queryable, ownerId, course);
    const createdCourse = await createCurriculumProgramCourse(queryable, ownerId, {
      programVersionId: versionRow.id,
      courseId,
      title: course.title,
      code: course.code,
      semester: course.semester,
      category: course.category,
      credits: course.credits,
      hours: course.hours,
      sortOrder: course.sortOrder,
      note: course.note,
    });
    programCourses.push(createdCourse);

    const inputSupports = course.supports.map((support) => {
      const indicator = indicatorByCode.get(support.indicatorCode);
      if (!indicator) {
        throw new CurriculumValidationError(
          `毕业要求指标点「${support.indicatorCode}」不属于该培养方案版本`,
        );
      }
      return { indicatorId: indicator.id, weight: support.weight, note: support.note };
    });
    if (inputSupports.length > 0) {
      const inserted = await setCourseIndicatorSupports(
        queryable,
        ownerId,
        createdCourse.id,
        inputSupports,
      );
      supports.push(...inserted);
    }
  }

  return {
    mode,
    program: mapProgram(programRow),
    programVersion: mapProgramVersion(versionRow),
    indicators,
    programCourses,
    supports,
  };
}
