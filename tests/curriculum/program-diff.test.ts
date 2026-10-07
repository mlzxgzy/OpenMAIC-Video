import { describe, expect, it } from 'vitest';

import { buildProgramVersionDiff } from '@/lib/curriculum/program-diff';
import type {
  CourseIndicatorSupportRecord,
  CurriculumGraduationIndicatorRecord,
  CurriculumProgramCourseRecord,
  CurriculumProgramRecord,
  CurriculumProgramVersionRecord,
  CurriculumSnapshot,
} from '@/lib/curriculum/types';
import { parseProgramVersionSyncInput } from '@/lib/server/curriculum/validation';

const NOW = '2026-01-01T00:00:00.000Z';

function program(): CurriculumProgramRecord {
  return {
    id: 'program-1',
    name: '网络空间安全',
    code: 'NIS',
    description: null,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function version(
  id: string,
  overrides: Partial<CurriculumProgramVersionRecord> = {},
): CurriculumProgramVersionRecord {
  return {
    id,
    programId: 'program-1',
    name: '2026版',
    version: 'v1',
    gradeYear: '2026',
    description: null,
    status: 'active',
    targetCredits: 12,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function indicator(
  id: string,
  programVersionId: string,
  code: string,
  title: string,
  targetWeight: number,
  sortOrder: number,
): CurriculumGraduationIndicatorRecord {
  return {
    id,
    programVersionId,
    code,
    title,
    description: null,
    targetWeight,
    sortOrder,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function programCourse(
  id: string,
  programVersionId: string,
  title: string,
  overrides: Partial<CurriculumProgramCourseRecord> = {},
): CurriculumProgramCourseRecord {
  return {
    id,
    programVersionId,
    courseId: null,
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

function snapshot(): CurriculumSnapshot {
  return {
    series: [],
    courses: [
      {
        id: 'course-1',
        seriesId: 'series-1',
        stageId: null,
        title: 'Web安全',
        code: 'CTF-WEB',
        description: null,
        chapter: null,
        section: null,
        lessonOrder: 1,
        credits: 3,
        hours: 32,
        semester: '2026春',
        status: 'active',
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    relations: [],
    knowledgePoints: [],
    courseKnowledgePoints: [],
    knowledgePointRelations: [],
    generationJobs: [],
    batches: [],
    batchItems: [],
    exportJobs: [],
    programs: [program()],
    programVersions: [
      version('version-1'),
      version('version-2', { targetCredits: 15, description: '新版' }),
    ],
    graduationIndicators: [
      indicator('i-1-1', 'version-1', '1-1', '工程知识', 3, 1),
      indicator('i-1-2', 'version-1', '1-2', '问题分析', 2, 2),
      indicator('t-1-1', 'version-2', '1-1', '工程知识', 4, 1),
      indicator('t-1-3', 'version-2', '1-3', '设计/开发解决方案', 3, 3),
    ],
    programCourses: [
      programCourse('pc-1', 'version-1', 'Web安全', {
        courseId: 'course-1',
        code: 'CTF-WEB',
        credits: 3,
        sortOrder: 1,
      }),
      programCourse('pc-2', 'version-1', '综合实训', {
        code: 'PRACTICE',
        credits: 2,
        sortOrder: 2,
      }),
      programCourse('pc-3', 'version-2', 'Web安全', {
        courseId: 'course-1',
        code: 'CTF-WEB',
        credits: 4,
        sortOrder: 1,
      }),
      programCourse('pc-4', 'version-2', '综合实训', {
        code: 'PRACTICE',
        credits: 2,
        sortOrder: 2,
      }),
      programCourse('pc-5', 'version-2', '新增课程', {
        code: 'NEW',
        credits: 1,
        sortOrder: 3,
      }),
    ],
    courseIndicatorSupports: [
      support('s-1', 'version-1', 'pc-1', 'i-1-1', 3),
      support('s-2', 'version-1', 'pc-1', 'i-1-2', 1),
      support('s-3', 'version-2', 'pc-3', 't-1-1', 4),
      support('s-4', 'version-2', 'pc-3', 't-1-3', 2),
    ],
  };
}

describe('buildProgramVersionDiff', () => {
  it('reports indicator, course and support changes with stable keys', () => {
    const report = buildProgramVersionDiff(snapshot(), 'version-1', 'version-2');
    expect(report).not.toBeNull();
    if (!report) return;

    expect(report.base).toMatchObject({
      programName: '网络空间安全',
      versionId: 'version-1',
      targetCredits: 12,
    });
    expect(report.target).toMatchObject({
      versionId: 'version-2',
      targetCredits: 15,
    });
    expect(report.version.fields.map((field) => field.field)).toEqual([
      'description',
      'targetCredits',
    ]);

    expect(report.indicators.map((item) => [item.code, item.change])).toEqual([
      ['1-1', 'changed'],
      ['1-2', 'removed'],
      ['1-3', 'added'],
    ]);
    expect(report.indicators.find((item) => item.code === '1-1')?.fields).toMatchObject([
      { field: 'targetWeight', before: 3, after: 4 },
    ]);

    expect(report.courses.map((item) => [item.title, item.change])).toEqual([
      ['新增课程', 'added'],
      ['Web安全', 'changed'],
    ]);
    const webCourse = report.courses.find((item) => item.title === 'Web安全');
    expect(webCourse?.key).toBe('id:course-1');
    expect(webCourse?.fields).toMatchObject([{ field: 'credits', before: 3, after: 4 }]);
    expect(webCourse?.supports.map((item) => [item.indicatorCode, item.change])).toEqual([
      ['1-1', 'changed'],
      ['1-2', 'removed'],
      ['1-3', 'added'],
    ]);

    expect(report.summary).toMatchObject({
      indicatorAddedCount: 1,
      indicatorRemovedCount: 1,
      indicatorChangedCount: 1,
      courseAddedCount: 1,
      courseRemovedCount: 0,
      courseChangedCount: 1,
      courseUnchangedCount: 1,
      supportAddedCount: 1,
      supportRemovedCount: 1,
      supportChangedCount: 1,
      totalChangeCount: 9,
    });
  });

  it('returns an empty diff when both sides are the same version', () => {
    const report = buildProgramVersionDiff(snapshot(), 'version-1', 'version-1');
    expect(report).not.toBeNull();
    if (!report) return;
    expect(report.summary.totalChangeCount).toBe(0);
    expect(report.indicators).toEqual([]);
    expect(report.courses).toEqual([]);
    expect(report.version.change).toBe('unchanged');
  });

  it('returns null when either version is missing', () => {
    expect(buildProgramVersionDiff(snapshot(), 'missing', 'version-2')).toBeNull();
    expect(buildProgramVersionDiff(snapshot(), 'version-1', 'missing')).toBeNull();
  });
});

describe('parseProgramVersionSyncInput', () => {
  it('requires two different version ids', () => {
    expect(
      parseProgramVersionSyncInput({
        sourceVersionId: 'version-1',
        targetVersionId: 'version-2',
      }),
    ).toEqual({
      ok: true,
      value: { sourceVersionId: 'version-1', targetVersionId: 'version-2' },
    });
    expect(
      parseProgramVersionSyncInput({
        sourceVersionId: 'version-1',
        targetVersionId: 'version-1',
      }).ok,
    ).toBe(false);
    expect(parseProgramVersionSyncInput({ sourceVersionId: 'version-1' }).ok).toBe(false);
  });
});
