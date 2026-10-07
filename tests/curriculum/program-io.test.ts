import { describe, expect, it } from 'vitest';

import {
  buildProgramPlanExport,
  parseProgramPlanExportDocument,
  PROGRAM_PLAN_EXPORT_KIND,
} from '@/lib/curriculum/program-io';
import type { CurriculumSnapshot } from '@/lib/curriculum/types';
import { parseProgramPlanImportInput } from '@/lib/server/curriculum/validation';

const NOW = '2026-01-01T00:00:00.000Z';

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
    programs: [
      {
        id: 'program-1',
        name: '网络空间安全',
        code: 'NIS',
        description: null,
        status: 'active',
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    programVersions: [
      {
        id: 'version-1',
        programId: 'program-1',
        name: '2026版',
        version: 'v1',
        gradeYear: '2026',
        description: null,
        status: 'active',
        targetCredits: 12,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    graduationIndicators: [
      {
        id: 'indicator-2',
        programVersionId: 'version-1',
        code: '1-2',
        title: '安全分析',
        description: null,
        targetWeight: 2,
        sortOrder: 2,
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: 'indicator-1',
        programVersionId: 'version-1',
        code: '1-1',
        title: '工程知识',
        description: null,
        targetWeight: 3,
        sortOrder: 1,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    programCourses: [
      {
        id: 'pc-1',
        programVersionId: 'version-1',
        courseId: 'course-1',
        title: 'Web安全',
        code: 'CTF-WEB',
        semester: '2026春',
        category: 'required',
        credits: 3,
        hours: 32,
        sortOrder: 1,
        note: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    courseIndicatorSupports: [
      {
        id: 'support-1',
        programVersionId: 'version-1',
        programCourseId: 'pc-1',
        indicatorId: 'indicator-2',
        weight: 2,
        note: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: 'support-2',
        programVersionId: 'version-1',
        programCourseId: 'pc-1',
        indicatorId: 'indicator-1',
        weight: 3,
        note: '核心',
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
  };
}

describe('program plan import/export', () => {
  it('builds a portable document with sorted indicators and code-keyed supports', () => {
    const document = buildProgramPlanExport(snapshot(), 'version-1', NOW);
    expect(document).not.toBeNull();
    if (!document) return;
    expect(document.kind).toBe(PROGRAM_PLAN_EXPORT_KIND);
    expect(document.program.name).toBe('网络空间安全');
    expect(document.programVersion.targetCredits).toBe(12);
    expect(document.indicators.map((item) => item.code)).toEqual(['1-1', '1-2']);
    expect(document.courses[0]).toMatchObject({
      courseId: 'course-1',
      courseCode: 'CTF-WEB',
      title: 'Web安全',
    });
    expect(document.courses[0]?.supports.map((item) => item.indicatorCode)).toEqual(['1-1', '1-2']);
    expect(document.meta).toEqual({ indicatorCount: 2, courseCount: 1, supportCount: 2 });

    const parsed = parseProgramPlanExportDocument(document);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.courses[0]?.supports).toHaveLength(2);
  });

  it('refuses malformed documents before they reach the store', () => {
    const document = buildProgramPlanExport(snapshot(), 'version-1', NOW);
    if (!document) throw new Error('missing fixture');
    expect(parseProgramPlanExportDocument({ ...document, kind: 'other' }).ok).toBe(false);
    expect(
      parseProgramPlanExportDocument({
        ...document,
        indicators: [document.indicators[0], document.indicators[0]],
      }).ok,
    ).toBe(false);
    expect(
      parseProgramPlanExportDocument({
        ...document,
        courses: [
          {
            ...document.courses[0],
            supports: [{ indicatorCode: 'missing', weight: 1, note: null }],
          },
        ],
      }).ok,
    ).toBe(false);
  });

  it('validates the import wrapper mode and target', () => {
    const document = buildProgramPlanExport(snapshot(), 'version-1', NOW);
    if (!document) throw new Error('missing fixture');
    expect(parseProgramPlanImportInput({ document, mode: 'create' }).ok).toBe(true);
    expect(parseProgramPlanImportInput({ document, mode: 'replace' }).ok).toBe(false);
    expect(
      parseProgramPlanImportInput({
        document,
        mode: 'replace',
        programVersionId: 'version-1',
      }).ok,
    ).toBe(true);
    expect(
      parseProgramPlanImportInput({
        document,
        mode: 'create',
        programVersionId: 'version-1',
      }).ok,
    ).toBe(false);
  });
});
