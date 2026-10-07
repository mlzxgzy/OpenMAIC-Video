import {
  COURSE_KNOWLEDGE_COVERAGE_LEVELS,
  CURRICULUM_COURSE_STATUSES,
  CURRICULUM_GENERATION_OUTLINE_REVIEWS,
  CURRICULUM_PROGRAM_COURSE_CATEGORIES,
  CURRICULUM_PROGRAM_STATUSES,
  CURRICULUM_RELATION_TYPES,
  KNOWLEDGE_POINT_DIFFICULTIES,
  KNOWLEDGE_POINT_RELATION_TYPES,
  KNOWLEDGE_POINT_TYPES,
  type CourseKnowledgeCoverageLevel,
  type CurriculumCourseStatus,
  type CurriculumGenerationOutlineReview,
  type CurriculumProgramCourseCategory,
  type CurriculumProgramStatus,
  type CurriculumRelationType,
  type KnowledgePointDifficulty,
  type KnowledgePointRelationType,
  type KnowledgePointType,
} from '@/lib/curriculum/types';
import {
  parseProgramPlanExportDocument,
  type ProgramPlanExportFile,
} from '@/lib/curriculum/program-io';
import {
  VIDEO_FPS,
  VIDEO_QUALITIES,
  VIDEO_RESOLUTIONS,
} from '@/lib/video-export-app/export-options';

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

export interface ParsedCurriculumExportJobsInput {
  batchId?: string;
  batchItemIds: string[];
  resolution: '720p' | '1080p' | '4k';
  fps: number;
  quality: 'draft' | 'standard' | 'high';
  burnInSubtitles: boolean;
}

/**
 * Enqueue body for MP4 export. The request either names one batch (all its
 * completed, staged items) or an explicit list of completed batch-item ids.
 * Render options are validated against the same constants the browser UI
 * offers, so the worker always starts from a known archive shape.
 */
export function parseCurriculumExportJobsInput(
  body: unknown,
): ParseResult<ParsedCurriculumExportJobsInput> {
  const record = asRecord(body);
  if (!record) return { ok: false, message: 'request body must be a JSON object' };

  const value: ParsedCurriculumExportJobsInput = {
    batchItemIds: [],
    resolution: '1080p',
    fps: 30,
    quality: 'standard',
    burnInSubtitles: false,
  };

  if ('batchId' in record && record.batchId !== undefined) {
    if (typeof record.batchId !== 'string' || record.batchId.trim().length === 0) {
      return { ok: false, message: 'batchId must be a non-empty string' };
    }
    value.batchId = record.batchId.trim();
  }

  if ('batchItemIds' in record && record.batchItemIds !== undefined) {
    if (!Array.isArray(record.batchItemIds)) {
      return { ok: false, message: 'batchItemIds must be an array' };
    }
    for (const [index, item] of record.batchItemIds.entries()) {
      if (typeof item !== 'string' || item.trim().length === 0) {
        return { ok: false, message: `batchItemIds[${index}] must be a non-empty string` };
      }
      value.batchItemIds.push(item.trim());
    }
  }

  if (!value.batchId && value.batchItemIds.length === 0) {
    return { ok: false, message: 'batchId or batchItemIds is required' };
  }
  if (value.batchItemIds.length > 50) {
    return { ok: false, message: 'batchItemIds is too large' };
  }

  if ('resolution' in record && record.resolution !== undefined) {
    if (
      typeof record.resolution !== 'string' ||
      !Object.prototype.hasOwnProperty.call(VIDEO_RESOLUTIONS, record.resolution)
    ) {
      return {
        ok: false,
        message: `resolution must be one of ${Object.keys(VIDEO_RESOLUTIONS).join(', ')}`,
      };
    }
    value.resolution = record.resolution as ParsedCurriculumExportJobsInput['resolution'];
  }
  if ('fps' in record && record.fps !== undefined) {
    if (
      typeof record.fps !== 'number' ||
      !VIDEO_FPS.includes(record.fps as (typeof VIDEO_FPS)[number])
    ) {
      return { ok: false, message: `fps must be one of ${VIDEO_FPS.join(', ')}` };
    }
    value.fps = record.fps;
  }
  if ('quality' in record && record.quality !== undefined) {
    if (
      typeof record.quality !== 'string' ||
      !VIDEO_QUALITIES.includes(record.quality as (typeof VIDEO_QUALITIES)[number])
    ) {
      return { ok: false, message: `quality must be one of ${VIDEO_QUALITIES.join(', ')}` };
    }
    value.quality = record.quality as ParsedCurriculumExportJobsInput['quality'];
  }
  if ('burnInSubtitles' in record && record.burnInSubtitles !== undefined) {
    if (typeof record.burnInSubtitles !== 'boolean') {
      return { ok: false, message: 'burnInSubtitles must be a boolean' };
    }
    value.burnInSubtitles = record.burnInSubtitles;
  }

  return { ok: true, value };
}

