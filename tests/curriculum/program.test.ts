import { describe, expect, it } from 'vitest';

import { buildProgramCoverage } from '@/lib/curriculum/program';
import {
  parseCourseIndicatorSupportsInput,
  parseProgramInput,
} from '@/lib/server/curriculum/validation';
import type {
  CourseIndicatorSupportRecord,
  CourseKnowledgePointRecord,
  CurriculumGraduationIndicatorRecord,
  CurriculumProgramCourseRecord,
  CurriculumProgramRecord,
  CurriculumProgramVersionRecord,
} from '@/lib/curriculum/types';

const NOW = '2026-01-01T00:00:00.000Z';

function program(id: string, name: string): CurriculumProgramRecord {
  return {
    id,
    name,
    code: null,
    description: null,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function version(
  id: string,
  programId: string,
  overrides: Partial<CurriculumProgramVersionRecord> = {},
): CurriculumProgramVersionRecord {
  return {
    id,
    programId,
    name: '2026版',
    version: 'v1',
    gradeYear: '2026',
    description: null,
    status: 'active',
    targetCredits: 10,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function indicator(
  id: string,
  programVersionId: string,
  code: string,
  targetWeight = 3,
): CurriculumGraduationIndicatorRecord {
  return {
    id,
    programVersionId,
    code,
    title: `${code} 指标`,
    description: null,
    targetWeight,
    sortOrder: Number(code.split('-')[1] ?? 0),
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function programCourse(
  id: string,
  programVersionId: string,
  courseId: string | null,
  title: string,
  overrides: Partial<CurriculumProgramCourseRecord> = {},
): CurriculumProgramCourseRecord {
  return {
    id,
    programVersionId,
    courseId,
    title,
    code: null,
    semester: '2026春',
    category: 'required',
    credits: null,
    hours: null,
    sortOrder: 0,
    note: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function support(
  id: string,
  programVersionId: string,
  programCourseId: string,
  indicatorId: string,
  weight: number,
): CourseIndicatorSupportRecord {
  return {
    id,
    programVersionId,
    programCourseId,
    indicatorId,
    weight,
    note: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

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
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe('buildProgramCoverage', () => {
  it('aggregates credits, indicator gaps, missing courses and redundant points', () => {
    const report = buildProgramCoverage({
      programVersionId: 'version-1',
      programs: [program('program-1', '网络空间安全')],
      programVersions: [version('version-1', 'program-1')],
      graduationIndicators: [
        indicator('indicator-1', 'version-1', '1-1'),
        indicator('indicator-2', 'version-1', '1-2'),
        indicator('indicator-3', 'version-1', '1-3', 2),
      ],
      programCourses: [
        programCourse('pc-1', 'version-1', 'course-1', 'Web安全', { credits: 4, sortOrder: 0 }),
        programCourse('pc-2', 'version-1', 'course-2', '密码学', {
          credits: 3,
          semester: '2026秋',
          sortOrder: 1,
        }),
        programCourse('pc-3', 'version-1', null, '综合实训', { credits: 2, sortOrder: 2 }),
      ],
      courseIndicatorSupports: [
        support('s-1', 'version-1', 'pc-1', 'indicator-1', 3),
        support('s-2', 'version-1', 'pc-1', 'indicator-2', 1),
        support('s-3', 'version-1', 'pc-2', 'indicator-2', 2),
      ],
      courses: [
        {
          id: 'course-1',
          seriesId: 'series-1',
          title: 'Web安全',
          credits: 4,
          hours: 48,
          semester: '2026春',
          stageId: null,
          status: 'active',
        },
        {
          id: 'course-2',
          seriesId: 'series-1',
          title: '密码学',
          credits: 3,
          hours: 36,
          semester: '2026秋',
          stageId: null,
          status: 'active',
        },
      ],
      knowledgePoints: [
        { id: 'kp-1', seriesId: 'series-1', name: 'HTTP', code: 'KP-01' },
        { id: 'kp-2', seriesId: 'series-1', name: '注入', code: 'KP-02' },
        { id: 'kp-3', seriesId: 'series-1', name: '摘要算法', code: 'KP-03' },
        { id: 'kp-4', seriesId: 'series-1', name: '应急响应', code: 'KP-04' },
      ],
      courseKnowledgePoints: [
        link('course-1', 'kp-1', 'mastered'),
        link('course-1', 'kp-2', 'practiced'),
        link('course-2', 'kp-2', 'introduced'),
        link('course-2', 'kp-3', 'introduced'),
      ],
      redundancyThreshold: 1,
    });

    expect(report).not.toBeNull();
    if (!report) return;
    expect(report.summary).toMatchObject({
      plannedCourseCount: 3,
      linkedCourseCount: 2,
      unlinkedCourseCount: 1,
      assignedCredits: 9,
      targetCredits: 10,
      missingCredits: 1,
      creditCoverageRate: 0.9,
      missingIndicatorCount: 1,
      weakIndicatorCount: 0,
      coveredIndicatorCount: 2,
      uncoveredKnowledgePointCount: 1,
      redundantKnowledgePointCount: 1,
    });
    expect(report.summary.unassignedProgramCourseIds).toEqual(['pc-3']);
    expect(report.indicators.find((item) => item.indicatorId === 'indicator-1')?.status).toBe(
      'covered',
    );
    expect(report.indicators.find((item) => item.indicatorId === 'indicator-3')?.status).toBe(
      'missing',
    );
    expect(report.uncoveredKnowledgePoints.map((item) => item.knowledgePointId)).toEqual(['kp-4']);
    expect(report.redundantKnowledgePoints.map((item) => item.knowledgePointId)).toEqual(['kp-2']);
    expect(report.knowledgePoints.find((item) => item.knowledgePointId === 'kp-2')).toMatchObject({
      coverageCount: 2,
      courseIds: ['course-1', 'course-2'],
    });
  });

  it('reports weak indicators and filters another version out', () => {
    const report = buildProgramCoverage({
      programVersionId: 'version-1',
      programs: [program('program-1', '网络空间安全')],
      programVersions: [
        version('version-1', 'program-1'),
        version('version-2', 'program-1', { name: '2025版' }),
      ],
      graduationIndicators: [
        indicator('indicator-1', 'version-1', '1-1', 5),
        indicator('indicator-2', 'version-2', '2-1', 3),
      ],
      programCourses: [
        programCourse('pc-1', 'version-1', 'course-1', 'Web安全', { credits: 4 }),
        programCourse('pc-2', 'version-2', 'course-1', 'Web安全旧版', { credits: 4 }),
      ],
      courseIndicatorSupports: [support('s-1', 'version-1', 'pc-1', 'indicator-1', 2)],
      courses: [
        {
          id: 'course-1',
          seriesId: 'series-1',
          title: 'Web安全',
          credits: 4,
          hours: 48,
          semester: '2026春',
          stageId: null,
          status: 'active',
        },
      ],
      knowledgePoints: [{ id: 'kp-1', seriesId: 'series-1', name: 'HTTP', code: null }],
      courseKnowledgePoints: [link('course-1', 'kp-1', 'introduced')],
    });

    expect(report).not.toBeNull();
    if (!report) return;
    expect(report.indicators).toHaveLength(1);
    expect(report.indicators[0]).toMatchObject({
      indicatorId: 'indicator-1',
      supportWeight: 2,
      gapWeight: 3,
      status: 'weak',
    });
    expect(report.summary.weakIndicatorCount).toBe(1);
    expect(report.summary.coveredIndicatorCount).toBe(0);
  });

  it('returns null for an unknown program version', () => {
    expect(
      buildProgramCoverage({
        programVersionId: 'missing',
        programs: [],
        programVersions: [],
        graduationIndicators: [],
        programCourses: [],
        courseIndicatorSupports: [],
        courses: [],
        knowledgePoints: [],
        courseKnowledgePoints: [],
      }),
    ).toBeNull();
  });
});

describe('program plan validation', () => {
  it('normalizes a program name and rejects an empty one', () => {
    expect(parseProgramInput({ name: ' 网络空间安全 ' }, { requireName: true })).toEqual({
      ok: true,
      value: { name: '网络空间安全' },
    });
    expect(parseProgramInput({}, { requireName: true })).toEqual({
      ok: false,
      message: 'name 为必填',
    });
  });

  it('rejects duplicate or out-of-range indicator supports', () => {
    expect(
      parseCourseIndicatorSupportsInput({
        supports: [
          { indicatorId: 'indicator-1', weight: 3 },
          { indicatorId: 'indicator-1', weight: 1 },
        ],
      }),
    ).toEqual({ ok: false, message: 'indicatorId 不能重复' });

    expect(
      parseCourseIndicatorSupportsInput({
        supports: [{ indicatorId: 'indicator-1', weight: 9 }],
      }),
    ).toEqual({ ok: false, message: 'weight 必须是 0 到 5 之间的整数' });
  });
});
