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

import { ensureCurriculumSchema } from '@/lib/persistence/curriculum';
import { withSchemaBootstrapLock } from '@/lib/persistence/schema-bootstrap-lock';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import type {
  CourseKnowledgeCoverageLevel,
  CourseKnowledgePointRecord,
  CurriculumCourseRecord,
  CurriculumCourseStatus,
  CurriculumRelationRecord,
  CurriculumRelationType,
  CurriculumSeriesRecord,
  CurriculumSnapshot,
  KnowledgePointDifficulty,
  KnowledgePointRecord,
  KnowledgePointType,
} from '@/lib/curriculum/types';

export interface CurriculumSeriesInput {
  name: string;
  description?: string | null;
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

const COURSE_COLUMNS = `id, series_id, stage_id, title, code, description, chapter, section,
       lesson_order, credits, hours, semester, status, created_at, updated_at`;

const RELATION_COLUMNS = `id, source_course_id, target_course_id, relation_type, note,
       created_at, updated_at`;

const KNOWLEDGE_POINT_COLUMNS = `id, series_id, parent_id, name, code, type, difficulty,
       summary, sort_order, created_at, updated_at`;

const COURSE_KNOWLEDGE_POINT_COLUMNS = `course_id, knowledge_point_id, coverage_level,
       sort_order, note, created_at, updated_at`;

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
    courseCount,
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
  if (!result.rows[0]) throw new CurriculumNotFoundError('series not found');
}

async function assertCourseOwned(
  queryable: Queryable,
  ownerId: string,
  courseId: string,
): Promise<void> {
  const row = await readCourseRow(queryable, ownerId, courseId);
  if (!row) throw new CurriculumNotFoundError('course not found');
}

async function assertKnowledgePointOwned(
  queryable: Queryable,
  ownerId: string,
  knowledgePointId: string,
): Promise<void> {
  const row = await readKnowledgePointRow(queryable, ownerId, knowledgePointId);
  if (!row) throw new CurriculumNotFoundError('knowledge point not found');
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
    throw new CurriculumValidationError('a knowledge point cannot be its own parent');
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
    throw new CurriculumValidationError('knowledge point parent would create a cycle');
  }
}

/** Every series, course, relation, knowledge point and course-point link of one owner. */
export async function listCurriculum(
  queryable: Queryable,
  ownerId: string,
): Promise<CurriculumSnapshot> {
  const [seriesResult, courseResult, relationResult, knowledgeResult, courseKnowledgeResult] =
    await Promise.all([
      queryable.query<SeriesRow>(
        `SELECT id, name, description, created_at, updated_at
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
  };
}

/** Create a series, or update its description when the owner already has one by that name. */
export async function createCurriculumSeries(
  queryable: Queryable,
  ownerId: string,
  input: CurriculumSeriesInput,
): Promise<CurriculumSeriesRecord> {
  const name = optionalText(input.name);
  if (!name) throw new CurriculumValidationError('name is required');
  if (name.length > 120) throw new CurriculumValidationError('name is too long');
  const result = await queryable.query<SeriesRow>(
    `INSERT INTO curriculum_series (id, owner_id, name, description)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (owner_id, name) DO UPDATE
       SET description = COALESCE(EXCLUDED.description, curriculum_series.description),
           updated_at = now()
     RETURNING id, name, description, created_at, updated_at`,
    [createId('series'), ownerId, name, optionalText(input.description)],
  );
  const row = result.rows[0];
  if (!row) throw new CurriculumValidationError('series could not be created');
  return mapSeries(row, 0);
}

/** Create a course. `seriesId` and `stageId` are validated against the owner. */
export async function createCurriculumCourse(
  queryable: Queryable,
  ownerId: string,
  input: CurriculumCourseInput,
): Promise<CurriculumCourseRecord> {
  const title = optionalText(input.title);
  if (!title) throw new CurriculumValidationError('title is required');
  if (title.length > 240) throw new CurriculumValidationError('title is too long');
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
    if (!row) throw new CurriculumValidationError('course could not be created');
    return mapCourse(row);
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw new CurriculumConflictError('this stage is already linked to another course');
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
  if (!existing) throw new CurriculumNotFoundError('course not found');

  const nextTitle = patch.title !== undefined ? optionalText(patch.title) : existing.title;
  if (!nextTitle) throw new CurriculumValidationError('title is required');
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
    if (!row) throw new CurriculumNotFoundError('course not found');
    return mapCourse(row);
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw new CurriculumConflictError('this stage is already linked to another course');
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
  if (!result.rows[0]) throw new CurriculumNotFoundError('course not found');
}

/** Create (or update the note of) one relation between two owner courses. */
export async function createCurriculumRelation(
  queryable: Queryable,
  ownerId: string,
  input: CurriculumRelationInput,
): Promise<CurriculumRelationRecord> {
  if (input.sourceCourseId === input.targetCourseId) {
    throw new CurriculumValidationError('a course cannot relate to itself');
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
  if (!row) throw new CurriculumValidationError('relation could not be created');
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
  if (!result.rows[0]) throw new CurriculumNotFoundError('relation not found');
}

/** Create one knowledge point. `seriesId` and `parentId` are owner-validated. */
export async function createKnowledgePoint(
  queryable: Queryable,
  ownerId: string,
  input: KnowledgePointInput,
): Promise<KnowledgePointRecord> {
  const name = optionalText(input.name);
  if (!name) throw new CurriculumValidationError('name is required');
  if (name.length > 240) throw new CurriculumValidationError('name is too long');
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
  if (!row) throw new CurriculumValidationError('knowledge point could not be created');
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
  if (!existing) throw new CurriculumNotFoundError('knowledge point not found');

  const nextName = patch.name !== undefined ? optionalText(patch.name) : existing.name;
  if (!nextName) throw new CurriculumValidationError('name is required');
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
  if (!row) throw new CurriculumNotFoundError('knowledge point not found');
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
  if (!result.rows[0]) throw new CurriculumNotFoundError('knowledge point not found');
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
      throw new CurriculumNotFoundError(`knowledge point not found: ${missing.join(', ')}`);
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