export type ParsedCurriculumExportJobAction =
  | { action: 'attach-render'; renderJobId: string }
  | { action: 'progress'; progress: number }
  | { action: 'complete' }
  | { action: 'fail'; error: { code: string; message?: string } }
  | { action: 'retry' }
  | { action: 'cancel' };

/** Browser-worker updates for one export job. */
export function parseCurriculumExportJobAction(
  body: unknown,
): ParseResult<ParsedCurriculumExportJobAction> {
  const record = asRecord(body);
  if (!record) return { ok: false, message: 'request body must be a JSON object' };
  const action = record.action;
  if (action === 'attach-render') {
    if (typeof record.renderJobId !== 'string' || record.renderJobId.trim().length === 0) {
      return { ok: false, message: 'renderJobId is required' };
    }
    return { ok: true, value: { action, renderJobId: record.renderJobId.trim() } };
  }
  if (action === 'progress') {
    const progress = record.progress;
    if (
      typeof progress !== 'number' ||
      !Number.isFinite(progress) ||
      progress < 0 ||
      progress > 1
    ) {
      return { ok: false, message: 'progress must be a number between 0 and 1' };
    }
    return { ok: true, value: { action, progress } };
  }
  if (action === 'complete' || action === 'retry' || action === 'cancel') {
    return { ok: true, value: { action } };
  }
  if (action === 'fail') {
    const error = asRecord(record.error);
    if (!error || typeof error.code !== 'string' || error.code.trim().length === 0) {
      return { ok: false, message: 'error.code is required' };
    }
    if (error.message !== undefined && typeof error.message !== 'string') {
      return { ok: false, message: 'error.message must be a string' };
    }
    return {
      ok: true,
      value: {
        action,
        error: {
          code: error.code.trim(),
          ...(typeof error.message === 'string' && error.message.trim().length > 0
            ? { message: error.message.trim() }
            : {}),
        },
      },
    };
  }
  return {
    ok: false,
    message: 'action must be one of attach-render, progress, complete, fail, retry, cancel',
  };
}

export interface ParsedProgramInput {
  name?: string;
  code?: string | null;
  description?: string | null;
  status?: CurriculumProgramStatus;
}

export function parseProgramInput(
  body: unknown,
  options: { requireName: boolean },
): ParseResult<ParsedProgramInput> {
  const record = asRecord(body);
  if (!record) return { ok: false, message: 'request body must be a JSON object' };
  const value: ParsedProgramInput = {};
  const name = record.name;
  if (name !== undefined) {
    if (typeof name !== 'string' || name.trim().length === 0) {
      return { ok: false, message: 'name must be a non-empty string' };
    }
    value.name = name.trim();
  } else if (options.requireName) {
    return { ok: false, message: 'name is required' };
  }
  for (const key of ['code', 'description'] as const) {
    const parsed = readOptionalText(record, key);
    if (isParseFailure(parsed)) return parsed;
    if (parsed !== undefined) value[key] = parsed;
  }
  if ('status' in record) {
    const status = record.status;
    if (!CURRICULUM_PROGRAM_STATUSES.includes(status as CurriculumProgramStatus)) {
      return {
        ok: false,
        message: `status must be one of ${CURRICULUM_PROGRAM_STATUSES.join(', ')}`,
      };
    }
    value.status = status as CurriculumProgramStatus;
  }
  return { ok: true, value };
}

export interface ParsedProgramVersionInput {
  programId?: string;
  name?: string;
  version?: string | null;
  gradeYear?: string | null;
  description?: string | null;
  status?: CurriculumProgramStatus;
  targetCredits?: number | null;
}

