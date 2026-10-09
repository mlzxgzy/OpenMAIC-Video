/**
 * Versioned JSON import/export for the program-plan layer. The export is a
 * portable, human-readable snapshot of one program version: its metadata, its
 * graduation indicators, its planned courses and the course→indicator support
 * matrix. Supports reference indicators by `code`, because database ids are
 * owner-local and must not leak into a file that may be shared between users
 * or restored onto another database.
 *
 * The parser is deliberately strict: an import file is a write instruction,
 * so every field that can affect the resulting plan is validated before the
 * store is touched.
 */
import {
  CURRICULUM_PROGRAM_COURSE_CATEGORIES,
  CURRICULUM_PROGRAM_STATUSES,
  type CourseIndicatorSupportRecord,
  type CurriculumProgramCourseCategory,
  type CurriculumProgramRecord,
  type CurriculumProgramStatus,
  type CurriculumProgramVersionRecord,
  type CurriculumSnapshot,
} from '@/lib/curriculum/types';

export const PROGRAM_PLAN_EXPORT_KIND = 'openmaic.curriculum.program-plan';
export const PROGRAM_PLAN_EXPORT_VERSION = 1;

export interface ProgramPlanExportIndicator {
  code: string;
  title: string;
  description: string | null;
  targetWeight: number;
  sortOrder: number;
}

export interface ProgramPlanExportSupport {
  indicatorCode: string;
  weight: number;
  note: string | null;
}

export interface ProgramPlanExportCourse {
  courseId: string | null;
  courseCode: string | null;
  title: string;
  code: string | null;
  semester: string | null;
  category: CurriculumProgramCourseCategory;
  credits: number | null;
  hours: number | null;
  sortOrder: number;
  note: string | null;
  supports: ProgramPlanExportSupport[];
}

export interface ProgramPlanExportFile {
  kind: typeof PROGRAM_PLAN_EXPORT_KIND;
  version: typeof PROGRAM_PLAN_EXPORT_VERSION;
  exportedAt: string;
  program: Pick<CurriculumProgramRecord, 'name' | 'code' | 'description' | 'status'>;
  programVersion: Pick<
    CurriculumProgramVersionRecord,
    'name' | 'version' | 'gradeYear' | 'description' | 'status' | 'targetCredits'
  >;
  indicators: ProgramPlanExportIndicator[];
  courses: ProgramPlanExportCourse[];
  meta: {
    indicatorCount: number;
    courseCount: number;
    supportCount: number;
  };
}

export type ProgramIoParseResult<T> = { ok: true; value: T } | { ok: false; message: string };

class ProgramIoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProgramIoError';
  }
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProgramIoError(`${field} 必须是 JSON 对象`);
  }
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ProgramIoError(`${field} 必须是非空字符串`);
  }
  return value.trim();
}

function optionalText(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new ProgramIoError(`${field} 必须是字符串或 null`);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

interface NumberOptions {
  integer?: boolean;
  min?: number;
  max?: number;
  fallback?: number | null;
}

function optionalNumber(value: unknown, field: string, options: NumberOptions = {}): number | null {
  if (value === undefined || value === null) return options.fallback ?? null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ProgramIoError(`${field} 必须是有限数字或 null`);
  }
  if (options.integer && !Number.isInteger(value)) {
    throw new ProgramIoError(`${field} 必须是整数`);
  }
  if (options.min !== undefined && value < options.min) {
    throw new ProgramIoError(`${field} 必须 >= ${options.min}`);
  }
  if (options.max !== undefined && value > options.max) {
    throw new ProgramIoError(`${field} 必须 <= ${options.max}`);
  }
  return value;
}

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
  fallback: T,
): T {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new ProgramIoError(`${field} 只能是以下之一：${allowed.join(', ')}`);
  }
  return value as T;
}

function supportCount(courses: ProgramPlanExportCourse[]): number {
  return courses.reduce((sum, course) => sum + course.supports.length, 0);
}

/**
 * Build a deterministic export document for one program version. Returns null
 * when the version or its program is not present in the supplied snapshot.
 */
