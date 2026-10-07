import {
  COURSE_KNOWLEDGE_COVERAGE_LEVELS,
  CURRICULUM_COURSE_STATUSES,
  CURRICULUM_GENERATION_OUTLINE_REVIEWS,
  CURRICULUM_RELATION_TYPES,
  KNOWLEDGE_POINT_DIFFICULTIES,
  KNOWLEDGE_POINT_RELATION_TYPES,
  KNOWLEDGE_POINT_TYPES,
  type CourseKnowledgeCoverageLevel,
  type CurriculumCourseStatus,
  type CurriculumGenerationOutlineReview,
  type CurriculumRelationType,
  type KnowledgePointDifficulty,
  type KnowledgePointRelationType,
  type KnowledgePointType,
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

export interface ParsedKnowledgePointInput {
  seriesId?: string | null;
  parentId?: string | null;
  name?: string;
  code?: string | null;
  type?: KnowledgePointType;
  difficulty?: KnowledgePointDifficulty | null;
  summary?: string | null;
  sortOrder?: number;
}

export function parseKnowledgePointInput(
  body: unknown,
  options: { requireName: boolean },
): ParseResult<ParsedKnowledgePointInput> {
  const record = asRecord(body);
  if (!record) return { ok: false, message: 'request body must be a JSON object' };

  const value: ParsedKnowledgePointInput = {};
  const name = record.name;
  if (name !== undefined) {
    if (typeof name !== 'string' || name.trim().length === 0) {
      return { ok: false, message: 'name must be a non-empty string' };
    }
    value.name = name.trim();
  } else if (options.requireName) {
    return { ok: false, message: 'name is required' };
  }

  for (const key of ['seriesId', 'parentId', 'code', 'summary'] as const) {
    const parsed = readOptionalText(record, key);
    if (isParseFailure(parsed)) return parsed;
    if (parsed !== undefined) {
      value[key] = parsed === null ? null : parsed.trim().length > 0 ? parsed.trim() : null;
    }
  }

  if ('type' in record) {
    const type = record.type;
    if (!KNOWLEDGE_POINT_TYPES.includes(type as KnowledgePointType)) {
      return {
        ok: false,
        message: `type must be one of ${KNOWLEDGE_POINT_TYPES.join(', ')}`,
      };
    }
    value.type = type as KnowledgePointType;
  }

  if ('difficulty' in record) {
    const difficulty = record.difficulty;
    if (difficulty === null) {
      value.difficulty = null;
    } else if (!KNOWLEDGE_POINT_DIFFICULTIES.includes(difficulty as KnowledgePointDifficulty)) {
      return {
        ok: false,
        message: `difficulty must be one of ${KNOWLEDGE_POINT_DIFFICULTIES.join(', ')} or null`,
      };
    } else {
      value.difficulty = difficulty as KnowledgePointDifficulty;
    }
  }

  const sortOrder = readOptionalNumber(record, 'sortOrder');
  if (isParseFailure(sortOrder)) return sortOrder;
  if (sortOrder !== undefined) {
    if (sortOrder === null || !Number.isInteger(sortOrder)) {
      return { ok: false, message: 'sortOrder must be an integer or null' };
    }
    value.sortOrder = sortOrder;
  }

  return { ok: true, value };
}

export interface ParsedCourseKnowledgePointInput {
  knowledgePointId: string;
  coverageLevel?: CourseKnowledgeCoverageLevel;
  sortOrder?: number;
  note?: string | null;
}

export function parseCourseKnowledgePointsInput(
  body: unknown,
): ParseResult<ParsedCourseKnowledgePointInput[]> {
  const record = asRecord(body);
  if (!record) return { ok: false, message: 'request body must be a JSON object' };
  const raw = record.knowledgePoints;
  if (!Array.isArray(raw)) return { ok: false, message: 'knowledgePoints must be an array' };
  if (raw.length > 500) return { ok: false, message: 'knowledgePoints is too large' };

  const links: ParsedCourseKnowledgePointInput[] = [];
  for (const [index, item] of raw.entries()) {
    const entry = asRecord(item);
    if (!entry) return { ok: false, message: `knowledgePoints[${index}] must be an object` };
    const knowledgePointId = entry.knowledgePointId;
    if (typeof knowledgePointId !== 'string' || knowledgePointId.trim().length === 0) {
      return { ok: false, message: `knowledgePoints[${index}].knowledgePointId is required` };
    }
    const parsed: ParsedCourseKnowledgePointInput = { knowledgePointId: knowledgePointId.trim() };

    if ('coverageLevel' in entry) {
      const coverage = entry.coverageLevel;
      if (!COURSE_KNOWLEDGE_COVERAGE_LEVELS.includes(coverage as CourseKnowledgeCoverageLevel)) {
        return {
          ok: false,
          message: `knowledgePoints[${index}].coverageLevel must be one of ${COURSE_KNOWLEDGE_COVERAGE_LEVELS.join(', ')}`,
        };
      }
      parsed.coverageLevel = coverage as CourseKnowledgeCoverageLevel;
    }

    const sortOrder = readOptionalNumber(entry, 'sortOrder');
    if (isParseFailure(sortOrder)) {
      return { ok: false, message: `knowledgePoints[${index}].sortOrder must be a number` };
    }
    if (sortOrder !== undefined) {
      if (sortOrder === null || !Number.isInteger(sortOrder)) {
        return {
          ok: false,
          message: `knowledgePoints[${index}].sortOrder must be an integer or null`,
        };
      }
      parsed.sortOrder = sortOrder;
    }

    const note = readOptionalText(entry, 'note');
    if (isParseFailure(note)) {
      return { ok: false, message: `knowledgePoints[${index}].note must be a string or null` };
    }
    if (note !== undefined) parsed.note = note;

    links.push(parsed);
  }
  return { ok: true, value: links };
}

export interface ParsedKnowledgePointRelationInput {
  sourceKnowledgePointId: string;
  targetKnowledgePointId: string;
  relationType: KnowledgePointRelationType;
  note?: string | null;
}

export function parseKnowledgePointRelationInput(
  body: unknown,
): ParseResult<ParsedKnowledgePointRelationInput> {
  const record = asRecord(body);
  if (!record) return { ok: false, message: 'request body must be a JSON object' };
  const { sourceKnowledgePointId, targetKnowledgePointId, relationType } = record;
  if (typeof sourceKnowledgePointId !== 'string' || sourceKnowledgePointId.trim().length === 0) {
    return { ok: false, message: 'sourceKnowledgePointId is required' };
  }
  if (typeof targetKnowledgePointId !== 'string' || targetKnowledgePointId.trim().length === 0) {
    return { ok: false, message: 'targetKnowledgePointId is required' };
  }
  if (!KNOWLEDGE_POINT_RELATION_TYPES.includes(relationType as KnowledgePointRelationType)) {
    return {
      ok: false,
      message: `relationType must be one of ${KNOWLEDGE_POINT_RELATION_TYPES.join(', ')}`,
    };
  }
  const note = readOptionalText(record, 'note');
  if (isParseFailure(note)) return note;
  return {
    ok: true,
    value: {
      sourceKnowledgePointId: sourceKnowledgePointId.trim(),
      targetKnowledgePointId: targetKnowledgePointId.trim(),
      relationType: relationType as KnowledgePointRelationType,
      note: note === undefined ? undefined : note,
    },
  };
}

export interface ParsedCourseAssemblyInput {
  seriesId?: string | null;
  title: string;
  code?: string | null;
  chapter?: string | null;
  section?: string | null;
  type?: string | null;
  hours?: number | null;
  knowledgePoints: ParsedCourseKnowledgePointInput[];
}

export function parseCourseAssemblyInput(body: unknown): ParseResult<ParsedCourseAssemblyInput> {
  const record = asRecord(body);
  if (!record) return { ok: false, message: 'request body must be a JSON object' };

  const title = record.title;
  if (typeof title !== 'string' || title.trim().length === 0) {
    return { ok: false, message: 'title is required' };
  }
  if (title.trim().length > 240) return { ok: false, message: 'title is too long' };

  const value: ParsedCourseAssemblyInput = {
    title: title.trim(),
    knowledgePoints: [],
  };

  for (const key of ['seriesId', 'code', 'chapter', 'section', 'type'] as const) {
    const parsed = readOptionalText(record, key);
    if (isParseFailure(parsed)) return parsed;
    if (parsed !== undefined) {
      const trimmed = parsed === null ? null : parsed.trim();
      value[key] = trimmed && trimmed.length > 0 ? trimmed : null;
    }
  }
  if (value.type && value.type.length > 60) {
    return { ok: false, message: 'type is too long' };
  }

  const hours = readOptionalNumber(record, 'hours');
  if (isParseFailure(hours)) return hours;
  if (hours !== undefined) {
    if (hours === null || hours <= 0) {
      return { ok: false, message: 'hours must be a positive number or null' };
    }
    value.hours = hours;
  }

  const links = parseCourseKnowledgePointsInput({ knowledgePoints: record.knowledgePoints });
  if (!links.ok) return { ok: false, message: links.message };
  if (links.value.length === 0) {
    return { ok: false, message: 'knowledgePoints must contain at least one item' };
  }
  value.knowledgePoints = links.value;

  return { ok: true, value };
}

export interface ParsedGenerationJobVoice {
  providerId: string;
  voiceId: string;
  speed?: number;
}

export interface ParsedGenerationJobInput {
  assembly: ParsedCourseAssemblyInput;
  courseId?: string | null;
  outlineReview: CurriculumGenerationOutlineReview;
  interactive: boolean;
  taskEngine: boolean;
  voice?: ParsedGenerationJobVoice;
}

function parseGenerationJobVoice(value: unknown): ParseResult<ParsedGenerationJobVoice> {
  const record = asRecord(value);
  if (!record) return { ok: false, message: 'voice must be an object' };
  const providerId = record.providerId;
  if (typeof providerId !== 'string' || providerId.trim().length === 0) {
    return { ok: false, message: 'voice.providerId is required' };
  }
  const voiceId = record.voiceId;
  if (typeof voiceId !== 'string' || voiceId.trim().length === 0) {
    return { ok: false, message: 'voice.voiceId is required' };
  }
  if (voiceId.length > 256) return { ok: false, message: 'voice.voiceId is too long' };
  if (
    record.speed !== undefined &&
    (typeof record.speed !== 'number' || !(record.speed > 0) || record.speed > 4)
  ) {
    return { ok: false, message: 'voice.speed must be a number above 0 and at most 4' };
  }
  return {
    ok: true,
    value: {
      providerId: providerId.trim(),
      voiceId: voiceId.trim(),
      ...(record.speed !== undefined ? { speed: record.speed as number } : {}),
    },
  };
}

/**
 * The one-click generation body: the assembly input, plus the classic run
 * options a course product needs. Unknown run input options stay out; the
 * route composes the requirement from the server-built assembly.
 */
export function parseGenerationJobInput(body: unknown): ParseResult<ParsedGenerationJobInput> {
  const record = asRecord(body);
  if (!record) return { ok: false, message: 'request body must be a JSON object' };

  const assembly = parseCourseAssemblyInput(record.assembly);
  if (!assembly.ok) return assembly;

  const value: ParsedGenerationJobInput = {
    assembly: assembly.value,
    outlineReview: 'auto',
    interactive: false,
    taskEngine: false,
  };

  if ('courseId' in record && record.courseId !== undefined) {
    if (record.courseId === null) {
      value.courseId = null;
    } else if (typeof record.courseId === 'string' && record.courseId.trim().length > 0) {
      value.courseId = record.courseId.trim();
    } else {
      return { ok: false, message: 'courseId must be a non-empty string or null' };
    }
  }

  if ('outlineReview' in record && record.outlineReview !== undefined) {
    if (
      !CURRICULUM_GENERATION_OUTLINE_REVIEWS.includes(
        record.outlineReview as CurriculumGenerationOutlineReview,
      )
    ) {
      return {
        ok: false,
        message: `outlineReview must be one of ${CURRICULUM_GENERATION_OUTLINE_REVIEWS.join(', ')}`,
      };
    }
    value.outlineReview = record.outlineReview as CurriculumGenerationOutlineReview;
  }

  for (const key of ['interactive', 'taskEngine'] as const) {
    const field = record[key];
    if (field !== undefined) {
      if (typeof field !== 'boolean') return { ok: false, message: `${key} must be a boolean` };
      value[key] = field;
    }
  }

  if (record.voice !== undefined) {
    const voice = parseGenerationJobVoice(record.voice);
    if (!voice.ok) return voice;
    value.voice = voice.value;
  }

  return { ok: true, value };
}

export interface ParsedCurriculumBatchRunOptions {
  outlineReview: CurriculumGenerationOutlineReview;
  interactive: boolean;
  taskEngine: boolean;
  voice?: ParsedGenerationJobVoice;
}

function parseCurriculumBatchRunOptions(
  record: Record<string, unknown>,
): ParseResult<ParsedCurriculumBatchRunOptions> {
  const value: ParsedCurriculumBatchRunOptions = {
    outlineReview: 'auto',
    interactive: false,
    taskEngine: false,
  };
  if ('outlineReview' in record && record.outlineReview !== undefined) {
    if (
      !CURRICULUM_GENERATION_OUTLINE_REVIEWS.includes(
        record.outlineReview as CurriculumGenerationOutlineReview,
      )
    ) {
      return {
        ok: false,
        message: `outlineReview must be one of ${CURRICULUM_GENERATION_OUTLINE_REVIEWS.join(', ')}`,
      };
    }
    value.outlineReview = record.outlineReview as CurriculumGenerationOutlineReview;
  }
  for (const key of ['interactive', 'taskEngine'] as const) {
    const field = record[key];
    if (field !== undefined) {
      if (typeof field !== 'boolean') return { ok: false, message: `${key} must be a boolean` };
      value[key] = field;
    }
  }
  if (record.voice !== undefined) {
    const voice = parseGenerationJobVoice(record.voice);
    if (!voice.ok) return voice;
    value.voice = voice.value;
  }
  return { ok: true, value };
}

/** An existing ledger course, or a fully specified assembly item. */
export type ParsedCurriculumBatchItem =
  | {
      kind: 'assembly';
      generation: ParsedGenerationJobInput;
      maxAttempts: number;
    }
  | {
      kind: 'course';
      courseId: string;
      options: ParsedCurriculumBatchRunOptions;
      maxAttempts: number;
    };

export interface ParsedCurriculumBatchInput {
  name: string;
  items: ParsedCurriculumBatchItem[];
}

/**
 * The batch body is a list of existing curriculum courses to generate and/or
 * explicit assembly+course items. Run options are shared with the one-click
 * API. At most 50 items are accepted so one request cannot create an
 * unbounded owner queue.
 */
export function parseCurriculumBatchInput(body: unknown): ParseResult<ParsedCurriculumBatchInput> {
  const record = asRecord(body);
  if (!record) return { ok: false, message: 'request body must be a JSON object' };
  const name =
    typeof record.name === 'string' && record.name.trim().length > 0
      ? record.name.trim().slice(0, 160)
      : '批量生成';
  const rawItems = record.items;
  if (!Array.isArray(rawItems)) return { ok: false, message: 'items must be an array' };
  if (rawItems.length === 0) return { ok: false, message: 'items must contain at least one item' };
  if (rawItems.length > 50) return { ok: false, message: 'items is too large' };

  const items: ParsedCurriculumBatchItem[] = [];
  for (const [index, rawItem] of rawItems.entries()) {
    const item = asRecord(rawItem);
    if (!item) return { ok: false, message: `items[${index}] must be an object` };

    const maxAttemptsRaw = item.maxAttempts;
    let maxAttempts = 1;
    if (maxAttemptsRaw !== undefined) {
      if (
        typeof maxAttemptsRaw !== 'number' ||
        !Number.isInteger(maxAttemptsRaw) ||
        maxAttemptsRaw < 1 ||
        maxAttemptsRaw > 10
      ) {
        return { ok: false, message: `items[${index}].maxAttempts must be an integer 1-10` };
      }
      maxAttempts = maxAttemptsRaw;
    }

    if ('assembly' in item) {
      const generation = parseGenerationJobInput(item);
      if (!generation.ok) {
        return { ok: false, message: `items[${index}]: ${generation.message}` };
      }
      items.push({ kind: 'assembly', generation: generation.value, maxAttempts });
      continue;
    }

    const courseId = item.courseId;
    if (typeof courseId !== 'string' || courseId.trim().length === 0) {
      return {
        ok: false,
        message: `items[${index}] must have a non-empty courseId or an assembly`,
      };
    }
    const options = parseCurriculumBatchRunOptions(item);
    if (!options.ok) return { ok: false, message: `items[${index}]: ${options.message}` };
    items.push({
      kind: 'course',
      courseId: courseId.trim(),
      options: options.value,
      maxAttempts,
    });
  }

  return { ok: true, value: { name, items } };
}