export function parseProgramVersionInput(
  body: unknown,
  options: { requireProgramId: boolean; requireName: boolean },
): ParseResult<ParsedProgramVersionInput> {
  const record = asRecord(body);
  if (!record) return { ok: false, message: 'request body must be a JSON object' };
  const value: ParsedProgramVersionInput = {};
  const programId = record.programId;
  if (programId !== undefined) {
    if (typeof programId !== 'string' || programId.trim().length === 0) {
      return { ok: false, message: 'programId must be a non-empty string' };
    }
    value.programId = programId.trim();
  } else if (options.requireProgramId) {
    return { ok: false, message: 'programId is required' };
  }
  const name = record.name;
  if (name !== undefined) {
    if (typeof name !== 'string' || name.trim().length === 0) {
      return { ok: false, message: 'name must be a non-empty string' };
    }
    value.name = name.trim();
  } else if (options.requireName) {
    return { ok: false, message: 'name is required' };
  }
  for (const key of ['version', 'gradeYear', 'description'] as const) {
    const parsed = readOptionalText(record, key);
    if (isParseFailure(parsed)) return parsed;
    if (parsed !== undefined) value[key] = parsed;
  }
  if ('status' in record) {
    const status = record.status;
    if (!CURRICULUM_PROGRAM_STATUSES.includes(status as CurriculumProgramStatus)) {
      return {
        ok: false,
        message: `status must be one of ${CURRICULUM_PROGRAM_STATUSES.join(', ')}`,
      };
    }
    value.status = status as CurriculumProgramStatus;
  }
  const targetCredits = readOptionalNumber(record, 'targetCredits');
  if (isParseFailure(targetCredits)) return targetCredits;
  if (targetCredits !== undefined) value.targetCredits = targetCredits;
  return { ok: true, value };
}

export interface ParsedGraduationIndicatorInput {
  programVersionId?: string;
  code?: string;
  title?: string;
  description?: string | null;
  targetWeight?: number;
  sortOrder?: number;
}

