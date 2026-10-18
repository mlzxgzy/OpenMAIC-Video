/**
 * 驾驶舱看板的目录叠加。
 *
 * 三条规则各有测试：空节必须出现（"先出章再出节"的中间状态）、未归类的目必须
 * 单独成组（不能编造归属）、大纲顺序决定推荐顺序（`outlineRank`）。
 */
import { describe, expect, it } from 'vitest';

import { buildSeriesBoard, type BoardRow } from '@/lib/curriculum/series-board';
import type { CurriculumSeriesOutlineNodeRecord } from '@/lib/curriculum/types';

const NOW = '2026-01-01T00:00:00.000Z';

function node(
  id: string,
  nodeType: 'chapter' | 'section',
  parentId: string | null,
  orderIndex: number,
  title = id,
  designFingerprint: string | null = null,
): CurriculumSeriesOutlineNodeRecord {
  return {
    id,
    seriesId: 'series-1',
    parentId,
    nodeType,
    code: null,
    title,
    note: null,
    orderIndex,
    designFingerprint,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function row(overrides: Partial<BoardRow> & { taskId: string }): BoardRow {
  return {
    code: null,
    title: overrides.taskId,
    phase: 'task',
    kind: null,
    produced: false,
    blockingCount: 0,
    started: false,
    sectionId: null,
    orderIndex: 1,
    designFingerprint: overrides.designFingerprint ?? null,
    ...overrides,
  };
}

describe('buildSeriesBoard', () => {
  it('把目挂到节下面，并按章序/节序/目序排出 outlineRank', () => {
    const nodes = [
      node('c2', 'chapter', null, 2),
      node('c1', 'chapter', null, 1),
      node('s12', 'section', 'c1', 2),
      node('s11', 'section', 'c1', 1),
    ];
    const rows = [
      row({ taskId: 't2', sectionId: 's12', orderIndex: 1, code: '1-2-1' }),
      row({ taskId: 't1', sectionId: 's11', orderIndex: 1, code: '1-1-1' }),
      row({ taskId: 't3', sectionId: 's11', orderIndex: 2, code: '1-1-2' }),
    ];

    const board = buildSeriesBoard(nodes, rows);
    expect(board.chapters.map((chapter) => chapter.id)).toEqual(['c1', 'c2']);
    expect(board.chapters[1]!.sections).toEqual([]);
    expect(board.chapters[0]!.sections.map((section) => section.id)).toEqual(['s11', 's12']);
    expect(board.chapters[0]!.sections[0]!.items.map((item) => item.taskId)).toEqual(['t1', 't3']);
    // 章 1 节 1 目 1 → 1*10000 + 1*100 + 1
    expect(board.chapters[0]!.sections[0]!.items[0]!.outlineRank).toBe(10101);
    expect(board.chapters[0]!.sections[0]!.items[1]!.outlineRank).toBe(10102);
  });

  it('空节保留在树上（先出章再出节的中间状态）', () => {
    const board = buildSeriesBoard(
      [node('c1', 'chapter', null, 1), node('s11', 'section', 'c1', 1)],
      [],
    );
    expect(board.chapters).toHaveLength(1);
    expect(board.chapters[0]!.sections).toHaveLength(1);
    expect(board.chapters[0]!.sections[0]!.total).toBe(0);
    expect(board.chapters[0]!.sections[0]!.items).toEqual([]);
  });

  it('没有 section 的目（老数据、删节后的目）进"未归类"，不塞进任何一章', () => {
    const board = buildSeriesBoard(
      [node('c1', 'chapter', null, 1), node('s11', 'section', 'c1', 1)],
      [row({ taskId: 'orphan', sectionId: null, code: '9-9-9' })],
    );
    expect(board.unassigned.items.map((item) => item.taskId)).toEqual(['orphan']);
    expect(board.unassigned.items[0]!.outlineRank).toBeNull();
    expect(board.chapters[0]!.sections[0]!.items).toEqual([]);
    expect(board.totals).toMatchObject({ chapters: 1, sections: 1, items: 1 });
  });

  it('sectionId 指向不存在的节时也算未归类（删节的竞态）', () => {
    const board = buildSeriesBoard(
      [node('c1', 'chapter', null, 1)],
      [row({ taskId: 'stale', sectionId: 'gone' })],
    );
    expect(board.unassigned.items.map((item) => item.taskId)).toEqual(['stale']);
  });

  it('统计已出片数，并按章、节、整体三层汇总', () => {
    const nodes = [
      node('c1', 'chapter', null, 1),
      node('s11', 'section', 'c1', 1),
      node('s12', 'section', 'c1', 2),
    ];
    const rows = [
      row({ taskId: 't1', sectionId: 's11', produced: true }),
      row({ taskId: 't2', sectionId: 's11', produced: true }),
      row({ taskId: 't3', sectionId: 's12' }),
    ];
    const board = buildSeriesBoard(nodes, rows);
    expect(board.totals).toEqual({ chapters: 1, sections: 2, items: 3, produced: 2 });
    expect(board.chapters[0]!.sections[0]).toMatchObject({ produced: 2, total: 2 });
    expect(board.chapters[0]!.sections[1]).toMatchObject({ produced: 0, total: 1 });
    expect(board.chapters[0]).toMatchObject({ produced: 2, total: 3 });
  });

  it('未归类的目按编号排序，顺序稳定', () => {
    const board = buildSeriesBoard(
      [],
      [row({ taskId: 'b', code: '2-1-1' }), row({ taskId: 'a', code: '1-1-1' })],
    );
    expect(board.unassigned.items.map((item) => item.taskId)).toEqual(['a', 'b']);
  });
});

describe('按旧版设计生成的标记', () => {
  it('生成时指纹与当前设计不同 → 标为旧版；相同或没有指纹 → 不标', () => {
    const nodes = [
      node('c1', 'chapter', null, 1, 'Web 安全', 'design-v1'),
      node('s11', 'section', 'c1', 1, '信息收集', 'design-v1'),
      node('c2', 'chapter', null, 2, '手写章', null),
    ];
    const rows = [
      row({ taskId: 'old', sectionId: 's11', designFingerprint: 'design-v1' }),
      row({ taskId: 'fresh', sectionId: 's11', designFingerprint: 'design-v2' }),
      row({ taskId: 'manual', sectionId: 's11', designFingerprint: null }),
    ];
    const board = buildSeriesBoard(nodes, rows, 'design-v2');
    const [web, manualChapter] = board.chapters;
    expect(web!.stale).toBe(true);
    expect(web!.sections[0]!.stale).toBe(true);
    // 同一节内的顺序按编号 / 标题排，所以断言里不假设插入顺序。
    const staleById = new Map(
      web!.sections[0]!.items.map((item) => [item.taskId, item.stale] as const),
    );
    expect(staleById.get('old')).toBe(true);
    expect(staleById.get('fresh')).toBe(false);
    expect(staleById.get('manual')).toBe(false);
    expect(manualChapter!.stale).toBe(false);
  });

  it('没有当前指纹（设计还没读到时）不标旧版：宁可少提示也不乱指', () => {
    const board = buildSeriesBoard(
      [node('c1', 'chapter', null, 1, 'Web 安全', 'design-v1')],
      [row({ taskId: 't1', designFingerprint: 'design-v1' })],
      null,
    );
    expect(board.chapters[0]!.stale).toBe(false);
    expect(board.unassigned.items[0]!.stale).toBe(false);
  });
});
