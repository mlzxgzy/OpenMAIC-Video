/**
 * Program-plan coverage analysis. This is a pure function over the curriculum
 * snapshot: the UI and any future API report use the same definition of
 * credit coverage, indicator support gaps and knowledge-point redundancy.
 *
 * An indicator is a graduation requirement. A planned course supports it with
 * an integer weight; a weight sum below the indicator's target is a `weak`
 * point, zero is `missing`, and at or above target is `covered`.
 *
 * Knowledge points are scoped to the series that linked program courses belong
 * to. A point covered by more courses than `redundancyThreshold` is reported
 * as redundant, which helps a program author notice over-teaching rather than
 * silently accumulating duplicate course content.
 */
import type {
  CourseIndicatorSupportRecord,
  CourseKnowledgeCoverageLevel,
  CourseKnowledgePointRecord,
  CurriculumCourseRecord,
  CurriculumGraduationIndicatorRecord,
  CurriculumProgramCourseRecord,
  CurriculumProgramRecord,
  CurriculumProgramVersionRecord,
  KnowledgePointRecord,
} from '@/lib/curriculum/types';

export type ProgramIndicatorStatus = 'missing' | 'weak' | 'covered';

export interface ProgramCoverageInput {
  programVersionId: string;
  programs: readonly CurriculumProgramRecord[];
  programVersions: readonly CurriculumProgramVersionRecord[];
  graduationIndicators: readonly CurriculumGraduationIndicatorRecord[];
  programCourses: readonly CurriculumProgramCourseRecord[];
  courseIndicatorSupports: readonly CourseIndicatorSupportRecord[];
  courses: readonly Pick<
    CurriculumCourseRecord,
    'id' | 'seriesId' | 'title' | 'credits' | 'hours' | 'semester' | 'stageId' | 'status'
  >[];
  knowledgePoints: readonly Pick<KnowledgePointRecord, 'id' | 'seriesId' | 'name' | 'code'>[];
  courseKnowledgePoints: readonly CourseKnowledgePointRecord[];
  redundancyThreshold?: number;
}

export interface ProgramIndicatorSupport {
  programCourseId: string;
  courseId: string | null;
  courseTitle: string;
  weight: number;
  credits: number | null;
  semester: string | null;
}

export interface ProgramIndicatorCoverage {
  indicatorId: string;
  code: string;
  title: string;
  targetWeight: number;
  supportWeight: number;
  gapWeight: number;
  status: ProgramIndicatorStatus;
  supports: ProgramIndicatorSupport[];
  knowledgePointIds: string[];
  knowledgePointNames: string[];
}

export interface ProgramKnowledgePointCoverage {
  knowledgePointId: string;
  name: string;
  code: string | null;
  courseIds: string[];
  courseTitles: string[];
  highestCoverageLevel: CourseKnowledgeCoverageLevel | null;
  coverageCount: number;
}

export interface ProgramSemesterCoverage {
  semester: string;
  courseCount: number;
  credits: number;
}

export interface ProgramCoverageSummary {
  plannedCourseCount: number;
  linkedCourseCount: number;
  unlinkedCourseCount: number;
  unassignedProgramCourseIds: string[];
  duplicateCourseIds: string[];
  coursesWithoutIndicatorIds: string[];
  indicatorCount: number;
  missingIndicatorCount: number;
  weakIndicatorCount: number;
  coveredIndicatorCount: number;
  supportWeight: number;
  gapWeight: number;
  targetCredits: number | null;
  assignedCredits: number;
  missingCredits: number | null;
  creditCoverageRate: number | null;
  knowledgePointCount: number;
  coveredKnowledgePointCount: number;
  uncoveredKnowledgePointCount: number;
  redundantKnowledgePointCount: number;
}

export interface ProgramCoverageReport {
  programVersionId: string;
  programId: string;
  programName: string;
  programCode: string | null;
  versionName: string;
  version: string | null;
  gradeYear: string | null;
  status: CurriculumProgramVersionRecord['status'];
  summary: ProgramCoverageSummary;
  indicators: ProgramIndicatorCoverage[];
  knowledgePoints: ProgramKnowledgePointCoverage[];
  uncoveredKnowledgePoints: ProgramKnowledgePointCoverage[];
  redundantKnowledgePoints: ProgramKnowledgePointCoverage[];
  semesters: ProgramSemesterCoverage[];
}

const COVERAGE_RANK: Record<CourseKnowledgeCoverageLevel, number> = {
  introduced: 1,
  practiced: 2,
  mastered: 3,
};

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Build the program coverage report for one program version. Returns null when
 * the version does not exist in the supplied snapshot.
 */