export function parseGraduationIndicatorInput(
  body: unknown,
  options: { requireProgramVersionId: boolean; requireCode: boolean; requireTitle: boolean },
): ParseResult<ParsedGraduationIndicatorInput> {
  const record = asRecord(body);
  if (!record) return { ok: false, message: 'request body must be a JSON object' };
  const value: ParsedGraduationIndicatorInput = {};
  const programVersionId = record.programVersionId;
  if (programVersionId !== undefined) {
    if (typeof programVersionId !== 'string' || programVersionId.trim().length === 0) {
      return { ok: false, message: 'programVersionId must be a non-empty string' };
    }
    value.programVersionId = programVersionId.trim();
  } else if (options.requireProgramVersionId) {
    return { ok: false, message: 'programVersionId is required' };
  }
  for (const key of ['code', 'title'] as const) {
    const valueAtKey = record[key];
    if (valueAtKey !== undefined) {
      if (typeof valueAtKey !== 'string' || valueAtKey.trim().length === 0) {
        return { ok: false, message: `${key} must be a non-empty string` };
      }
      value[key] = valueAtKey.trim();
    } else if (
      (key === 'code' && options.requireCode) ||
      (key === 'title' && options.requireTitle)
    ) {
      return { ok: false, message: `${key} is required` };
    }
  }
  const description = readOptionalText(record, 'description');
  if (isParseFailure(description)) return description;
  if (description !== undefined) value.description = description;
  const targetWeight = readOptionalNumber(record, 'targetWeight');
  if (isParseFailure(targetWeight)) return targetWeight;
  if (targetWeight !== undefined) {
    if (
      targetWeight === null ||
      !Number.isInteger(targetWeight) ||
      targetWeight < 1 ||
      targetWeight > 10
    ) {
      return { ok: false, message: 'targetWeight must be an integer between 1 and 10' };
    }
    value.targetWeight = targetWeight;
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

export interface ParsedProgramCourseInput {
  programVersionId?: string;
  courseId?: string | null;
  title?: string | null;
  code?: string | null;
  semester?: string | null;
  category?: CurriculumProgramCourseCategory;
  credits?: number | null;
  hours?: number | null;
  sortOrder?: number;
  note?: string | null;
}

export function parseProgramCourseInput(
  body: unknown,
  options: { requireProgramVersionId: boolean },
): ParseResult<ParsedProgramCourseInput> {
  const record = asRecord(body);
  if (!record) return { ok: false, message: 'request body must be a JSON object' };
  const value: ParsedProgramCourseInput = {};
  const programVersionId = record.programVersionId;
  if (programVersionId !== undefined) {
    if (typeof programVersionId !== 'string' || programVersionId.trim().length === 0) {
      return { ok: false, message: 'programVersionId must be a non-empty string' };
    }
    value.programVersionId = programVersionId.trim();
  } else if (options.requireProgramVersionId) {
    return { ok: false, message: 'programVersionId is required' };
  }
  const courseId = readOptionalText(record, 'courseId');
  if (isParseFailure(courseId)) return courseId;
  if (courseId !== undefined) value.courseId = courseId;
  for (const key of ['title', 'code', 'semester', 'note'] as const) {
    const parsed = readOptionalText(record, key);
    if (isParseFailure(parsed)) return parsed;
    if (parsed !== undefined) {
      if (key === 'title' && parsed !== null && parsed.trim().length === 0) {
        return { ok: false, message: 'title must be a non-empty string or null' };
      }
      value[key] = parsed;
    }
  }
  if ('category' in record) {
    const category = record.category;
    if (
      !CURRICULUM_PROGRAM_COURSE_CATEGORIES.includes(category as CurriculumProgramCourseCategory)
    ) {
      return {
        ok: false,
        message: `category must be one of ${CURRICULUM_PROGRAM_COURSE_CATEGORIES.join(', ')}`,
      };
    }
    value.category = category as CurriculumProgramCourseCategory;
  }
  for (const key of ['credits', 'hours'] as const) {
    const parsed = readOptionalNumber(record, key);
    if (isParseFailure(parsed)) return parsed;
    if (parsed !== undefined) value[key] = parsed;
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

export interface ParsedCourseIndicatorSupportsInput {
  supports: Array<{ indicatorId: string; weight: number; note?: string | null }>;
}

export function parseCourseIndicatorSupportsInput(
  body: unknown,
): ParseResult<ParsedCourseIndicatorSupportsInput> {
  const record = asRecord(body);
  if (!record) return { ok: false, message: 'request body must be a JSON object' };
  const rawSupports = record.supports;
  if (!Array.isArray(rawSupports)) return { ok: false, message: 'supports must be an array' };
  const seen = new Set<string>();
  const supports: ParsedCourseIndicatorSupportsInput['supports'] = [];
  for (const rawSupport of rawSupports) {
    const support = asRecord(rawSupport);
    if (!support) return { ok: false, message: 'each support must be a JSON object' };
    if (typeof support.indicatorId !== 'string' || support.indicatorId.trim().length === 0) {
      return { ok: false, message: 'indicatorId is required for each support' };
    }
    const indicatorId = support.indicatorId.trim();
    if (seen.has(indicatorId)) {
      return { ok: false, message: 'indicatorId must not be duplicated' };
    }
    seen.add(indicatorId);
    const weight = readOptionalNumber(support, 'weight');
    if (isParseFailure(weight)) return weight;
    if (
      weight === undefined ||
      weight === null ||
      !Number.isInteger(weight) ||
      weight < 0 ||
      weight > 5
    ) {
      return { ok: false, message: 'weight must be an integer between 0 and 5' };
    }
    const note = readOptionalText(support, 'note');
    if (isParseFailure(note)) return note;
    supports.push({ indicatorId, weight, note: note === undefined ? undefined : note });
  }
  return { ok: true, value: { supports } };
}

export interface ParsedProgramPlanImportInput {
  document: ProgramPlanExportFile;
  mode: 'create' | 'replace';
  programId: string | null;
  programVersionId: string | null;
}

/**
 * Import body for a program plan. `create` always creates a new version
 * (under the selected or imported program); `replace` rewrites the selected
 * version after deleting its indicators, planned courses and support matrix.
 */
export function parseProgramPlanImportInput(
  body: unknown,
): ParseResult<ParsedProgramPlanImportInput> {
  const record = asRecord(body);
  if (!record) return { ok: false, message: 'request body must be a JSON object' };
  const document = parseProgramPlanExportDocument(record.document);
  if (!document.ok) return { ok: false, message: document.message };

  const mode = record.mode ?? 'create';
  if (mode !== 'create' && mode !== 'replace') {
    return { ok: false, message: 'mode must be one of create, replace' };
  }

  const rawProgramId = readOptionalText(record, 'programId');
  if (isParseFailure(rawProgramId)) return rawProgramId;
  const rawProgramVersionId = readOptionalText(record, 'programVersionId');
  if (isParseFailure(rawProgramVersionId)) return rawProgramVersionId;
  const programId =
    typeof rawProgramId === 'string' && rawProgramId.trim().length > 0 ? rawProgramId.trim() : null;
  const programVersionId =
    typeof rawProgramVersionId === 'string' && rawProgramVersionId.trim().length > 0
      ? rawProgramVersionId.trim()
      : null;

  if (mode === 'replace' && !programVersionId) {
    return { ok: false, message: 'programVersionId is required when mode is replace' };
  }
  if (mode === 'create' && programVersionId) {
    return { ok: false, message: 'programVersionId is only allowed when mode is replace' };
  }

  return {
    ok: true,
    value: {
      document: document.value,
      mode,
      programId,
      programVersionId,
    },
  };
}
