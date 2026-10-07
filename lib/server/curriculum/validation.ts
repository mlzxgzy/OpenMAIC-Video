import {
  CURRICULUM_COURSE_STATUSES,
  CURRICULUM_RELATION_TYPES,
  type CurriculumCourseStatus,
  type CurriculumRelationType,
} from '@/lib/curriculum/types';

export type ParseResult<T> = { ok: true; value: T } | { ok: false; message: string };

function asRecord(body: unknown): Record<string, unknown> | null {
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

function readOptionalText(
  record: Record<string, unknown>,
  key: string,
): string | null | undefined | ParseResult<never> {
  if (!(key in record)) return undefined;
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== 'string') return { ok: false, message: `${key} must be a string or null` };
  return value;
}

function readOptionalNumber(
  record: Record<string, unknown>,
  key: string,
): number | null | undefined | ParseResult<never> {
  if (!(key in record)) return undefined;
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return { ok: false, message: `${key} must be a non-negative number or null` };
  }
  return value;
}

function isParseFailure(value: unknown): value is ParseResult<never> {
  return typeof value === 'object' && value !== null && 'ok' in value && value.ok === false;
}

export interface ParsedSeriesInput {
  name: string;
  description?: string | null;
}

export function parseSeriesInput(body: unknown): ParseResult<ParsedSeriesInput> {
  const record = asRecord(body);
  if (!record) return { ok: false, message: 'request body must be a JSON object' };
  const name = record.name;
  if (typeof name !== 'string' || name.trim().length === 0) {
    return { ok: false, message: 'name is required' };
  }
  const description = readOptionalText(record, 'description');
  if (isParseFailure(description)) return description;
  return { ok: true, value: { name: name.trim(), description: description ?? undefined } };
}

export interface ParsedCourseInput {
  seriesId?: string | null;
  stageId?: string | null;
  title?: string;
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

export function parseCourseInput(
  body: unknown,
  options: { requireTitle: boolean },
): ParseResult<ParsedCourseInput> {
  const record = asRecord(body);
  if (!record) return { ok: false, message: 'request body must be a JSON object' };

  const value: ParsedCourseInput = {};
  const title = record.title;
  if (title !== undefined) {
    if (typeof title !== 'string' || title.trim().length === 0) {
      return { ok: false, message: 'title must be a non-empty string' };
    }
    value.title = title.trim();
  } else if (options.requireTitle) {
    return { ok: false, message: 'title is required' };
  }

  for (const key of [
    'seriesId',
    'stageId',
    'code',
    'description',
    'chapter',
    'section',
    'semester',
  ] as const) {
    const parsed = readOptionalText(record, key);
    if (isParseFailure(parsed)) return parsed;
    if (parsed !== undefined) {
      // A blank string is a request to clear the field, same as null.
      value[key] = parsed === null ? null : parsed.trim().length > 0 ? parsed.trim() : null;
    }
  }

  const lessonOrder = readOptionalNumber(record, 'lessonOrder');
  if (isParseFailure(lessonOrder)) return lessonOrder;
  if (lessonOrder !== undefined) {
    if (lessonOrder === null || !Number.isInteger(lessonOrder)) {
      return { ok: false, message: 'lessonOrder must be an integer or null' };
    }
    value.lessonOrder = lessonOrder;
  }

  for (const key of ['credits', 'hours'] as const) {
    const parsed = readOptionalNumber(record, key);
    if (isParseFailure(parsed)) return parsed;
    if (parsed !== undefined) value[key] = parsed;
  }

  if ('status' in record) {
    const status = record.status;
    if (!CURRICULUM_COURSE_STATUSES.includes(status as CurriculumCourseStatus)) {
      return {
        ok: false,
        message: `status must be one of ${CURRICULUM_COURSE_STATUSES.join(', ')}`,
      };
    }
    value.status = status as CurriculumCourseStatus;
  }

  return { ok: true, value };
}

export interface ParsedRelationInput {
  sourceCourseId: string;
  targetCourseId: string;
  relationType: CurriculumRelationType;
  note?: string | null;
}

export function parseRelationInput(body: unknown): ParseResult<ParsedRelationInput> {
  const record = asRecord(body);
  if (!record) return { ok: false, message: 'request body must be a JSON object' };
  const { sourceCourseId, targetCourseId, relationType } = record;
  if (typeof sourceCourseId !== 'string' || sourceCourseId.trim().length === 0) {
    return { ok: false, message: 'sourceCourseId is required' };
  }
  if (typeof targetCourseId !== 'string' || targetCourseId.trim().length === 0) {
    return { ok: false, message: 'targetCourseId is required' };
  }
  if (!CURRICULUM_RELATION_TYPES.includes(relationType as CurriculumRelationType)) {
    return {
      ok: false,
      message: `relationType must be one of ${CURRICULUM_RELATION_TYPES.join(', ')}`,
    };
  }
  const note = readOptionalText(record, 'note');
  if (isParseFailure(note)) return note;
  return {
    ok: true,
    value: {
      sourceCourseId: sourceCourseId.trim(),
      targetCourseId: targetCourseId.trim(),
      relationType: relationType as CurriculumRelationType,
      note: note === undefined ? undefined : note,
    },
  };
}
