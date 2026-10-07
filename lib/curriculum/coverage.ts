import type {
  CourseKnowledgeCoverageLevel,
  CourseKnowledgePointRecord,
  CurriculumCourseRecord,
  KnowledgePointRecord,
} from './types';

export type CoverageLevelCounts = Record<CourseKnowledgeCoverageLevel, number>;

export interface KnowledgePointCoverageRecord {
  knowledgePointId: string;
  courseIds: string[];
  coverageCountByLevel: CoverageLevelCounts;
  highestCoverageLevel: CourseKnowledgeCoverageLevel | null;
  coverageCount: number;
}

export interface CourseCoverageRecord {
  courseId: string;
  knowledgePointCount: number;
  coverageCountByLevel: CoverageLevelCounts;
}

export interface CurriculumCoverageReport {
  knowledgePoints: KnowledgePointCoverageRecord[];
  courses: CourseCoverageRecord[];
  uncoveredKnowledgePointIds: string[];
  coveredKnowledgePointCount: number;
  totalKnowledgePointCount: number;
}

interface BuildCoverageInput {
  courses: Pick<CurriculumCourseRecord, 'id' | 'seriesId'>[];
  knowledgePoints: Pick<KnowledgePointRecord, 'id' | 'seriesId'>[];
  courseKnowledgePoints: CourseKnowledgePointRecord[];
  seriesId?: string | null;
}

const COVERAGE_RANK: Record<CourseKnowledgeCoverageLevel, number> = {
  introduced: 1,
  practiced: 2,
  mastered: 3,
};

function emptyCoverageCounts(): CoverageLevelCounts {
  return { introduced: 0, practiced: 0, mastered: 0 };
}

/**
 * Build the owner-level or series-level coverage report from a curriculum
 * snapshot. The function is deliberately pure so the API and the client can
 * share exactly the same semantics: "coverage" is per course-point binding,
 * not per scene or per generated asset.
 */
export function buildCurriculumCoverage(input: BuildCoverageInput): CurriculumCoverageReport {
  const { seriesId } = input;
  const courses = input.courses.filter(
    (course) => seriesId === undefined || seriesId === null || course.seriesId === seriesId,
  );
  const courseIds = new Set(courses.map((course) => course.id));
  const knowledgePoints = input.knowledgePoints.filter(
    (point) => seriesId === undefined || seriesId === null || point.seriesId === seriesId,
  );
  const pointIds = new Set(knowledgePoints.map((point) => point.id));

  const pointCoverage = new Map<string, KnowledgePointCoverageRecord>();
  for (const point of knowledgePoints) {
    pointCoverage.set(point.id, {
      knowledgePointId: point.id,
      courseIds: [],
      coverageCountByLevel: emptyCoverageCounts(),
      highestCoverageLevel: null,
      coverageCount: 0,
    });
  }

  const courseCoverage = new Map<string, CourseCoverageRecord>();
  for (const course of courses) {
    courseCoverage.set(course.id, {
      courseId: course.id,
      knowledgePointCount: 0,
      coverageCountByLevel: emptyCoverageCounts(),
    });
  }

  const coursePointSeen = new Set<string>();
  for (const link of input.courseKnowledgePoints) {
    if (!courseIds.has(link.courseId) || !pointIds.has(link.knowledgePointId)) continue;
    const dedupeKey = `${link.courseId}:${link.knowledgePointId}`;
    if (coursePointSeen.has(dedupeKey)) continue;
    coursePointSeen.add(dedupeKey);

    const pointEntry = pointCoverage.get(link.knowledgePointId);
    const courseEntry = courseCoverage.get(link.courseId);
    if (!pointEntry || !courseEntry) continue;

    if (!pointEntry.courseIds.includes(link.courseId)) pointEntry.courseIds.push(link.courseId);
    pointEntry.coverageCount += 1;
    pointEntry.coverageCountByLevel[link.coverageLevel] += 1;
    if (
      pointEntry.highestCoverageLevel === null ||
      COVERAGE_RANK[link.coverageLevel] > COVERAGE_RANK[pointEntry.highestCoverageLevel]
    ) {
      pointEntry.highestCoverageLevel = link.coverageLevel;
    }

    courseEntry.knowledgePointCount += 1;
    courseEntry.coverageCountByLevel[link.coverageLevel] += 1;
  }

  const points = [...pointCoverage.values()];
  const uncoveredKnowledgePointIds = points
    .filter((point) => point.coverageCount === 0)
    .map((point) => point.knowledgePointId);

  return {
    knowledgePoints: points,
    courses: [...courseCoverage.values()],
    uncoveredKnowledgePointIds,
    coveredKnowledgePointCount: points.length - uncoveredKnowledgePointIds.length,
    totalKnowledgePointCount: points.length,
  };
}