export function buildProgramPlanExport(
  snapshot: CurriculumSnapshot,
  programVersionId: string,
  exportedAt = new Date().toISOString(),
): ProgramPlanExportFile | null {
  const version = snapshot.programVersions.find((item) => item.id === programVersionId);
  if (!version) return null;
  const program = snapshot.programs.find((item) => item.id === version.programId);
  if (!program) return null;

  const indicators = snapshot.graduationIndicators
    .filter((indicator) => indicator.programVersionId === version.id)
    .sort((left, right) => left.sortOrder - right.sortOrder || left.code.localeCompare(right.code));
  const indicatorById = new Map(indicators.map((indicator) => [indicator.id, indicator]));

  const programCourses = snapshot.programCourses
    .filter((course) => course.programVersionId === version.id)
    .sort(
      (left, right) => left.sortOrder - right.sortOrder || left.title.localeCompare(right.title),
    );
  const supportsByProgramCourse = new Map<string, CourseIndicatorSupportRecord[]>();
  for (const support of snapshot.courseIndicatorSupports) {
    if (support.programVersionId !== version.id) continue;
    const list = supportsByProgramCourse.get(support.programCourseId);
    if (list) list.push(support);
    else supportsByProgramCourse.set(support.programCourseId, [support]);
  }
  const courseById = new Map(snapshot.courses.map((course) => [course.id, course]));

  const courses = programCourses.map((programCourse): ProgramPlanExportCourse => {
    const linkedCourse = programCourse.courseId
      ? courseById.get(programCourse.courseId)
      : undefined;
    const supports = (supportsByProgramCourse.get(programCourse.id) ?? [])
      .map((support): ProgramPlanExportSupport | null => {
        const indicator = indicatorById.get(support.indicatorId);
        if (!indicator) return null;
        return {
          indicatorCode: indicator.code,
          weight: support.weight,
          note: support.note,
        };
      })
      .filter((support): support is ProgramPlanExportSupport => support !== null)
      .sort((left, right) => left.indicatorCode.localeCompare(right.indicatorCode));

    return {
      courseId: linkedCourse?.id ?? null,
      courseCode: linkedCourse?.code ?? programCourse.code,
      title: programCourse.title,
      code: programCourse.code,
      semester: programCourse.semester,
      category: programCourse.category,
      credits: programCourse.credits,
      hours: programCourse.hours,
      sortOrder: programCourse.sortOrder,
      note: programCourse.note,
      supports,
    };
  });

  return {
    kind: PROGRAM_PLAN_EXPORT_KIND,
    version: PROGRAM_PLAN_EXPORT_VERSION,
    exportedAt,
    program: {
      name: program.name,
      code: program.code,
      description: program.description,
      status: program.status,
    },
    programVersion: {
      name: version.name,
      version: version.version,
      gradeYear: version.gradeYear,
      description: version.description,
      status: version.status,
      targetCredits: version.targetCredits,
    },
    indicators: indicators.map((indicator) => ({
      code: indicator.code,
      title: indicator.title,
      description: indicator.description,
      targetWeight: indicator.targetWeight,
      sortOrder: indicator.sortOrder,
    })),
    courses,
    meta: {
      indicatorCount: indicators.length,
      courseCount: courses.length,
      supportCount: supportCount(courses),
    },
  };
}

