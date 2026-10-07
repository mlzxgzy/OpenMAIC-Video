/**
 * Program-version diff. Compares two versions inside one owner snapshot and
 * returns a structured, JSON-serializable report that both the API and the
 * `/curriculum` workspace can render without re-implementing matching rules.
 *
 * The report matches indicators by `code` and planned courses by a portable
 * key (`courseId` → effective course code → title). Matching by ids alone would
 * misreport an imported plan that intentionally only has a course code, while
 * matching by title alone would collapse two different courses that happen to
 * share a title.
 */
import type {
  CurriculumGraduationIndicatorRecord,
  CurriculumProgramCourseCategory,
  CurriculumProgramCourseRecord,
  CurriculumProgramVersionRecord,
  CurriculumSnapshot,
} from '@/lib/curriculum/types';

export type ProgramDiffChangeType = 'added' | 'removed' | 'changed';
export type ProgramVersionDiffChangeType = 'changed' | 'unchanged';
export type ProgramDiffValue = string | number | null;

export interface ProgramDiffFieldChange {
  field: string;
  label: string;
  before: ProgramDiffValue;
  after: ProgramDiffValue;
}

export interface ProgramVersionDiffSide {
  programId: string;
  programName: string;
  programCode: string | null;
  versionId: string;
  versionName: string;
  version: string | null;
  gradeYear: string | null;
  targetCredits: number | null;
}

export interface ProgramIndicatorValue {
  code: string;
  title: string;
  description: string | null;
  targetWeight: number;
  sortOrder: number;
}

export interface ProgramCourseValue {
  title: string;
  code: string | null;
  linkedCourseId: string | null;
  linkedCourseTitle: string | null;
  semester: string | null;
  category: CurriculumProgramCourseCategory;
  credits: number | null;
  hours: number | null;
  sortOrder: number;
  note: string | null;
}

export interface ProgramSupportValue {
  indicatorCode: string;
  indicatorTitle: string;
  weight: number;
  note: string | null;
}

export interface ProgramIndicatorDiff {
  key: string;
  code: string;
  title: string;
  change: ProgramDiffChangeType;
  before: ProgramIndicatorValue | null;
  after: ProgramIndicatorValue | null;
  fields: ProgramDiffFieldChange[];
}

export interface ProgramCourseSupportDiff {
  key: string;
  indicatorCode: string;
  indicatorTitle: string;
  change: ProgramDiffChangeType;
  before: ProgramSupportValue | null;
  after: ProgramSupportValue | null;
  fields: ProgramDiffFieldChange[];
}

export interface ProgramCourseDiff {
  key: string;
  title: string;
  change: ProgramDiffChangeType;
  before: ProgramCourseValue | null;
  after: ProgramCourseValue | null;
  fields: ProgramDiffFieldChange[];
  supports: ProgramCourseSupportDiff[];
}

export interface ProgramVersionMetadataDiff {
  change: ProgramVersionDiffChangeType;
  fields: ProgramDiffFieldChange[];
}

export interface ProgramDiffSummary {
  indicatorAddedCount: number;
  indicatorRemovedCount: number;
  indicatorChangedCount: number;
  indicatorUnchangedCount: number;
  courseAddedCount: number;
  courseRemovedCount: number;
  courseChangedCount: number;
  courseUnchangedCount: number;
  supportAddedCount: number;
  supportRemovedCount: number;
  supportChangedCount: number;
  supportUnchangedCount: number;
  totalChangeCount: number;
}

export interface ProgramVersionDiffReport {
  base: ProgramVersionDiffSide;
  target: ProgramVersionDiffSide;
  version: ProgramVersionMetadataDiff;
  summary: ProgramDiffSummary;
  indicators: ProgramIndicatorDiff[];
  courses: ProgramCourseDiff[];
}

interface ProgramCourseEntry {
  record: CurriculumProgramCourseRecord;
  value: ProgramCourseValue;
}

