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
  CurriculumCourseRecord,
  CurriculumCourseStatus,
  CurriculumRelationRecord,
  CurriculumRelationType,
  CurriculumSeriesRecord,
  CurriculumSnapshot,
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

const COURSE_COLUMNS = `id, series_id, stage_id, title, code, description, chapter, section,
       lesson_order, credits, hours, semester, status, created_at, updated_at`;

const RELATION_COLUMNS = `id, source_course_id, target_course_id, relation_type, note,
       created_at, updated_at`;

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

function nullableIso(value: Date | string | null): string | null {
  return value === null ? null : iso(value);
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

/** Every series, course and relation of one owner. */
export async function listCurriculum(
  queryable: Queryable,
  ownerId: string,
): Promise<CurriculumSnapshot> {
  const [seriesResult, courseResult, relationResult] = await Promise.all([
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