/** Parse and validate one exported program-plan JSON document. */
export function parseProgramPlanExportDocument(
  value: unknown,
): ProgramIoParseResult<ProgramPlanExportFile> {
  try {
    const root = asRecord(value, 'document');
    if (root.kind !== PROGRAM_PLAN_EXPORT_KIND) {
      throw new ProgramIoError(`kind 必须是 "${PROGRAM_PLAN_EXPORT_KIND}"`);
    }
    if (root.version !== PROGRAM_PLAN_EXPORT_VERSION) {
      throw new ProgramIoError(`version 必须是 ${PROGRAM_PLAN_EXPORT_VERSION}`);
    }

    const programRecord = asRecord(root.program, 'program');
    const program = {
      name: requiredText(programRecord.name, 'program.name'),
      code: optionalText(programRecord.code, 'program.code'),
      description: optionalText(programRecord.description, 'program.description'),
      status: enumValue(
        programRecord.status,
        CURRICULUM_PROGRAM_STATUSES,
        'program.status',
        'active' as CurriculumProgramStatus,
      ),
    };

    const versionRecord = asRecord(root.programVersion, 'programVersion');
    const programVersion = {
      name: requiredText(versionRecord.name, 'programVersion.name'),
      version: optionalText(versionRecord.version, 'programVersion.version'),
      gradeYear: optionalText(versionRecord.gradeYear, 'programVersion.gradeYear'),
      description: optionalText(versionRecord.description, 'programVersion.description'),
      status: enumValue(
        versionRecord.status,
        CURRICULUM_PROGRAM_STATUSES,
        'programVersion.status',
        'draft' as CurriculumProgramStatus,
      ),
      targetCredits: optionalNumber(versionRecord.targetCredits, 'programVersion.targetCredits', {
        min: 0,
        fallback: null,
      }),
    };

    const rawIndicators = root.indicators ?? [];
    if (!Array.isArray(rawIndicators)) {
      throw new ProgramIoError('indicators 必须是数组');
    }
    const indicatorCodes = new Set<string>();
    const indicators = rawIndicators.map((raw, index): ProgramPlanExportIndicator => {
      const record = asRecord(raw, `indicators[${index}]`);
      const code = requiredText(record.code, `indicators[${index}].code`);
      if (indicatorCodes.has(code)) {
        throw new ProgramIoError(`indicators[${index}].code 重复`);
      }
      indicatorCodes.add(code);
      return {
        code,
        title: requiredText(record.title, `indicators[${index}].title`),
        description: optionalText(record.description, `indicators[${index}].description`),
        targetWeight:
          optionalNumber(record.targetWeight, `indicators[${index}].targetWeight`, {
            integer: true,
            min: 1,
            max: 10,
            fallback: 3,
          }) ?? 3,
        sortOrder:
          optionalNumber(record.sortOrder, `indicators[${index}].sortOrder`, {
            integer: true,
            min: 0,
            fallback: 0,
          }) ?? 0,
      };
    });

    const rawCourses = root.courses ?? [];
    if (!Array.isArray(rawCourses)) {
      throw new ProgramIoError('courses 必须是数组');
    }
    const courseKeys = new Set<string>();
    const courses = rawCourses.map((raw, index): ProgramPlanExportCourse => {
      const record = asRecord(raw, `courses[${index}]`);
      const title = requiredText(record.title, `courses[${index}].title`);
      const courseId = optionalText(record.courseId, `courses[${index}].courseId`);
      const courseCode = optionalText(record.courseCode, `courses[${index}].courseCode`);
      const key = courseId ? `id:${courseId}` : `title:${title.toLowerCase()}`;
      if (courseKeys.has(key)) {
        throw new ProgramIoError(`courses[${index}] 与文件中的另一门课程重复`);
      }
      courseKeys.add(key);

      const rawSupports = record.supports ?? [];
      if (!Array.isArray(rawSupports)) {
        throw new ProgramIoError(`courses[${index}].supports 必须是数组`);
      }
      const supportKeys = new Set<string>();
      const supports = rawSupports.map((rawSupport, supportIndex): ProgramPlanExportSupport => {
        const support = asRecord(rawSupport, `courses[${index}].supports[${supportIndex}]`);
        const indicatorCode = requiredText(
          support.indicatorCode,
          `courses[${index}].supports[${supportIndex}].indicatorCode`,
        );
        if (!indicatorCodes.has(indicatorCode)) {
          throw new ProgramIoError(
            `courses[${index}].supports[${supportIndex}].indicatorCode 在 indicators 中不存在`,
          );
        }
        if (supportKeys.has(indicatorCode)) {
          throw new ProgramIoError(
            `courses[${index}].supports[${supportIndex}].indicatorCode 重复`,
          );
        }
        supportKeys.add(indicatorCode);
        return {
          indicatorCode,
          weight:
            optionalNumber(support.weight, `courses[${index}].supports[${supportIndex}].weight`, {
              integer: true,
              min: 0,
              max: 5,
              fallback: 1,
            }) ?? 1,
          note: optionalText(support.note, `courses[${index}].supports[${supportIndex}].note`),
        };
      });

      return {
        courseId,
        courseCode,
        title,
        code: optionalText(record.code, `courses[${index}].code`),
        semester: optionalText(record.semester, `courses[${index}].semester`),
        category: enumValue(
          record.category,
          CURRICULUM_PROGRAM_COURSE_CATEGORIES,
          `courses[${index}].category`,
          'required' as CurriculumProgramCourseCategory,
        ),
        credits: optionalNumber(record.credits, `courses[${index}].credits`, {
          min: 0,
          fallback: null,
        }),
        hours: optionalNumber(record.hours, `courses[${index}].hours`, {
          min: 0,
          fallback: null,
        }),
        sortOrder:
          optionalNumber(record.sortOrder, `courses[${index}].sortOrder`, {
            integer: true,
            min: 0,
            fallback: 0,
          }) ?? 0,
        note: optionalText(record.note, `courses[${index}].note`),
        supports,
      };
    });

    return {
      ok: true,
      value: {
        kind: PROGRAM_PLAN_EXPORT_KIND,
        version: PROGRAM_PLAN_EXPORT_VERSION,
        exportedAt:
          typeof root.exportedAt === 'string' ? root.exportedAt : new Date().toISOString(),
        program,
        programVersion,
        indicators,
        courses,
        meta: {
          indicatorCount: indicators.length,
          courseCount: courses.length,
          supportCount: supportCount(courses),
        },
      },
    };
  } catch (error) {
    if (error instanceof ProgramIoError) return { ok: false, message: error.message };
    throw error;
  }
}