export function buildProgramCoverage(input: ProgramCoverageInput): ProgramCoverageReport | null {
  const version = input.programVersions.find((item) => item.id === input.programVersionId);
  if (!version) return null;
  const program = input.programs.find((item) => item.id === version.programId);
  if (!program) return null;

  const courseById = new Map(input.courses.map((course) => [course.id, course]));
  const pointById = new Map(input.knowledgePoints.map((point) => [point.id, point]));
  const indicators = input.graduationIndicators
    .filter((indicator) => indicator.programVersionId === version.id)
    .sort((left, right) => left.sortOrder - right.sortOrder || left.code.localeCompare(right.code));
  const programCourses = input.programCourses
    .filter((course) => course.programVersionId === version.id)
    .sort(
      (left, right) => left.sortOrder - right.sortOrder || left.title.localeCompare(right.title),
    );
  const supports = input.courseIndicatorSupports.filter(
    (support) => support.programVersionId === version.id,
  );
  const linksByCourse = new Map<string, CourseKnowledgePointRecord[]>();
  for (const link of input.courseKnowledgePoints) {
    const links = linksByCourse.get(link.courseId);
    if (links) links.push(link);
    else linksByCourse.set(link.courseId, [link]);
  }

  const linkedProgramCourses: Array<{
    programCourse: CurriculumProgramCourseRecord;
    course: ProgramCoverageInput['courses'][number];
  }> = [];
  const unassignedProgramCourseIds: string[] = [];
  let assignedCredits = 0;
  const semesterMap = new Map<string, ProgramSemesterCoverage>();
  const courseIdUseCounts = new Map<string, number>();

  for (const programCourse of programCourses) {
    const course = programCourse.courseId ? courseById.get(programCourse.courseId) : undefined;
    if (!course) {
      unassignedProgramCourseIds.push(programCourse.id);
    } else {
      linkedProgramCourses.push({ programCourse, course });
      if (programCourse.courseId) {
        courseIdUseCounts.set(
          programCourse.courseId,
          (courseIdUseCounts.get(programCourse.courseId) ?? 0) + 1,
        );
      }
    }
    assignedCredits += programCourse.credits ?? course?.credits ?? 0;
    const semester = programCourse.semester?.trim() || '未安排';
    const existing = semesterMap.get(semester);
    const credits = programCourse.credits ?? course?.credits ?? 0;
    if (existing) {
      existing.courseCount += 1;
      existing.credits += credits;
    } else {
      semesterMap.set(semester, { semester, courseCount: 1, credits });
    }
  }

  const duplicateCourseIds = [...courseIdUseCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([courseId]) => courseId);

  const supportsByProgramCourse = new Map<string, CourseIndicatorSupportRecord[]>();
  for (const support of supports) {
    const list = supportsByProgramCourse.get(support.programCourseId);
    if (list) list.push(support);
    else supportsByProgramCourse.set(support.programCourseId, [support]);
  }

  const coursePointMap = new Map<
    string,
    {
      knowledgePointId: string;
      courseId: string;
      highestCoverageLevel: CourseKnowledgeCoverageLevel;
    }
  >();
  const coveredKnowledgePointIds = new Set<string>();
  const knowledgePointCourseIds = new Map<string, Set<string>>();

  for (const { programCourse, course } of linkedProgramCourses) {
    const links = linksByCourse.get(course.id) ?? [];
    for (const link of links) {
      if (!pointById.has(link.knowledgePointId)) continue;
      const key = `${course.id}:${link.knowledgePointId}`;
      const current = coursePointMap.get(key);
      if (
        !current ||
        COVERAGE_RANK[link.coverageLevel] > COVERAGE_RANK[current.highestCoverageLevel]
      ) {
        coursePointMap.set(key, {
          knowledgePointId: link.knowledgePointId,
          courseId: course.id,
          highestCoverageLevel: link.coverageLevel,
        });
      }
      coveredKnowledgePointIds.add(link.knowledgePointId);
      const courseIds = knowledgePointCourseIds.get(link.knowledgePointId);
      if (courseIds) courseIds.add(course.id);
      else knowledgePointCourseIds.set(link.knowledgePointId, new Set([course.id]));
    }
    // Keep the variable referenced for type narrowing and future per-course use.
    void programCourse;
  }

  const linkedSeriesIds = new Set(
    linkedProgramCourses
      .map(({ course }) => course.seriesId)
      .filter((seriesId): seriesId is string => Boolean(seriesId)),
  );
  const scopedKnowledgePoints = input.knowledgePoints.filter((point) =>
    point.seriesId ? linkedSeriesIds.has(point.seriesId) : false,
  );

  const knowledgePointCoverage: ProgramKnowledgePointCoverage[] = scopedKnowledgePoints.map(
    (point) => {
      const courseIds = [...(knowledgePointCourseIds.get(point.id) ?? [])];
      const courseTitles = courseIds
        .map((courseId) => courseById.get(courseId)?.title ?? null)
        .filter((title): title is string => Boolean(title));
      const relevantLinks = [...coursePointMap.values()].filter(
        (item) => item.knowledgePointId === point.id,
      );
      const highestCoverageLevel =
        relevantLinks.length === 0
          ? null
          : relevantLinks.reduce((best, item) =>
              COVERAGE_RANK[item.highestCoverageLevel] > COVERAGE_RANK[best.highestCoverageLevel]
                ? item
                : best,
            ).highestCoverageLevel;
      return {
        knowledgePointId: point.id,
        name: point.name,
        code: point.code,
        courseIds,
        courseTitles,
        highestCoverageLevel,
        coverageCount: courseIds.length,
      };
    },
  );

  const knowledgePointByCourseId = new Map<string, string[]>();
  for (const [knowledgePointId, courseIds] of knowledgePointCourseIds) {
    for (const courseId of courseIds) {
      const list = knowledgePointByCourseId.get(courseId);
      if (list) list.push(knowledgePointId);
      else knowledgePointByCourseId.set(courseId, [knowledgePointId]);
    }
  }

  const supportsByIndicator = new Map<string, CourseIndicatorSupportRecord[]>();
  for (const support of supports) {
    const list = supportsByIndicator.get(support.indicatorId);
    if (list) list.push(support);
    else supportsByIndicator.set(support.indicatorId, [support]);
  }

  const indicatorCoverage: ProgramIndicatorCoverage[] = indicators.map((indicator) => {
    const indicatorSupports = supportsByIndicator.get(indicator.id) ?? [];
    const supportDetails: ProgramIndicatorSupport[] = [];
    const knowledgePointIds = new Set<string>();
    let supportWeight = 0;

    for (const support of indicatorSupports) {
      const programCourse = programCourses.find((item) => item.id === support.programCourseId);
      if (!programCourse) continue;
      const course = programCourse.courseId ? courseById.get(programCourse.courseId) : undefined;
      supportWeight += support.weight;
      supportDetails.push({
        programCourseId: programCourse.id,
        courseId: course?.id ?? programCourse.courseId,
        courseTitle: course?.title ?? programCourse.title,
        weight: support.weight,
        credits: programCourse.credits ?? course?.credits ?? null,
        semester: programCourse.semester,
      });
      if (course) {
        for (const knowledgePointId of knowledgePointByCourseId.get(course.id) ?? []) {
          knowledgePointIds.add(knowledgePointId);
        }
      }
    }

    const status: ProgramIndicatorStatus =
      supportWeight <= 0 ? 'missing' : supportWeight >= indicator.targetWeight ? 'covered' : 'weak';
    return {
      indicatorId: indicator.id,
      code: indicator.code,
      title: indicator.title,
      targetWeight: indicator.targetWeight,
      supportWeight,
      gapWeight: Math.max(indicator.targetWeight - supportWeight, 0),
      status,
      supports: supportDetails,
      knowledgePointIds: [...knowledgePointIds],
      knowledgePointNames: [...knowledgePointIds]
        .map((knowledgePointId) => pointById.get(knowledgePointId)?.name ?? null)
        .filter((name): name is string => Boolean(name)),
    };
  });

  const coursesWithoutIndicatorIds = programCourses
    .filter((programCourse) => (supportsByProgramCourse.get(programCourse.id) ?? []).length === 0)
    .map((programCourse) => programCourse.id);

  const targetCredits = version.targetCredits;
  const missingCredits =
    targetCredits === null ? null : round(Math.max(targetCredits - assignedCredits, 0));
  const creditCoverageRate =
    targetCredits === null || targetCredits <= 0 ? null : round(assignedCredits / targetCredits);

  const redundancyThreshold = input.redundancyThreshold ?? 3;
  const uncoveredKnowledgePoints = knowledgePointCoverage.filter(
    (point) => point.coverageCount === 0,
  );
  const redundantKnowledgePoints = knowledgePointCoverage.filter(
    (point) => point.coverageCount > redundancyThreshold,
  );

  return {
    programVersionId: version.id,
    programId: program.id,
    programName: program.name,
    programCode: program.code,
    versionName: version.name,
    version: version.version,
    gradeYear: version.gradeYear,
    status: version.status,
    summary: {
      plannedCourseCount: programCourses.length,
      linkedCourseCount: linkedProgramCourses.length,
      unlinkedCourseCount: programCourses.length - linkedProgramCourses.length,
      unassignedProgramCourseIds,
      duplicateCourseIds,
      coursesWithoutIndicatorIds,
      indicatorCount: indicators.length,
      missingIndicatorCount: indicatorCoverage.filter((item) => item.status === 'missing').length,
      weakIndicatorCount: indicatorCoverage.filter((item) => item.status === 'weak').length,
      coveredIndicatorCount: indicatorCoverage.filter((item) => item.status === 'covered').length,
      supportWeight: round(indicatorCoverage.reduce((sum, item) => sum + item.supportWeight, 0)),
      gapWeight: round(indicatorCoverage.reduce((sum, item) => sum + item.gapWeight, 0)),
      targetCredits,
      assignedCredits: round(assignedCredits),
      missingCredits,
      creditCoverageRate,
      knowledgePointCount: knowledgePointCoverage.length,
      coveredKnowledgePointCount: knowledgePointCoverage.filter((item) => item.coverageCount > 0)
        .length,
      uncoveredKnowledgePointCount: uncoveredKnowledgePoints.length,
      redundantKnowledgePointCount: redundantKnowledgePoints.length,
    },
    indicators: indicatorCoverage,
    knowledgePoints: knowledgePointCoverage,
    uncoveredKnowledgePoints,
    redundantKnowledgePoints,
    semesters: [...semesterMap.values()].sort((left, right) =>
      left.semester.localeCompare(right.semester, 'zh-CN'),
    ),
  };
}