interface IndicatorDiffResult {
  indicators: ProgramIndicatorDiff[];
  added: number;
  removed: number;
  changed: number;
  unchanged: number;
}

interface CourseDiffResult {
  courses: ProgramCourseDiff[];
  added: number;
  removed: number;
  changed: number;
  unchanged: number;
  supportAdded: number;
  supportRemoved: number;
  supportChanged: number;
  supportUnchanged: number;
}

interface SupportDiffResult {
  supports: ProgramCourseSupportDiff[];
  added: number;
  removed: number;
  changed: number;
  unchanged: number;
}

function textValue(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function fieldChange(
  field: string,
  label: string,
  before: string | number | null | undefined,
  after: string | number | null | undefined,
): ProgramDiffFieldChange | null {
  const normalizedBefore = before ?? null;
  const normalizedAfter = after ?? null;
  if (normalizedBefore === normalizedAfter) return null;
  return { field, label, before: normalizedBefore, after: normalizedAfter };
}

function collectFields(changes: Array<ProgramDiffFieldChange | null>): ProgramDiffFieldChange[] {
  return changes.filter((change): change is ProgramDiffFieldChange => change !== null);
}

function indicatorValue(record: CurriculumGraduationIndicatorRecord): ProgramIndicatorValue {
  return {
    code: textValue(record.code) ?? record.code,
    title: textValue(record.title) ?? record.title,
    description: textValue(record.description),
    targetWeight: record.targetWeight,
    sortOrder: record.sortOrder,
  };
}

function diffIndicatorValues(
  before: ProgramIndicatorValue,
  after: ProgramIndicatorValue,
): ProgramDiffFieldChange[] {
  return collectFields([
    fieldChange('code', '指标点编号', before.code, after.code),
    fieldChange('title', '指标点描述', before.title, after.title),
    fieldChange('description', '说明', before.description, after.description),
    fieldChange('targetWeight', '目标权重', before.targetWeight, after.targetWeight),
    fieldChange('sortOrder', '排序', before.sortOrder, after.sortOrder),
  ]);
}

function indicatorMap(
  snapshot: CurriculumSnapshot,
  programVersionId: string,
): Map<string, ProgramIndicatorValue> {
  const map = new Map<string, ProgramIndicatorValue>();
  for (const indicator of snapshot.graduationIndicators) {
    if (indicator.programVersionId !== programVersionId) continue;
    const code = textValue(indicator.code);
    if (!code) continue;
    map.set(code.toLowerCase(), indicatorValue(indicator));
  }
  return map;
}

function linkedCourse(
  programCourse: CurriculumProgramCourseRecord,
  snapshot: CurriculumSnapshot,
): CurriculumSnapshot['courses'][number] | undefined {
  if (!programCourse.courseId) return undefined;
  return snapshot.courses.find((course) => course.id === programCourse.courseId);
}

function courseKey(
  programCourse: CurriculumProgramCourseRecord,
  snapshot: CurriculumSnapshot,
): string {
  if (programCourse.courseId) return `id:${programCourse.courseId}`;
  const linked = linkedCourse(programCourse, snapshot);
  const code = textValue(programCourse.code) ?? textValue(linked?.code);
  if (code) return `code:${code.toLowerCase()}`;
  return `title:${(textValue(programCourse.title) ?? programCourse.title).toLowerCase()}`;
}

function courseValue(
  programCourse: CurriculumProgramCourseRecord,
  snapshot: CurriculumSnapshot,
): ProgramCourseValue {
  const linked = linkedCourse(programCourse, snapshot);
  return {
    title: textValue(programCourse.title) ?? programCourse.title,
    code: textValue(programCourse.code) ?? textValue(linked?.code),
    linkedCourseId: programCourse.courseId,
    linkedCourseTitle: textValue(linked?.title),
    semester: textValue(programCourse.semester),
    category: programCourse.category,
    credits: programCourse.credits,
    hours: programCourse.hours,
    sortOrder: programCourse.sortOrder,
    note: textValue(programCourse.note),
  };
}

function linkedCourseLabel(value: ProgramCourseValue): ProgramDiffValue {
  if (!value.linkedCourseId) return null;
  const label = value.linkedCourseTitle ?? value.linkedCourseId;
  return `${label} · ${value.linkedCourseId}`;
}

function diffCourseValues(
  before: ProgramCourseValue,
  after: ProgramCourseValue,
): ProgramDiffFieldChange[] {
  return collectFields([
    fieldChange('title', '课程名称', before.title, after.title),
    fieldChange('code', '课程编号', before.code, after.code),
    fieldChange('linkedCourse', '关联课程', linkedCourseLabel(before), linkedCourseLabel(after)),
    fieldChange('semester', '学期', before.semester, after.semester),
    fieldChange('category', '课程类别', before.category, after.category),
    fieldChange('credits', '学分', before.credits, after.credits),
    fieldChange('hours', '学时', before.hours, after.hours),
    fieldChange('sortOrder', '排序', before.sortOrder, after.sortOrder),
    fieldChange('note', '备注', before.note, after.note),
  ]);
}

function courseMap(
  snapshot: CurriculumSnapshot,
  programVersionId: string,
): Map<string, ProgramCourseEntry> {
  const map = new Map<string, ProgramCourseEntry>();
  for (const programCourse of snapshot.programCourses) {
    if (programCourse.programVersionId !== programVersionId) continue;
    const key = courseKey(programCourse, snapshot);
    if (!map.has(key))
      map.set(key, { record: programCourse, value: courseValue(programCourse, snapshot) });
  }
  return map;
}

function supportMap(
  snapshot: CurriculumSnapshot,
  programVersionId: string,
): Map<string, Map<string, ProgramSupportValue>> {
  const indicatorById = new Map<string, CurriculumGraduationIndicatorRecord>();
  for (const indicator of snapshot.graduationIndicators) {
    if (indicator.programVersionId === programVersionId) indicatorById.set(indicator.id, indicator);
  }

  const programCourseKeys = new Map<string, string>();
  for (const programCourse of snapshot.programCourses) {
    if (programCourse.programVersionId === programVersionId) {
      programCourseKeys.set(programCourse.id, courseKey(programCourse, snapshot));
    }
  }

  const map = new Map<string, Map<string, ProgramSupportValue>>();
  for (const support of snapshot.courseIndicatorSupports) {
    if (support.programVersionId !== programVersionId) continue;
    const courseKeyValue = programCourseKeys.get(support.programCourseId);
    if (!courseKeyValue) continue;
    const indicator = indicatorById.get(support.indicatorId);
    if (!indicator) continue;
    const code = textValue(indicator.code);
    if (!code) continue;

    const courseSupports = map.get(courseKeyValue) ?? new Map<string, ProgramSupportValue>();
    courseSupports.set(code.toLowerCase(), {
      indicatorCode: code,
      indicatorTitle: textValue(indicator.title) ?? indicator.title,
      weight: support.weight,
      note: textValue(support.note),
    });
    map.set(courseKeyValue, courseSupports);
  }
  return map;
}

function diffSupportMaps(
  beforeMap: Map<string, ProgramSupportValue> | undefined,
  afterMap: Map<string, ProgramSupportValue> | undefined,
): SupportDiffResult {
  const supports: ProgramCourseSupportDiff[] = [];
  let added = 0;
  let removed = 0;
  let changed = 0;
  let unchanged = 0;
  const keys = new Set([...(beforeMap?.keys() ?? []), ...(afterMap?.keys() ?? [])]);

  for (const key of [...keys].sort((left, right) => left.localeCompare(right))) {
    const before = beforeMap?.get(key) ?? null;
    const after = afterMap?.get(key) ?? null;
    if (before && after) {
      const fields = collectFields([
        fieldChange('weight', '支撑权重', before.weight, after.weight),
        fieldChange('note', '备注', before.note, after.note),
      ]);
      if (fields.length > 0) {
        changed += 1;
        supports.push({
          key,
          indicatorCode: after.indicatorCode,
          indicatorTitle: after.indicatorTitle,
          change: 'changed',
          before,
          after,
          fields,
        });
      } else {
        unchanged += 1;
      }
      continue;
    }
    if (after) {
      added += 1;
      supports.push({
        key,
        indicatorCode: after.indicatorCode,
        indicatorTitle: after.indicatorTitle,
        change: 'added',
        before: null,
        after,
        fields: [],
      });
      continue;
    }
    if (before) {
      removed += 1;
      supports.push({
        key,
        indicatorCode: before.indicatorCode,
        indicatorTitle: before.indicatorTitle,
        change: 'removed',
        before,
        after: null,
        fields: [],
      });
    }
  }

  return { supports, added, removed, changed, unchanged };
}

function diffIndicators(
  snapshot: CurriculumSnapshot,
  baseVersionId: string,
  targetVersionId: string,
): IndicatorDiffResult {
  const beforeMap = indicatorMap(snapshot, baseVersionId);
  const afterMap = indicatorMap(snapshot, targetVersionId);
  const indicators: ProgramIndicatorDiff[] = [];
  let added = 0;
  let removed = 0;
  let changed = 0;
  let unchanged = 0;
  const keys = new Set([...beforeMap.keys(), ...afterMap.keys()]);

  for (const key of [...keys].sort((left, right) => left.localeCompare(right))) {
    const before = beforeMap.get(key) ?? null;
    const after = afterMap.get(key) ?? null;
    if (before && after) {
      const fields = diffIndicatorValues(before, after);
      if (fields.length > 0) {
        changed += 1;
        indicators.push({
          key,
          code: after.code,
          title: after.title,
          change: 'changed',
          before,
          after,
          fields,
        });
      } else {
        unchanged += 1;
      }
      continue;
    }
    if (after) {
      added += 1;
      indicators.push({
        key,
        code: after.code,
        title: after.title,
        change: 'added',
        before: null,
        after,
        fields: [],
      });
      continue;
    }
    if (before) {
      removed += 1;
      indicators.push({
        key,
        code: before.code,
        title: before.title,
        change: 'removed',
        before,
        after: null,
        fields: [],
      });
    }
  }

  return { indicators, added, removed, changed, unchanged };
}

function diffCourses(
  snapshot: CurriculumSnapshot,
  baseVersionId: string,
  targetVersionId: string,
): CourseDiffResult {
  const beforeCourses = courseMap(snapshot, baseVersionId);
  const afterCourses = courseMap(snapshot, targetVersionId);
  const beforeSupports = supportMap(snapshot, baseVersionId);
  const afterSupports = supportMap(snapshot, targetVersionId);
  const courses: ProgramCourseDiff[] = [];
  let added = 0;
  let removed = 0;
  let changed = 0;
  let unchanged = 0;
  let supportAdded = 0;
  let supportRemoved = 0;
  let supportChanged = 0;
  let supportUnchanged = 0;
  const keys = new Set([...beforeCourses.keys(), ...afterCourses.keys()]);

  for (const key of [...keys].sort((left, right) => left.localeCompare(right))) {
    const before = beforeCourses.get(key) ?? null;
    const after = afterCourses.get(key) ?? null;
    const supportDiff = diffSupportMaps(beforeSupports.get(key), afterSupports.get(key));
    supportAdded += supportDiff.added;
    supportRemoved += supportDiff.removed;
    supportChanged += supportDiff.changed;
    supportUnchanged += supportDiff.unchanged;

    if (before && after) {
      const fields = diffCourseValues(before.value, after.value);
      if (fields.length > 0 || supportDiff.supports.length > 0) {
        changed += 1;
        courses.push({
          key,
          title: after.value.title,
          change: 'changed',
          before: before.value,
          after: after.value,
          fields,
          supports: supportDiff.supports,
        });
      } else {
        unchanged += 1;
      }
      continue;
    }
    if (after) {
      added += 1;
      courses.push({
        key,
        title: after.value.title,
        change: 'added',
        before: null,
        after: after.value,
        fields: [],
        supports: supportDiff.supports,
      });
      continue;
    }
    if (before) {
      removed += 1;
      courses.push({
        key,
        title: before.value.title,
        change: 'removed',
        before: before.value,
        after: null,
        fields: [],
        supports: supportDiff.supports,
      });
    }
  }

  return {
    courses,
    added,
    removed,
    changed,
    unchanged,
    supportAdded,
    supportRemoved,
    supportChanged,
    supportUnchanged,
  };
}

function versionSide(
  snapshot: CurriculumSnapshot,
  version: CurriculumProgramVersionRecord,
): ProgramVersionDiffSide | null {
  const program = snapshot.programs.find((item) => item.id === version.programId);
  if (!program) return null;
  return {
    programId: program.id,
    programName: program.name,
    programCode: program.code,
    versionId: version.id,
    versionName: version.name,
    version: version.version,
    gradeYear: version.gradeYear,
    targetCredits: version.targetCredits,
  };
}

function diffVersionMetadata(
  before: CurriculumProgramVersionRecord,
  after: CurriculumProgramVersionRecord,
): ProgramVersionMetadataDiff {
  const fields = collectFields([
    fieldChange('name', '版本名称', before.name, after.name),
    fieldChange('version', '版号', before.version, after.version),
    fieldChange('gradeYear', '年级', before.gradeYear, after.gradeYear),
    fieldChange('description', '说明', before.description, after.description),
    fieldChange('status', '状态', before.status, after.status),
    fieldChange('targetCredits', '目标学分', before.targetCredits, after.targetCredits),
  ]);
  return { change: fields.length > 0 ? 'changed' : 'unchanged', fields };
}

/**
 * Compare two program versions. Returns `null` when either version or its
 * owning program is not present in the supplied owner snapshot.
 */
export function buildProgramVersionDiff(
  snapshot: CurriculumSnapshot,
  baseVersionId: string,
  targetVersionId: string,
): ProgramVersionDiffReport | null {
  const baseVersion = snapshot.programVersions.find((version) => version.id === baseVersionId);
  const targetVersion = snapshot.programVersions.find((version) => version.id === targetVersionId);
  if (!baseVersion || !targetVersion) return null;
  const base = versionSide(snapshot, baseVersion);
  const target = versionSide(snapshot, targetVersion);
  if (!base || !target) return null;

  const version = diffVersionMetadata(baseVersion, targetVersion);
  const indicatorResult = diffIndicators(snapshot, baseVersionId, targetVersionId);
  const courseResult = diffCourses(snapshot, baseVersionId, targetVersionId);
  const totalChangeCount =
    indicatorResult.added +
    indicatorResult.removed +
    indicatorResult.changed +
    courseResult.added +
    courseResult.removed +
    courseResult.changed +
    courseResult.supportAdded +
    courseResult.supportRemoved +
    courseResult.supportChanged +
    (version.change === 'changed' ? 1 : 0);

  return {
    base,
    target,
    version,
    summary: {
      indicatorAddedCount: indicatorResult.added,
      indicatorRemovedCount: indicatorResult.removed,
      indicatorChangedCount: indicatorResult.changed,
      indicatorUnchangedCount: indicatorResult.unchanged,
      courseAddedCount: courseResult.added,
      courseRemovedCount: courseResult.removed,
      courseChangedCount: courseResult.changed,
      courseUnchangedCount: courseResult.unchanged,
      supportAddedCount: courseResult.supportAdded,
      supportRemovedCount: courseResult.supportRemoved,
      supportChangedCount: courseResult.supportChanged,
      supportUnchangedCount: courseResult.supportUnchanged,
      totalChangeCount,
    },
    indicators: indicatorResult.indicators,
    courses: courseResult.courses,
  };
}
