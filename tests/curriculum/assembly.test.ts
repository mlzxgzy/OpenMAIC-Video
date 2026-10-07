import { describe, expect, it } from 'vitest';

import { buildCourseAssembly, type CourseAssemblyInput } from '@/lib/curriculum/assembly';
import { parseCourseAssemblyInput } from '@/lib/server/curriculum/validation';
import type {
  CurriculumSnapshot,
  KnowledgePointRecord,
  KnowledgePointRelationRecord,
} from '@/lib/curriculum/types';

const NOW = '2026-01-01T00:00:00.000Z';

function point(
  id: string,
  name: string,
  overrides: Partial<KnowledgePointRecord> = {},
): KnowledgePointRecord {
  return {
    id,
    seriesId: 'series-1',
    parentId: null,
    name,
    code: null,
    type: 'knowledge',
    difficulty: 'basic',
    summary: null,
    sortOrder: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function relation(
  id: string,
  sourceKnowledgePointId: string,
  targetKnowledgePointId: string,
  relationType: KnowledgePointRelationRecord['relationType'],
): KnowledgePointRelationRecord {
  return {
    id,
    sourceKnowledgePointId,
    targetKnowledgePointId,
    relationType,
    note: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function snapshot(
  knowledgePoints: KnowledgePointRecord[],
  knowledgePointRelations: KnowledgePointRelationRecord[] = [],
): CurriculumSnapshot {
  return {
    series: [
      {
        id: 'series-1',
        name: 'CTF综合实战',
        description: null,
        courseCount: 0,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    courses: [],
    relations: [],
    knowledgePoints,
    courseKnowledgePoints: [],
    knowledgePointRelations,
  };
}

function input(
  knowledgePoints: CourseAssemblyInput['knowledgePoints'],
  overrides: Partial<CourseAssemblyInput> = {},
): CourseAssemblyInput {
  return {
    seriesId: 'series-1',
    title: 'CTF工具链',
    code: 'CTF-1-1-4',
    chapter: '第一章 CTF基础',
    section: '第二节 工具环境',
    type: 'theory',
    knowledgePoints,
    ...overrides,
  };
}

describe('buildCourseAssembly', () => {
  it('orders selected knowledge points by dependency and emits a course package', () => {
    const base = point('kp-a', 'CTF 基本概念', {
      code: 'KP-01',
      summary: '理解 CTF 的定义；识别常见赛制',
      sortOrder: 20,
    });
    const advanced = point('kp-b', '常用工具链', { code: 'KP-02', sortOrder: 10 });
    const child = point('kp-c', 'Burp Suite', {
      code: 'KP-03',
      parentId: 'kp-b',
      sortOrder: 1,
      summary: '代理、抓包与重放',
    });
    const unselected = point('kp-d', '未选知识点');

    const plan = buildCourseAssembly(
      snapshot(
        [base, advanced, child, unselected],
        [relation('rel-1', 'kp-a', 'kp-b', 'prerequisite')],
      ),
      input([
        { knowledgePointId: 'kp-b', coverageLevel: 'practiced' },
        { knowledgePointId: 'kp-c', coverageLevel: 'introduced' },
        { knowledgePointId: 'kp-a', coverageLevel: 'introduced' },
      ]),
    );

    expect(plan.knowledgePoints.map((point) => point.name)).toEqual([
      'CTF 基本概念',
      '常用工具链',
      'Burp Suite',
    ]);
    expect(plan.knowledgePoints[2]?.parentId).toBe('kp-b');
    expect(plan.knowledgePoints[1]?.childIds).toEqual(['kp-c']);
    expect(plan.slides).toHaveLength(7);
    expect(plan.slides.map((slide) => slide.title)).toContain('Burp Suite');
    expect(plan.slides.find((slide) => slide.title === '常用工具链')?.points).toEqual([
      'Burp Suite',
    ]);
    expect(plan.objectives).toHaveLength(2);
    expect(plan.hours).toBe(1);
    expect(plan.coursePackage.code).toBe('CTF-1-1-4');
    expect(plan.coursePackage.slideOutline).toHaveLength(7);
    expect(plan.coursePackage.generation.requirement).toContain('内容必须覆盖以下7页');
    expect(plan.coursePackage.generation.requirement).toContain('常用工具链');
    expect(plan.suggestedRunCommand).toContain('course-packages/assembled/CTF-1-1-4.json');
  });

  it('warns when a selected point misses a prerequisite', () => {
    const base = point('kp-a', '基础');
    const child = point('kp-b', '子知识点', { parentId: 'kp-a' });
    const plan = buildCourseAssembly(
      snapshot([base, child], [relation('rel-1', 'kp-a', 'kp-b', 'prerequisite')]),
      input([{ knowledgePointId: 'kp-b' }]),
    );

    expect(plan.knowledgePoints.map((point) => point.name)).toEqual(['子知识点']);
    expect(plan.warnings.map((warning) => warning.code)).toContain('MISSING_PREREQUISITE');
    expect(plan.warnings.map((warning) => warning.code)).not.toContain('PARENT_NOT_SELECTED');
  });

  it('skips points that do not belong to the requested series', () => {
    const visible = point('kp-a', '可见知识点');
    const foreign = point('kp-b', '其他系列知识点', { seriesId: 'series-2' });
    const plan = buildCourseAssembly(
      snapshot([visible, foreign]),
      input([{ knowledgePointId: 'kp-b' }, { knowledgePointId: 'kp-a' }]),
    );

    expect(plan.knowledgePoints.map((point) => point.name)).toEqual(['可见知识点']);
    expect(plan.warnings.map((warning) => warning.code)).toContain(
      'KNOWLEDGE_POINT_SERIES_MISMATCH',
    );
  });
});

describe('parseCourseAssemblyInput', () => {
  it('normalizes an assembly request and keeps knowledge-point coverage levels', () => {
    const parsed = parseCourseAssemblyInput({
      seriesId: ' series-1 ',
      title: ' CTF工具链 ',
      hours: 2,
      knowledgePoints: [
        { knowledgePointId: ' kp-a ', coverageLevel: 'practiced' },
        { knowledgePointId: 'kp-b' },
      ],
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.title).toBe('CTF工具链');
    expect(parsed.value.seriesId).toBe('series-1');
    expect(parsed.value.hours).toBe(2);
    expect(parsed.value.knowledgePoints).toEqual([
      { knowledgePointId: 'kp-a', coverageLevel: 'practiced' },
      { knowledgePointId: 'kp-b' },
    ]);
  });

  it('rejects an assembly with no knowledge points', () => {
    const parsed = parseCourseAssemblyInput({ title: '空课程', knowledgePoints: [] });
    expect(parsed).toEqual({
      ok: false,
      message: 'knowledgePoints must contain at least one item',
    });
  });
});
