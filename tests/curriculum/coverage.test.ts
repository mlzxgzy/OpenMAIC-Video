import { describe, expect, it } from 'vitest';

import { buildCurriculumCoverage } from '@/lib/curriculum/coverage';
import type { CourseKnowledgePointRecord } from '@/lib/curriculum/types';

function link(
  courseId: string,
  knowledgePointId: string,
  coverageLevel: CourseKnowledgePointRecord['coverageLevel'],
): CourseKnowledgePointRecord {
  return {
    courseId,
    knowledgePointId,
    coverageLevel,
    sortOrder: 0,
    note: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('buildCurriculumCoverage', () => {
  it('aggregates per-point and per-course coverage, including empty points', () => {
    const report = buildCurriculumCoverage({
      courses: [
        { id: 'course-1', seriesId: 'series-1' },
        { id: 'course-2', seriesId: 'series-1' },
      ],
      knowledgePoints: [
        { id: 'kp-1', seriesId: 'series-1' },
        { id: 'kp-2', seriesId: 'series-1' },
        { id: 'kp-3', seriesId: 'series-1' },
      ],
      courseKnowledgePoints: [
        link('course-1', 'kp-1', 'introduced'),
        link('course-2', 'kp-1', 'practiced'),
        link('course-1', 'kp-2', 'mastered'),
      ],
    });

    expect(report.totalKnowledgePointCount).toBe(3);
    expect(report.coveredKnowledgePointCount).toBe(2);
    expect(report.uncoveredKnowledgePointIds).toEqual(['kp-3']);

    const pointOne = report.knowledgePoints.find((item) => item.knowledgePointId === 'kp-1');
    expect(pointOne?.courseIds).toEqual(['course-1', 'course-2']);
    expect(pointOne?.coverageCountByLevel).toEqual({
      introduced: 1,
      practiced: 1,
      mastered: 0,
    });
    expect(pointOne?.highestCoverageLevel).toBe('practiced');

    const courseOne = report.courses.find((item) => item.courseId === 'course-1');
    expect(courseOne?.knowledgePointCount).toBe(2);
    expect(courseOne?.coverageCountByLevel).toEqual({
      introduced: 1,
      practiced: 0,
      mastered: 1,
    });
  });

  it('filters to one series and ignores duplicate course-point links', () => {
    const report = buildCurriculumCoverage({
      seriesId: 'series-2',
      courses: [
        { id: 'course-1', seriesId: 'series-1' },
        { id: 'course-2', seriesId: 'series-2' },
      ],
      knowledgePoints: [
        { id: 'kp-1', seriesId: 'series-1' },
        { id: 'kp-2', seriesId: 'series-2' },
      ],
      courseKnowledgePoints: [
        link('course-2', 'kp-2', 'introduced'),
        link('course-2', 'kp-2', 'introduced'),
        link('course-1', 'kp-1', 'mastered'),
      ],
    });

    expect(report.totalKnowledgePointCount).toBe(1);
    expect(report.coveredKnowledgePointCount).toBe(1);
    expect(report.knowledgePoints[0]?.coverageCount).toBe(1);
    expect(report.courses).toHaveLength(1);
  });
});
